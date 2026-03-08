/**
 * A.L.A.N. Process Manager Skill
 *
 * Manage long-running processes (dev servers, watchers, background jobs):
 *   - Start processes and track them by name
 *   - Stream output to memory (last N lines)
 *   - Stop / restart named processes
 *   - List all running processes and their status
 *   - Survive agent restarts (process map lives in memory, not disk)
 *
 * All start operations are DESTRUCTIVE tier (server spawning).
 */

import { spawn, type ChildProcess } from "child_process";
import { resolve, join } from "path";
import { homedir } from "os";
import type { Skill, GeminiTool } from "./skill-system.js";
import { WORKSPACE_ROOT } from "./filesystem-skill.js";

interface ManagedProcess {
	name: string;
	command: string;
	cwd: string;
	pid: number;
	startedAt: number;
	status: "running" | "stopped" | "crashed";
	stdout: string[]; // ring buffer, last 200 lines
	stderr: string[];
	exitCode?: number;
	process: ChildProcess;
}

const LINE_BUFFER = 200;
const managedProcesses = new Map<string, ManagedProcess>();

export const processSkill: Skill = {
	manifest: {
		id: "process",
		name: "Process Manager",
		version: "1.0.0",
		description:
			"Start, stop and monitor long-running processes (dev servers, watchers, background jobs)",
		author: "ALAN Core",
		permissions: [
			{
				type: "shell",
				scope: "controlled",
				description: "Spawn and manage background processes",
			},
		],
		secrets: [],
		actions: [
			{
				id: "start",
				name: "Start Process",
				description:
					"Start a long-running process (dev server, watcher) with a name for tracking",
				tier: "DESTRUCTIVE",
				params: {
					name: {
						type: "string",
						description:
							'Unique name for this process (e.g. "dev-server", "watcher")',
						required: true,
					},
					command: {
						type: "string",
						description: "Command to run",
						required: true,
					},
					cwd: {
						type: "string",
						description: "Working directory (default: workspace root)",
						required: false,
					},
				},
			},
			{
				id: "stop",
				name: "Stop Process",
				description: "Stop a named managed process",
				tier: "DESTRUCTIVE",
				params: {
					name: {
						type: "string",
						description: "Process name to stop",
						required: true,
					},
				},
			},
			{
				id: "restart",
				name: "Restart Process",
				description: "Stop and restart a named process",
				tier: "DESTRUCTIVE",
				params: {
					name: {
						type: "string",
						description: "Process name to restart",
						required: true,
					},
				},
			},
			{
				id: "list",
				name: "List Processes",
				description: "List all managed processes and their status",
				tier: "READ",
				params: {},
			},
			{
				id: "logs",
				name: "Get Process Logs",
				description: "Get recent stdout/stderr output from a named process",
				tier: "READ",
				params: {
					name: { type: "string", description: "Process name", required: true },
					lines: {
						type: "number",
						description: "Number of lines to return (default 50)",
						required: false,
					},
				},
			},
		],
	},

	getTools(): GeminiTool[] {
		return this.manifest.actions.map((a) => ({
			name: `process__${a.id}`,
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
		if (actionId === "start") {
			const name = params.name as string;
			const command = params.command as string;
			const cwdRaw = (params.cwd as string) ?? WORKSPACE_ROOT;
			const cwd = resolve(
				cwdRaw.startsWith("~") ? cwdRaw.replace("~", homedir()) : cwdRaw,
			);

			// Stop existing process with same name if running
			if (managedProcesses.has(name)) {
				await this.execute("stop", { name });
			}

			const child = spawn("bash", ["-c", command], {
				cwd,
				detached: false,
				env: { ...process.env, HOME: homedir() },
			});

			if (!child.pid) return { error: "Failed to spawn process" };

			const managed: ManagedProcess = {
				name,
				command,
				cwd,
				pid: child.pid,
				startedAt: Date.now(),
				status: "running",
				stdout: [],
				stderr: [],
				process: child,
			};

			child.stdout?.on("data", (data: Buffer) => {
				const lines = data.toString().split("\n").filter(Boolean);
				managed.stdout.push(...lines);
				if (managed.stdout.length > LINE_BUFFER)
					managed.stdout = managed.stdout.slice(-LINE_BUFFER);
			});

			child.stderr?.on("data", (data: Buffer) => {
				const lines = data.toString().split("\n").filter(Boolean);
				managed.stderr.push(...lines);
				if (managed.stderr.length > LINE_BUFFER)
					managed.stderr = managed.stderr.slice(-LINE_BUFFER);
			});

			child.on("exit", (code) => {
				managed.status = code === 0 ? "stopped" : "crashed";
				managed.exitCode = code ?? -1;
			});

			managedProcesses.set(name, managed);

			return {
				started: true,
				name,
				pid: child.pid,
				command,
				cwd,
				tip: `Use process__logs with name "${name}" to see output`,
			};
		}

		if (actionId === "stop") {
			const name = params.name as string;
			const managed = managedProcesses.get(name);
			if (!managed) return { error: `No process named "${name}"` };
			try {
				managed.process.kill("SIGTERM");
				setTimeout(() => {
					if (managed.status === "running") managed.process.kill("SIGKILL");
				}, 3000);
			} catch {
				/* already dead */
			}
			managed.status = "stopped";
			managedProcesses.delete(name);
			return { stopped: true, name, pid: managed.pid };
		}

		if (actionId === "restart") {
			const name = params.name as string;
			const managed = managedProcesses.get(name);
			if (!managed) return { error: `No process named "${name}"` };
			const { command, cwd } = managed;
			await this.execute("stop", { name });
			return await this.execute("start", { name, command, cwd });
		}

		if (actionId === "list") {
			const list = Array.from(managedProcesses.values()).map((p) => ({
				name: p.name,
				pid: p.pid,
				status: p.status,
				command: p.command,
				cwd: p.cwd,
				uptime_seconds: Math.floor((Date.now() - p.startedAt) / 1000),
				stdout_lines: p.stdout.length,
				stderr_lines: p.stderr.length,
				exit_code: p.exitCode,
			}));
			return { processes: list, count: list.length };
		}

		if (actionId === "logs") {
			const name = params.name as string;
			const lines = (params.lines as number) ?? 50;
			const managed = managedProcesses.get(name);
			if (!managed) return { error: `No process named "${name}"` };
			return {
				name,
				pid: managed.pid,
				status: managed.status,
				stdout: managed.stdout.slice(-lines),
				stderr: managed.stderr.slice(-lines),
			};
		}

		return { error: `Unknown action: ${actionId}` };
	},
};
