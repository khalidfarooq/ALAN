/**
 * A.L.A.N. Code Intelligence Skill
 *
 * Higher-level coding operations built on top of filesystem + shell:
 *   - Scaffold new projects from templates (React, Node, Python, etc.)
 *   - Apply targeted patches to existing code (search-replace with context)
 *   - Run test suites and parse results
 *   - Lint + format files
 *   - Explain code with line-by-line annotation
 *   - Generate code to spec and write it directly to workspace
 *   - Dependency management (npm install, pip install, etc.)
 *
 * All writes go through filesystem-skill (workspace-only).
 * All execs go through shell-skill (hard-blocked patterns enforced).
 */

import { join } from "path";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import type { Skill, GeminiTool } from "./skill-system.js";
import { WORKSPACE_ROOT } from "./filesystem-skill.js";
import { geminiClient } from "../llm/gemini-client.js";
import { shellSkill } from "./shell-skill.js";
import { filesystemSkill } from "./filesystem-skill.js";

const TEMPLATES: Record<string, () => Record<string, string>> = {
	"node-ts": () => ({
		"package.json": JSON.stringify(
			{
				name: "alan-project",
				version: "1.0.0",
				type: "module",
				scripts: {
					dev: "tsx watch src/index.ts",
					build: "tsc",
					start: "node dist/index.js",
				},
				dependencies: {},
				devDependencies: {
					typescript: "^5.3.3",
					tsx: "^4.7.0",
					"@types/node": "^20.11.5",
				},
			},
			null,
			2,
		),
		"tsconfig.json": JSON.stringify(
			{
				compilerOptions: {
					target: "ES2022",
					module: "NodeNext",
					moduleResolution: "NodeNext",
					outDir: "dist",
					rootDir: "src",
					strict: true,
					esModuleInterop: true,
				},
				include: ["src"],
			},
			null,
			2,
		),
		"src/index.ts": `// Entry point\nconsole.log('A.L.A.N. project ready.');\n`,
		".gitignore": "node_modules\ndist\n.env\n",
		"README.md": "# Project\n\nBuilt by A.L.A.N.\n",
	}),

	"react-vite": () => ({
		"package.json": JSON.stringify(
			{
				name: "alan-react-app",
				version: "1.0.0",
				type: "module",
				scripts: {
					dev: "vite",
					build: "tsc && vite build",
					preview: "vite preview",
				},
				dependencies: { react: "^18.2.0", "react-dom": "^18.2.0" },
				devDependencies: {
					"@types/react": "^18.2.0",
					"@types/react-dom": "^18.2.0",
					"@vitejs/plugin-react": "^4.2.1",
					typescript: "^5.3.3",
					vite: "^5.0.12",
				},
			},
			null,
			2,
		),
		"index.html": `<!DOCTYPE html>\n<html>\n<head><meta charset="UTF-8"/><title>App</title></head>\n<body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>\n</html>`,
		"src/main.tsx": `import React from 'react'\nimport ReactDOM from 'react-dom/client'\nimport App from './App'\n\nReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)\n`,
		"src/App.tsx": `export default function App() {\n  return <div><h1>Hello from ALAN</h1></div>\n}\n`,
		"tsconfig.json": JSON.stringify(
			{
				compilerOptions: {
					target: "ES2020",
					lib: ["ES2020", "DOM"],
					module: "ESNext",
					moduleResolution: "bundler",
					jsx: "react-jsx",
					strict: true,
				},
			},
			null,
			2,
		),
		"vite.config.ts": `import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\nexport default defineConfig({ plugins: [react()] })\n`,
		".gitignore": "node_modules\ndist\n",
	}),

	python: () => ({
		"main.py": `#!/usr/bin/env python3\n"""Entry point. Built by A.L.A.N."""\n\nif __name__ == '__main__':\n    print('Ready.')\n`,
		"requirements.txt": "# Add dependencies here\n",
		"README.md": "# Python Project\n\nBuilt by A.L.A.N.\n",
		".gitignore": "__pycache__\n*.pyc\n.env\nvenv\n",
	}),

	"express-api": () => ({
		"package.json": JSON.stringify(
			{
				name: "alan-api",
				version: "1.0.0",
				type: "module",
				scripts: { dev: "tsx watch src/index.ts", build: "tsc" },
				dependencies: { express: "^4.18.2", cors: "^2.8.5" },
				devDependencies: {
					"@types/express": "^4.17.21",
					"@types/cors": "^2.8.17",
					"@types/node": "^20.11.5",
					typescript: "^5.3.3",
					tsx: "^4.7.0",
				},
			},
			null,
			2,
		),
		"src/index.ts": `import express from 'express';\nimport cors from 'cors';\n\nconst app = express();\napp.use(cors());\napp.use(express.json());\n\napp.get('/health', (_, res) => res.json({ ok: true }));\n\napp.listen(3000, () => console.log('API running on :3000'));\n`,
		"tsconfig.json": JSON.stringify(
			{
				compilerOptions: {
					target: "ES2022",
					module: "NodeNext",
					moduleResolution: "NodeNext",
					outDir: "dist",
					rootDir: "src",
					strict: true,
				},
			},
			null,
			2,
		),
		".gitignore": "node_modules\ndist\n.env\n",
	}),
};

