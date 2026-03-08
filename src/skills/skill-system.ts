/**
 * A.L.A.N. Skill System
 * Each skill declares its permissions upfront in a manifest.
 * Skills are sandboxed: they can only access secrets scoped to them.
 * No skill can access another skill's secrets.
 */

import { ActionTier } from "../tasks/task-engine.js";

export interface SkillPermission {
	type:
		| "filesystem"
		| "network"
		| "shell"
		| "email"
		| "calendar"
		| "memory_read"
		| "memory_write";
	scope?: string; // e.g. 'readonly', specific path, domain
	description: string;
}

export interface SkillSecret {
	name: string; // e.g. 'gmail.oauth_token'
	description: string;
	required: boolean;
}

export interface SkillAction {
	id: string;
	name: string;
	description: string;
	tier: ActionTier; // READ | WRITE | DESTRUCTIVE
	params: Record<
		string,
		{ type: string; description: string; required: boolean }
	>;
}

export interface SkillManifest {
	id: string;
	name: string;
	version: string;
	description: string;
	author: string;
	permissions: SkillPermission[];
	secrets: SkillSecret[];
	actions: SkillAction[];
}

export interface Skill {
	manifest: SkillManifest;
	// The skill's tool definitions for Gemini function calling
	getTools(): GeminiTool[];
	// Execute a specific action
	execute(actionId: string, params: Record<string, unknown>): Promise<unknown>;
}

export interface GeminiTool {
	name: string;
	description: string;
	parameters: {
		type: "object";
		properties: Record<string, { type: string; description: string }>;
		required: string[];
	};
}

// ─── Skill Registry ──────────────────────────────────────────────────────────

class SkillRegistry {
	private skills = new Map<string, Skill>();

	register(skill: Skill): void {
		const { id, name } = skill.manifest;
		if (this.skills.has(id)) {
			throw new Error(`Skill '${id}' is already registered`);
		}
		this.skills.set(id, skill);
		console.log(`[Skills] Registered: ${name} (${id})`);
	}

	get(id: string): Skill | undefined {
		return this.skills.get(id);
	}

	getAll(): Skill[] {
		return Array.from(this.skills.values());
	}

	getAllTools(): GeminiTool[] {
		return this.getAll().flatMap((s) => s.getTools());
	}

	getManifests(): SkillManifest[] {
		return this.getAll().map((s) => s.manifest);
	}

	async execute(
		skillId: string,
		actionId: string,
		params: Record<string, unknown>,
	): Promise<unknown> {
		const skill = this.skills.get(skillId);
		if (!skill) throw new Error(`Skill '${skillId}' not found`);
		return skill.execute(actionId, params);
	}
}

export const skillRegistry = new SkillRegistry();

// ─── Built-in Skills ─────────────────────────────────────────────────────────

import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, extname, basename } from "path";
import { homedir } from "os";
import { memoryEngine } from "../memory/memory-engine.js";

