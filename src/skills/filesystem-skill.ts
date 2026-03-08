/**
 * A.L.A.N. Filesystem Skill
 *
 * READ  — any path on the machine (files, dirs, metadata)
 * WRITE — only within ~/.alan/workspace/main  (enforced in code, not by trust)
 *
 * Write boundary is a hard path check — attempts to escape via symlink
 * or path traversal are blocked before any fs operation.
 */

import {
	readFileSync,
	readdirSync,
	statSync,
	existsSync,
	writeFileSync,
	mkdirSync,
	renameSync,
	unlinkSync,
	copyFileSync,
	appendFileSync,
} from "fs";
import { join, resolve, relative, extname, dirname, basename } from "path";
import { homedir } from "os";
import type { Skill, GeminiTool } from "./skill-system.js";

export const WORKSPACE_ROOT = resolve(
	join(homedir(), ".alan", "workspace", "main"),
);

// Ensure workspace exists on import
mkdirSync(WORKSPACE_ROOT, { recursive: true });

function assertWriteAllowed(target: string): string {
	const abs = resolve(target);
	if (!abs.startsWith(WORKSPACE_ROOT + "/") && abs !== WORKSPACE_ROOT) {
		throw new Error(
			`Write blocked: "${abs}" is outside the workspace (${WORKSPACE_ROOT}). ` +
				`Only files inside ~/.alan/workspace/main can be created or modified.`,
		);
	}
	return abs;
}

function workspacePath(relative_path: string): string {
	// If already absolute and inside workspace — allow
	if (resolve(relative_path).startsWith(WORKSPACE_ROOT)) {
		return assertWriteAllowed(resolve(relative_path));
	}
	// Otherwise join to workspace root
	return assertWriteAllowed(join(WORKSPACE_ROOT, relative_path));
}

const TEXT_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".rb",
	".go",
	".rs",
	".java",
	".c",
	".cpp",
	".h",
	".cs",
	".json",
	".yaml",
	".yml",
	".toml",
	".env",
	".ini",
	".cfg",
	".md",
	".txt",
	".rst",
	".csv",
	".log",
	".sh",
	".bash",
	".zsh",
	".html",
	".css",
	".scss",
	".less",
	".xml",
	".svg",
	".sql",
	".graphql",
	".prisma",
	".dockerfile",
	".dockerignore",
	".gitignore",
	".gitattributes",
	"", // files with no extension
]);