export const codeSkill: Skill = {
	manifest: {
		id: "code",
		name: "Code Intelligence",
		version: "1.0.0",
		description:
			"Scaffold projects, patch code, run tests, install deps, explain and generate code",
		author: "ALAN Core",
		permissions: [
			{
				type: "filesystem",
				scope: "write:workspace",
				description: "Write code files to workspace",
			},
			{
				type: "shell",
				scope: "controlled",
				description: "Run build/test/lint commands",
			},
			{
				type: "network",
				scope: "npm/pip registries",
				description: "Install packages",
			},
		],
		secrets: [],
		actions: [
			{
				id: "scaffold",
				name: "Scaffold Project",
				description:
					"Create a new project from template inside the workspace. Templates: node-ts, react-vite, python, express-api",
				tier: "WRITE",
				params: {
					template: {
						type: "string",
						description:
							"Template name: node-ts | react-vite | python | express-api",
						required: true,
					},
					project_name: {
						type: "string",
						description: "Project folder name inside workspace",
						required: true,
					},
					install_deps: {
						type: "boolean",
						description:
							"Run npm install / pip install after scaffold (default: true)",
						required: false,
					},
				},
			},
			{
				id: "patch_file",
				name: "Patch File",
				description:
					"Apply a targeted search-and-replace patch to a file in the workspace",
				tier: "WRITE",
				params: {
					path: {
						type: "string",
						description: "File path relative to workspace",
						required: true,
					},
					search: {
						type: "string",
						description: "Exact string to find (must be unique in file)",
						required: true,
					},
					replace: {
						type: "string",
						description: "Replacement string",
						required: true,
					},
				},
			},
			{
				id: "generate_code",
				name: "Generate Code",
				description:
					"Ask Gemini to generate code to spec and write it directly to a file in the workspace",
				tier: "WRITE",
				params: {
					spec: {
						type: "string",
						description: "Detailed description of what the code should do",
						required: true,
					},
					output_path: {
						type: "string",
						description:
							"File path relative to workspace to write the generated code",
						required: true,
					},
					language: {
						type: "string",
						description:
							"Programming language (typescript, python, javascript, etc.)",
						required: true,
					},
					context_files: {
						type: "string",
						description:
							"Comma-separated list of workspace files to include as context",
						required: false,
					},
				},
			},
			{
				id: "run_tests",
				name: "Run Tests",
				description: "Run test suite in a workspace project directory",
				tier: "READ",
				params: {
					project_dir: {
						type: "string",
						description: "Project directory relative to workspace",
						required: true,
					},
					test_command: {
						type: "string",
						description: "Test command (default: npm test)",
						required: false,
					},
				},
			},
			{
				id: "install_deps",
				name: "Install Dependencies",
				description: "Install npm or pip packages in a workspace project",
				tier: "WRITE",
				params: {
					project_dir: {
						type: "string",
						description: "Project directory relative to workspace",
						required: true,
					},
					packages: {
						type: "string",
						description:
							"Space-separated package names, or empty to run npm install",
						required: false,
					},
					dev: {
						type: "boolean",
						description: "Install as dev dependency (npm only)",
						required: false,
					},
					manager: {
						type: "string",
						description:
							"Package manager: npm | pip | yarn | pnpm (default: npm)",
						required: false,
					},
				},
			},
			{
				id: "explain_code",
				name: "Explain Code",
				description:
					"Read a file and get a detailed line-by-line explanation with Gemini",
				tier: "READ",
				params: {
					path: {
						type: "string",
						description: "File path (anywhere on system)",
						required: true,
					},
					focus: {
						type: "string",
						description: "Specific aspect to focus on (optional)",
						required: false,
					},
				},
			},
			{
				id: "fix_errors",
				name: "Fix Errors",
				description:
					"Given error output and a file path, diagnose and apply fixes automatically",
				tier: "WRITE",
				params: {
					file_path: {
						type: "string",
						description: "File path relative to workspace",
						required: true,
					},
					error_output: {
						type: "string",
						description: "Full error/stack trace output",
						required: true,
					},
				},
			},
		],
	},

	getTools(): GeminiTool[] {
		return this.manifest.actions.map((a) => ({
			name: `code__${a.id}`,
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
		if (actionId === "scaffold") {
			const templateKey = params.template as string;
			const projectName = (params.project_name as string).replace(
				/[^a-z0-9_-]/gi,
				"-",
			);
			const installDeps = (params.install_deps as boolean) ?? true;
			const builder = TEMPLATES[templateKey];
			if (!builder)
				return {
					error: `Unknown template: ${templateKey}. Available: ${Object.keys(TEMPLATES).join(", ")}`,
				};

			const projectDir = join(WORKSPACE_ROOT, projectName);
			mkdirSync(projectDir, { recursive: true });

			const files = builder();
			const written: string[] = [];
			for (const [relPath, content] of Object.entries(files)) {
				await filesystemSkill.execute("write_file", {
					path: join(projectName, relPath),
					content,
				});
				written.push(relPath);
			}

			let installResult = null;
			if (
				installDeps &&
				(templateKey.includes("node") ||
					templateKey.includes("react") ||
					templateKey.includes("express"))
			) {
				installResult = await shellSkill.execute("run_safe", {
					command: "npm install",
					cwd: projectDir,
					timeout_seconds: 120,
				});
			} else if (installDeps && templateKey === "python") {
				installResult = await shellSkill.execute("run_safe", {
					command: "pip3 install -r requirements.txt",
					cwd: projectDir,
					timeout_seconds: 60,
				});
			}

			return {
				scaffolded: true,
				project: projectName,
				directory: projectDir,
				files_created: written,
				install_result: installResult,
			};
		}

		if (actionId === "patch_file") {
			const result = await filesystemSkill.execute("read_file", {
				path: params.path as string,
			});
			if ((result as Record<string, unknown>).error) return result;
			const content = (result as Record<string, unknown>).content as string;
			const search = params.search as string;
			if (!content.includes(search)) {
				return {
					error: `Search string not found in file. Make sure it matches exactly.`,
					path: params.path,
				};
			}
			const patched = content.replace(search, params.replace as string);
			return await filesystemSkill.execute("write_file", {
				path: params.path as string,
				content: patched,
			});
		}

		if (actionId === "generate_code") {
			const contextFiles = params.context_files
				? (params.context_files as string)
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean)
				: [];

			let contextSection = "";
			for (const cf of contextFiles) {
				const fileResult = (await filesystemSkill.execute("read_file", {
					path: cf,
				})) as Record<string, unknown>;
				if (!fileResult.error) {
					contextSection += `\n--- ${cf} ---\n${fileResult.content}\n`;
				}
			}

			const prompt = `Generate ${params.language} code for the following specification:

${params.spec}

${contextSection ? `CONTEXT (existing files):\n${contextSection}` : ""}

Rules:
- Output ONLY the code, no explanation, no markdown code fences
- The code should be complete, well-commented, and production-ready
- Include proper error handling
- Use modern idiomatic ${params.language}`;

			const response = await geminiClient.complete(prompt, {
				priority: "BACKGROUND",
				config: { temperature: 0.2, maxOutputTokens: 8192 },
			});

			const code = response.text
				.replace(/^```\w*\n?/, "")
				.replace(/\n?```$/, "")
				.trim();

			const writeResult = await filesystemSkill.execute("write_file", {
				path: params.output_path as string,
				content: code,
			});

			return {
				generated: true,
				output_path: params.output_path,
				lines: code.split("\n").length,
				tokens_used: response.totalTokens,
				write_result: writeResult,
			};
		}

		if (actionId === "run_tests") {
			const projectDir = join(WORKSPACE_ROOT, params.project_dir as string);
			const cmd = (params.test_command as string) ?? "npm test";
			const result = (await shellSkill.execute("run_safe", {
				command: cmd,
				cwd: projectDir,
				timeout_seconds: 120,
			})) as Record<string, unknown>;

			// Parse test results summary from output
			const stdout = (result.stdout as string) ?? "";
			const passed = stdout.match(/(\d+) passed/)?.[1] ?? null;
			const failed = stdout.match(/(\d+) failed/)?.[1] ?? null;

			return { ...result, summary: { passed, failed } };
		}

		if (actionId === "install_deps") {
			const projectDir = join(WORKSPACE_ROOT, params.project_dir as string);
			const packages = (params.packages as string) ?? "";
			const manager = (params.manager as string) ?? "npm";
			const isDev = (params.dev as boolean) ?? false;

			let command: string;
			if (manager === "pip" || manager === "pip3") {
				command = packages
					? `pip3 install ${packages}`
					: "pip3 install -r requirements.txt";
			} else if (manager === "yarn") {
				command = packages
					? `yarn add ${isDev ? "-D " : ""}${packages}`
					: "yarn install";
			} else if (manager === "pnpm") {
				command = packages
					? `pnpm add ${isDev ? "-D " : ""}${packages}`
					: "pnpm install";
			} else {
				command = packages
					? `npm install ${isDev ? "--save-dev " : ""}${packages}`
					: "npm install";
			}

			return await shellSkill.execute("run_safe", {
				command,
				cwd: projectDir,
				timeout_seconds: 180,
			});
		}

		if (actionId === "explain_code") {
			const fileResult = (await filesystemSkill.execute("read_file", {
				path: params.path as string,
			})) as Record<string, unknown>;
			if (fileResult.error) return fileResult;

			const focus = params.focus
				? `\n\nFocus especially on: ${params.focus}`
				: "";
			const prompt = `Explain this code file thoroughly. Include: what it does overall, key functions/classes, data flow, and any non-obvious patterns.${focus}\n\nFile: ${params.path}\n\n${fileResult.content}`;

			const response = await geminiClient.complete(prompt, {
				priority: "BACKGROUND",
				config: { temperature: 0.3, maxOutputTokens: 4096 },
			});

			return {
				path: params.path,
				explanation: response.text,
				tokens: response.totalTokens,
			};
		}

		if (actionId === "fix_errors") {
			const fileResult = (await filesystemSkill.execute("read_file", {
				path: params.file_path as string,
			})) as Record<string, unknown>;
			if (fileResult.error) return fileResult;

			const prompt = `You are a code debugger. Given this file and error output, produce the fixed version of the file.

FILE (${params.file_path}):
${fileResult.content}

ERROR OUTPUT:
${params.error_output}

Respond ONLY with the complete fixed file content — no explanation, no markdown fences.`;

			const response = await geminiClient.complete(prompt, {
				priority: "INTERACTIVE",
				config: { temperature: 0.1, maxOutputTokens: 8192 },
			});

			const fixedCode = response.text
				.replace(/^```\w*\n?/, "")
				.replace(/\n?```$/, "")
				.trim();

			const writeResult = await filesystemSkill.execute("write_file", {
				path: params.file_path as string,
				content: fixedCode,
			});

			return {
				fixed: true,
				path: params.file_path,
				original_lines: (fileResult.content as string).split("\n").length,
				fixed_lines: fixedCode.split("\n").length,
				write_result: writeResult,
			};
		}

		return { error: `Unknown action: ${actionId}` };
	},
};