// File Search Skill
export const fileSearchSkill: Skill = {
	manifest: {
		id: "file-search",
		name: "File Search & Summarization",
		version: "1.0.0",
		description: "Search and read files on the local filesystem",
		author: "ALAN Core",
		permissions: [
			{
				type: "filesystem",
				scope: "readonly",
				description: "Read files and directories",
			},
		],
		secrets: [],
		actions: [
			{
				id: "search_files",
				name: "Search Files",
				description: "Search for files by name or content",
				tier: "READ",
				params: {
					query: {
						type: "string",
						description: "Search query",
						required: true,
					},
					directory: {
						type: "string",
						description: "Directory to search (defaults to home)",
						required: false,
					},
				},
			},
			{
				id: "read_file",
				name: "Read File",
				description: "Read the contents of a file",
				tier: "READ",
				params: {
					path: {
						type: "string",
						description: "Path to the file",
						required: true,
					},
				},
			},
		],
	},

	getTools() {
		return this.manifest.actions.map((a) => ({
			name: `${this.manifest.id}__${a.id}`,
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

	async execute(actionId, params) {
		if (actionId === "search_files") {
			const dir = (params.directory as string) ?? homedir();
			const query = (params.query as string).toLowerCase();

			if (!existsSync(dir)) return { error: `Directory not found: ${dir}` };

			const results: string[] = [];
			const walk = (d: string, depth = 0) => {
				if (depth > 3) return;
				try {
					const entries = readdirSync(d);
					for (const entry of entries) {
						if (entry.startsWith(".")) continue;
						const full = join(d, entry);
						try {
							const stat = statSync(full);
							if (stat.isDirectory()) walk(full, depth + 1);
							else if (entry.toLowerCase().includes(query)) results.push(full);
						} catch {
							/* skip permission errors */
						}
					}
				} catch {
					/* skip inaccessible dirs */
				}
			};

			walk(dir);
			return { files: results.slice(0, 50), total: results.length };
		}

		if (actionId === "read_file") {
			const filePath = params.path as string;
			if (!existsSync(filePath))
				return { error: `File not found: ${filePath}` };

			const ext = extname(filePath).toLowerCase();
			const textExts = [
				".txt",
				".md",
				".json",
				".yaml",
				".yml",
				".csv",
				".html",
				".js",
				".ts",
				".py",
				".sh",
				".log",
			];

			if (!textExts.includes(ext))
				return { error: `Cannot read binary file: ${basename(filePath)}` };

			const content = readFileSync(filePath, "utf-8");
			return {
				path: filePath,
				content:
					content.length > 10000
						? content.substring(0, 10000) + "\n... (truncated)"
						: content,
				size: content.length,
			};
		}

		throw new Error(`Unknown action: ${actionId}`);
	},
};

// Web Search Skill (using DuckDuckGo instant answers - no API key needed)
export const webSearchSkill: Skill = {
	manifest: {
		id: "web-search",
		name: "Web Search",
		version: "1.0.0",
		description: "Search the web and summarize results",
		author: "ALAN Core",
		permissions: [
			{
				type: "network",
				scope: "api.duckduckgo.com",
				description: "Web search via DuckDuckGo",
			},
		],
		secrets: [],
		actions: [
			{
				id: "search",
				name: "Web Search",
				description: "Search the web for current information",
				tier: "READ",
				params: {
					query: {
						type: "string",
						description: "Search query",
						required: true,
					},
				},
			},
		],
	},

	getTools() {
		return [
			{
				name: "web-search__search",
				description: "[READ] Search the web for current information",
				parameters: {
					type: "object" as const,
					properties: {
						query: { type: "string", description: "Search query" },
					},
					required: ["query"],
				},
			},
		];
	},

	async execute(actionId, params) {
		if (actionId === "search") {
			const query = encodeURIComponent(params.query as string);
			const response = await fetch(
				`https://api.duckduckgo.com/?q=${query}&format=json&no_html=1`,
			);
			const data = (await response.json()) as Record<string, unknown>;

			return {
				abstract: data.Abstract || "",
				abstractSource: data.AbstractSource || "",
				relatedTopics: (
					(data.RelatedTopics as Array<{ Text?: string; FirstURL?: string }>) ??
					[]
				)
					.slice(0, 5)
					.map((t) => ({ text: t.Text || "", url: t.FirstURL || "" })),
			};
		}
		throw new Error(`Unknown action: ${actionId}`);
	},
};

// Memory Skill
export const memorySkill: Skill = {
	manifest: {
		id: "memory",
		name: "Memory Manager",
		version: "1.0.0",
		description:
			"Store and retrieve memories about the user and their preferences",
		author: "ALAN Core",
		permissions: [
			{ type: "memory_read", description: "Read stored memories" },
			{ type: "memory_write", description: "Store new memories" },
		],
		secrets: [],
		actions: [
			{
				id: "remember",
				name: "Remember",
				description: "Store a memory about the user or a fact",
				tier: "WRITE",
				params: {
					content: {
						type: "string",
						description: "Full memory content",
						required: true,
					},
					summary: {
						type: "string",
						description: "Brief summary (1 sentence)",
						required: true,
					},
					tags: {
						type: "string",
						description:
							"Comma-separated tags (work,personal,project,preference,fact)",
						required: true,
					},
					importance: {
						type: "number",
						description: "Importance 1-5",
						required: false,
					},
				},
			},
			{
				id: "recall",
				name: "Recall",
				description: "Search memories",
				tier: "READ",
				params: {
					query: {
						type: "string",
						description: "What to search for",
						required: true,
					},
				},
			},
		],
	},

	getTools() {
		return this.manifest.actions.map((a) => ({
			name: `memory__${a.id}`,
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

	async execute(actionId, params) {
		if (actionId === "remember") {
			const tags = ((params.tags as string) ?? "")
				.split(",")
				.map((t) => t.trim()) as Memory["tags"][];
			const memory = memoryEngine.store({
				content: params.content as string,
				summary: params.summary as string,
				tags: tags as import("../memory/memory-engine.js").MemoryTag[],
				source: "agent",
				importance: (params.importance as number) ?? 3,
			});
			return { stored: true, id: memory.id };
		}
		if (actionId === "recall") {
			const results = memoryEngine.search(params.query as string, 10);
			return {
				memories: results.map((r) => ({
					summary: r.memory.summary,
					tags: r.memory.tags,
					score: r.relevanceScore,
				})),
			};
		}
		throw new Error(`Unknown action: ${actionId}`);
	},
};

// Register built-in skills + register their executors with the task engine
export function registerBuiltinSkills(): void {
	skillRegistry.register(fileSearchSkill);
	skillRegistry.register(webSearchSkill);
	skillRegistry.register(memorySkill);

	// New power skills
	import("./filesystem-skill.js").then(({ filesystemSkill }) => {
		skillRegistry.register(filesystemSkill);
	});
	import("./shell-skill.js").then(({ shellSkill }) => {
		skillRegistry.register(shellSkill);
	});
	import("./code-skill.js").then(({ codeSkill }) => {
		skillRegistry.register(codeSkill);
	});
	import("./process-skill.js").then(({ processSkill }) => {
		skillRegistry.register(processSkill);
	});

	// Register task engine executors so background dispatches actually run
	import("../tasks/task-engine.js").then(({ taskEngine }) => {
		taskEngine.registerExecutor("file-search", async (task, helpers) => {
			helpers.progress(10, "Starting file search...");
			const { actionId, ...params } = task.params as {
				actionId: string;
			} & Record<string, unknown>;
			helpers.progress(40, `Searching...`);
			const result = await fileSearchSkill.execute(
				actionId ?? "search_files",
				params,
			);
			helpers.progress(100, "Done");
			return result;
		});

		taskEngine.registerExecutor("web-search", async (task, helpers) => {
			helpers.progress(20, "Searching the web...");
			const { actionId, ...params } = task.params as {
				actionId: string;
			} & Record<string, unknown>;
			const result = await webSearchSkill.execute(actionId ?? "search", params);
			helpers.progress(100, "Done");
			return result;
		});

		taskEngine.registerExecutor("memory", async (task, helpers) => {
			helpers.progress(50, "Accessing memory...");
			const { actionId, ...params } = task.params as {
				actionId: string;
			} & Record<string, unknown>;
			const result = await memorySkill.execute(actionId ?? "recall", params);
			helpers.progress(100, "Done");
			return result;
		});

		taskEngine.registerExecutor("filesystem", async (task, helpers) => {
			helpers.progress(10, "Starting filesystem operation...");
			const { actionId, ...params } = task.params as {
				actionId: string;
			} & Record<string, unknown>;
			import("./filesystem-skill.js").then(async ({ filesystemSkill }) => {
				helpers.progress(50, `Running ${actionId}...`);
				const result = await filesystemSkill.execute(actionId, params);
				helpers.progress(100, "Done");
				return result;
			});
		});

		taskEngine.registerExecutor("shell", async (task, helpers) => {
			helpers.progress(10, "Running command...");
			const { actionId, ...params } = task.params as {
				actionId: string;
			} & Record<string, unknown>;
			import("./shell-skill.js").then(async ({ shellSkill }) => {
				helpers.progress(30, `Executing...`);
				const result = await shellSkill.execute(actionId ?? "run", params);
				helpers.progress(100, "Done");
				return result;
			});
		});

		taskEngine.registerExecutor("code", async (task, helpers) => {
			helpers.progress(10, "Starting code operation...");
			const { actionId, ...params } = task.params as {
				actionId: string;
			} & Record<string, unknown>;
			import("./code-skill.js").then(async ({ codeSkill }) => {
				helpers.progress(30, `Running ${actionId}...`);
				const result = await codeSkill.execute(actionId, params);
				helpers.progress(100, "Done");
				return result;
			});
		});
	});
}