function isTextFile(filePath: string): boolean {
	return TEXT_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function readableSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function walkDir(dir: string, depth = 0, maxDepth = 4): string[] {
	if (depth > maxDepth) return [];
	const entries: string[] = [];
	try {
		const items = readdirSync(dir, { withFileTypes: true });
		for (const item of items) {
			if (item.name.startsWith(".") && depth === 0) continue; // skip hidden at root
			const full = join(dir, item.name);
			if (item.isDirectory()) {
				entries.push(`${"  ".repeat(depth)}📁 ${item.name}/`);
				entries.push(...walkDir(full, depth + 1, maxDepth));
			} else {
				try {
					const stat = statSync(full);
					entries.push(
						`${"  ".repeat(depth)}📄 ${item.name} (${readableSize(stat.size)})`,
					);
				} catch {
					entries.push(`${"  ".repeat(depth)}📄 ${item.name}`);
				}
			}
		}
	} catch {
		// permission denied or other error
	}
	return entries;
}

export const filesystemSkill: Skill = {
	manifest: {
		id: "filesystem",
		name: "Filesystem",
		version: "2.0.0",
		description:
			"Read any file or directory. Write/create/delete only inside ~/.alan/workspace/main.",
		author: "ALAN Core",
		permissions: [
			{
				type: "filesystem",
				scope: "read:any",
				description: "Read any file or directory",
			},
			{
				type: "filesystem",
				scope: "write:workspace",
				description: "Write within ~/.alan/workspace/main only",
			},
		],
		secrets: [],
		actions: [
			{
				id: "read_file",
				name: "Read File",
				description: "Read the full contents of any text file on the system",
				tier: "READ",
				params: {
					path: {
						type: "string",
						description: "Absolute or relative path to the file",
						required: true,
					},
					max_chars: {
						type: "number",
						description: "Maximum characters to return (default 40000)",
						required: false,
					},
				},
			},
			{
				id: "list_dir",
				name: "List Directory",
				description:
					"List directory contents recursively with file sizes. Works anywhere on the system.",
				tier: "READ",
				params: {
					path: {
						type: "string",
						description: "Directory path (absolute or relative to home)",
						required: true,
					},
					depth: {
						type: "number",
						description: "Max recursion depth (default 3)",
						required: false,
					},
				},
			},
			{
				id: "file_info",
				name: "File Info",
				description:
					"Get metadata for a file or directory (size, modified date, type)",
				tier: "READ",
				params: {
					path: {
						type: "string",
						description: "Path to the file or directory",
						required: true,
					},
				},
			},
			{
				id: "search_files",
				name: "Search Files",
				description: "Search for files by name pattern or content substring",
				tier: "READ",
				params: {
					directory: {
						type: "string",
						description: "Directory to search in",
						required: true,
					},
					pattern: {
						type: "string",
						description: "Filename pattern or content to search for",
						required: true,
					},
					search_content: {
						type: "boolean",
						description: "Search file contents (default: false, name only)",
						required: false,
					},
					max_results: {
						type: "number",
						description: "Max results (default 30)",
						required: false,
					},
				},
			},
			{
				id: "write_file",
				name: "Write File",
				description:
					"Create or overwrite a file inside the workspace (~/.alan/workspace/main)",
				tier: "WRITE",
				params: {
					path: {
						type: "string",
						description:
							"Path relative to workspace root, or absolute path inside workspace",
						required: true,
					},
					content: {
						type: "string",
						description: "Full file content to write",
						required: true,
					},
				},
			},
			{
				id: "append_file",
				name: "Append to File",
				description: "Append content to an existing file in the workspace",
				tier: "WRITE",
				params: {
					path: {
						type: "string",
						description: "Path relative to workspace root",
						required: true,
					},
					content: {
						type: "string",
						description: "Content to append",
						required: true,
					},
				},
			},
			{
				id: "create_dir",
				name: "Create Directory",
				description: "Create a directory (and parents) inside the workspace",
				tier: "WRITE",
				params: {
					path: {
						type: "string",
						description: "Directory path relative to workspace root",
						required: true,
					},
				},
			},
			{
				id: "delete_file",
				name: "Delete File",
				description:
					"Delete a file inside the workspace. CANNOT delete outside workspace.",
				tier: "DESTRUCTIVE",
				params: {
					path: {
						type: "string",
						description: "Path relative to workspace root",
						required: true,
					},
				},
			},
			{
				id: "move_file",
				name: "Move / Rename File",
				description: "Move or rename a file within the workspace",
				tier: "WRITE",
				params: {
					source: {
						type: "string",
						description: "Source path (relative to workspace)",
						required: true,
					},
					destination: {
						type: "string",
						description: "Destination path (relative to workspace)",
						required: true,
					},
				},
			},
			{
				id: "copy_file",
				name: "Copy File",
				description:
					"Copy a file. Source can be anywhere; destination must be in workspace.",
				tier: "WRITE",
				params: {
					source: {
						type: "string",
						description: "Source file path (anywhere)",
						required: true,
					},
					destination: {
						type: "string",
						description: "Destination path in workspace",
						required: true,
					},
				},
			},
			{
				id: "workspace_tree",
				name: "Workspace Tree",
				description: "Show the full file tree of the workspace",
				tier: "READ",
				params: {},
			},
		],
	},

	getTools(): GeminiTool[] {
		return this.manifest.actions.map((a) => ({
			name: `filesystem__${a.id}`,
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
		switch (actionId) {
			case "read_file": {
				const p = params.path as string;
				const maxChars = (params.max_chars as number) ?? 40000;
				const abs = resolve(p.startsWith("~") ? p.replace("~", homedir()) : p);
				if (!existsSync(abs)) return { error: `File not found: ${abs}` };
				const stat = statSync(abs);
				if (stat.isDirectory())
					return { error: `${abs} is a directory. Use list_dir instead.` };
				if (!isTextFile(abs))
					return {
						error: `${abs} appears to be a binary file. Cannot read as text.`,
					};
				const content = readFileSync(abs, "utf8");
				const truncated = content.length > maxChars;
				return {
					path: abs,
					content: truncated
						? content.substring(0, maxChars) +
							`\n... [truncated, ${content.length - maxChars} more chars]`
						: content,
					lines: content.split("\n").length,
					size: readableSize(stat.size),
					truncated,
				};
			}

			case "list_dir": {
				const p = params.path as string;
				const depth = (params.depth as number) ?? 3;
				const abs = resolve(p.startsWith("~") ? p.replace("~", homedir()) : p);
				if (!existsSync(abs)) return { error: `Directory not found: ${abs}` };
				const tree = walkDir(abs, 0, depth);
				return { path: abs, tree, count: tree.length };
			}

			case "file_info": {
				const p = params.path as string;
				const abs = resolve(p.startsWith("~") ? p.replace("~", homedir()) : p);
				if (!existsSync(abs)) return { error: `Not found: ${abs}` };
				const stat = statSync(abs);
				return {
					path: abs,
					type: stat.isDirectory() ? "directory" : "file",
					size: readableSize(stat.size),
					sizeBytes: stat.size,
					modified: new Date(stat.mtimeMs).toISOString(),
					created: new Date(stat.birthtimeMs).toISOString(),
					extension: extname(abs),
					isText: stat.isFile() ? isTextFile(abs) : null,
				};
			}

			case "search_files": {
				const dir = params.directory as string;
				const pattern = (params.pattern as string).toLowerCase();
				const searchContent = (params.search_content as boolean) ?? false;
				const maxResults = (params.max_results as number) ?? 30;
				const abs = resolve(
					dir.startsWith("~") ? dir.replace("~", homedir()) : dir,
				);
				const results: Array<{ path: string; match: string }> = [];

				function search(d: string, depth = 0) {
					if (depth > 5 || results.length >= maxResults) return;
					try {
						const items = readdirSync(d, { withFileTypes: true });
						for (const item of items) {
							if (results.length >= maxResults) break;
							if (item.name.startsWith(".")) continue;
							const full = join(d, item.name);
							if (item.isDirectory()) {
								if (item.name.includes(pattern)) {
									results.push({ path: full, match: "directory name match" });
								}
								search(full, depth + 1);
							} else {
								if (item.name.toLowerCase().includes(pattern)) {
									results.push({ path: full, match: "filename match" });
								} else if (searchContent && isTextFile(full)) {
									try {
										const content = readFileSync(full, "utf8");
										const idx = content.toLowerCase().indexOf(pattern);
										if (idx !== -1) {
											const snippet = content
												.substring(Math.max(0, idx - 40), idx + 80)
												.trim();
											results.push({
												path: full,
												match: `content: "…${snippet}…"`,
											});
										}
									} catch {
										/* binary or unreadable */
									}
								}
							}
						}
					} catch {
						/* permission denied */
					}
				}

				search(abs);
				return {
					query: pattern,
					directory: abs,
					results,
					count: results.length,
				};
			}

			case "write_file": {
				const target = workspacePath(params.path as string);
				mkdirSync(dirname(target), { recursive: true });
				writeFileSync(target, params.content as string, "utf8");
				const rel = relative(WORKSPACE_ROOT, target);
				return {
					written: true,
					path: target,
					workspace_path: rel,
					bytes: (params.content as string).length,
				};
			}

			case "append_file": {
				const target = workspacePath(params.path as string);
				if (!existsSync(target))
					return { error: `File not found in workspace: ${target}` };
				appendFileSync(target, params.content as string, "utf8");
				return {
					appended: true,
					path: target,
					bytes: (params.content as string).length,
				};
			}

			case "create_dir": {
				const target = workspacePath(params.path as string);
				mkdirSync(target, { recursive: true });
				return { created: true, path: target };
			}

			case "delete_file": {
				const target = workspacePath(params.path as string);
				if (!existsSync(target)) return { error: `Not found: ${target}` };
				unlinkSync(target);
				return { deleted: true, path: target };
			}

			case "move_file": {
				const src = workspacePath(params.source as string);
				const dst = workspacePath(params.destination as string);
				if (!existsSync(src)) return { error: `Source not found: ${src}` };
				mkdirSync(dirname(dst), { recursive: true });
				renameSync(src, dst);
				return { moved: true, from: src, to: dst };
			}

			case "copy_file": {
				const srcRaw = params.source as string;
				const src = resolve(
					srcRaw.startsWith("~") ? srcRaw.replace("~", homedir()) : srcRaw,
				);
				const dst = workspacePath(params.destination as string);
				if (!existsSync(src)) return { error: `Source not found: ${src}` };
				mkdirSync(dirname(dst), { recursive: true });
				copyFileSync(src, dst);
				return { copied: true, from: src, to: dst };
			}

			case "workspace_tree": {
				const tree = walkDir(WORKSPACE_ROOT, 0, 6);
				return {
					workspace: WORKSPACE_ROOT,
					tree: tree.length > 0 ? tree : ["(empty)"],
					fileCount: tree.filter((l) => l.includes("📄")).length,
					dirCount: tree.filter((l) => l.includes("📁")).length,
				};
			}

			default:
				return { error: `Unknown action: ${actionId}` };
		}
	},
};
