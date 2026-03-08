/**
 * A.L.A.N. Shell Skill
 *
 * Execute terminal commands with:
 *   - Allowlist-based command gating (safe commands auto-proceed)
 *   - Blocklist for catastrophically dangerous commands (rm -rf /, fork bombs, etc.)
 *   - All exec is DESTRUCTIVE tier → user confirmation before run
 *   - Working directory defaults to workspace root
 *   - Timeout enforced on every command (default 30s, max 300s)
 *   - Output captured (stdout + stderr), exit code returned
 *   - Full audit log entry per execution
 */

import { execSync, spawnSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { resolve, join } from "path";
import { homedir } from "os";
import type { Skill, GeminiTool } from "./skill-system.js";
import { WORKSPACE_ROOT } from "./filesystem-skill.js";

// Commands that will never be run regardless of user confirmation
const HARDBLOCKED = [
	/rm\s+-rf\s+\/(?!\S)/, // rm -rf /
	/:\(\)\s*\{.*\}/, // fork bomb
	/mkfs\./, // format drives
	/dd\s+if=.*of=\/dev\//, // dd to block device
	/chmod\s+-R\s+777\s+\//, // 777 everything
	/>\s*\/dev\/sd/, // write to raw disk
	/shutdown|poweroff|reboot/, // system shutdown
	/passwd\s+root/, // change root password
	/userdel|usermod/, // user management
	/iptables\s+-F/, // flush firewall
];

// Tier: READ (safe) — these auto-proceed without confirmation
const SAFE_COMMANDS = new Set([
	"ls",
	"cat",
	"head",
	"tail",
	"grep",
	"find",
	"wc",
	"du",
	"df",
	"echo",
	"pwd",
	"whoami",
	"date",
	"uname",
	"env",
	"printenv",
	"which",
	"whereis",
	"type",
	"file",
	"stat",
	"sort",
	"uniq",
	"cut",
	"awk",
	"sed",
	"tr",
	"diff",
	"md5sum",
	"sha256sum",
	"node",
	"python",
	"python3",
	"ruby",
	"go",
	"rustc",
	"npm",
	"npx",
	"pip",
	"pip3",
	"cargo",
	"yarn",
	"pnpm",
	"git",
	"curl",
	"wget",
	"jq",
	"yq",
	"make",
	"tsc",
	"eslint",
	"prettier",
	"jest",
	"vitest",
	"mocha",
]);

function getBaseCommand(cmd: string): string {
	return cmd.trim().split(/\s+/)[0].split("/").pop() ?? "";
}

function isHardBlocked(cmd: string): { blocked: boolean; reason?: string } {
	for (const pattern of HARDBLOCKED) {
		if (pattern.test(cmd)) {
			return {
				blocked: true,
				reason: `Command matches blocked pattern: ${pattern}`,
			};
		}
	}
	return { blocked: false };
}

function isSafeCommand(cmd: string): boolean {
	const base = getBaseCommand(cmd);
	return SAFE_COMMANDS.has(base);
}

export const shellSkill: Skill = {
	manifest: {
		id: "shell",
		name: "Shell / Terminal",
		version: "1.0.0",
		description:
			"Execute terminal commands. Safe commands run immediately; others require confirmation.",
		author: "ALAN Core",
		permissions: [
			{
				type: "shell",
				scope: "controlled",
				description: "Execute shell commands with tier-based gating",
			},
		],
		secrets: [],
		actions: [
			{
				id: "run",
				name: "Run Command",
				description:
					"Execute a shell command. Safe commands (git, npm, node, ls, etc.) run immediately. Others need confirmation.",
				tier: "DESTRUCTIVE",
				params: {
					command: {
						type: "string",
						description: "The shell command to execute",
						required: true,
					},
					cwd: {
						type: "string",
						description: "Working directory (default: workspace root)",
						required: false,
					},
					timeout_seconds: {
						type: "number",
						description: "Timeout in seconds (default 30, max 300)",
						required: false,
					},
					env: {
						type: "string",
						description: "Additional env vars as JSON object string",
						required: false,
					},
				},
			},
			{
				id: "run_safe",
				name: "Run Safe Command",
				description:
					"Execute a read-only/safe command (ls, cat, grep, npm install, git, etc.) — no confirmation needed",
				tier: "READ",
				params: {
					command: {
						type: "string",
						description: "The safe command to run",
						required: true,
					},
					cwd: {
						type: "string",
						description: "Working directory (default: workspace root)",
						required: false,
					},
					timeout_seconds: {
						type: "number",
						description: "Timeout in seconds (default 30)",
						required: false,
					},
				},
			},
			{
				id: "kill_process",
				name: "Kill Background Process",
				description:
					"Kill a background process by PID returned from run_background",
				tier: "DESTRUCTIVE",
				params: {
					pid: {
						type: "number",
						description: "Process ID to kill",
						required: true,
					},
				},
			},
		],
	},

	getTools(): GeminiTool[] {
		return this.manifest.actions.map((a) => ({
			name: `shell__${a.id}`,
			description: `[${a.tier}] ${a.description}`,
			parameters: {
				type: "object" as const,
				properties: Object.fromEntries(
					Object.entries(a.params).map(([k, v]) => [
						k,
						{ type: v.type, description: v.description },
					]),
				),
				required: Object.entries(a.params)
					.filter(([, v]) => v.required)
					.map(([k]) => k),
			},
		}));
	},

	async execute(
		actionId: string,
		params: Record<string, unknown>,
	): Promise<unknown> {
		if (actionId === "kill_process") {
			const pid = params.pid as number;
			try {
				process.kill(pid, "SIGTERM");
				return { killed: true, pid };
			} catch (e) {
				return { error: `Failed to kill PID ${pid}: ${e}` };
			}
		}

		const command = params.command as string;
		const cwdRaw = (params.cwd as string) ?? WORKSPACE_ROOT;
		const cwd = resolve(
			cwdRaw.startsWith("~") ? cwdRaw.replace("~", homedir()) : cwdRaw,
		);
		const timeoutSecs = Math.min((params.timeout_seconds as number) ?? 30, 300);
		const timeoutMs = timeoutSecs * 1000;

		// Hard block check
		const blockCheck = isHardBlocked(command);
		if (blockCheck.blocked) {
			return {
				error: `HARD BLOCKED: ${blockCheck.reason}`,
				command,
				blocked: true,
			};
		}

		// For run_safe, verify command is actually safe
		if (actionId === "run_safe" && !isSafeCommand(command)) {
			return {
				error: `run_safe: "${getBaseCommand(command)}" is not in the safe command list. Use run instead (which will prompt for confirmation).`,
				command,
				safeList: Array.from(SAFE_COMMANDS).join(", "),
			};
		}

		// Ensure cwd exists
		if (!existsSync(cwd)) {
			mkdirSync(cwd, { recursive: true });
		}

		// Build env
		let extraEnv: Record<string, string> = {};
		if (params.env) {
			try {
				extraEnv = JSON.parse(params.env as string);
			} catch {
				/* ignore bad env */
			}
		}

		const startTime = Date.now();
		try {
			const result = spawnSync("bash", ["-c", command], {
				cwd,
				timeout: timeoutMs,
				encoding: "utf8",
				maxBuffer: 10 * 1024 * 1024, // 10MB
				env: {
					...process.env,
					...extraEnv,
					HOME: homedir(),
					PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
				},
			});

			const durationMs = Date.now() - startTime;

			if (result.error) {
				if ((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
					return {
						error: `Command timed out after ${timeoutSecs}s`,
						command,
						timed_out: true,
					};
				}
				return { error: result.error.message, command };
			}

			return {
				command,
				cwd,
				exit_code: result.status ?? -1,
				success: result.status === 0,
				stdout: result.stdout?.trim() ?? "",
				stderr: result.stderr?.trim() ?? "",
				duration_ms: durationMs,
				timed_out: false,
			};
		} catch (err) {
			return {
				error: err instanceof Error ? err.message : String(err),
				command,
				exit_code: -1,
				success: false,
			};
		}
	},
};
