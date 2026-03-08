/**
 * A.L.A.N. Agent — v2
 *
 * Orchestration patterns:
 *   1. Graph state machine   — explicit state transitions, full trace per run
 *   2. ReAct reasoning       — Thought → Action → Observation per tool round
 *   3. Plan → Execute        — complex requests decomposed before execution
 *   4. Reflection            — post-response quality check + safety flag for WRITE actions
 *   5. Semantic memory       — FTS5 search injected as context every turn
 *   6. Background dispatch   — long-running tools handed to TaskEngine
 *   7. Tier enforcement      — READ auto / WRITE confirm / DESTRUCTIVE confirm (in code)
 */

import {
	geminiClient,
	type ChatMessage,
	type ToolCallRequest,
} from "../llm/gemini-client.js";
import { memoryEngine } from "../memory/memory-engine.js";
import { taskEngine } from "../tasks/task-engine.js";
import { skillRegistry } from "../skills/skill-system.js";
import { rateLimiter } from "../llm/rate-limiter.js";
import { AgentGraph, type AgentTrace } from "./graph.js";
import { shouldPlan, buildPlan, type StepPlan } from "./planner.js";
import { reflect } from "./reflector.js";
import type { EventEmitter } from "events";
import type { ActionTier } from "../tasks/task-engine.js";

export interface AgentMessage {
	id: string;
	sessionId: string;
	role: "user" | "assistant" | "system";
	content: string;
	timestamp: number;
	taskId?: string;
	toolsUsed?: string[];
	trace?: AgentTrace;
	reflectionGap?: string;
	plan?: StepPlan;
}

export interface AgentResponse {
	message: AgentMessage;
	backgroundTaskId?: string;
	quotaWarning?: string;
}

interface PendingConfirmation {
	sessionId: string;
	toolCall: ToolCallRequest;
	tier: ActionTier;
	resolve: (approved: boolean) => void;
}

interface ConversationSession {
	id: string;
	history: ChatMessage[];
	createdAt: number;
	lastActive: number;
}

// ReAct thought — stored in history but not shown directly in chat
interface ReActTurn {
	thought: string;
	action?: string;
	observation?: string;
}

const MAX_HISTORY = 24;
const MAX_TOOL_ROUNDS = 8;
const MAX_REFLECT_RETRIES = 1;
const REFLECT_CONFIDENCE_THRESHOLD = 0.4;

// Tools dispatched to background TaskEngine instead of running inline
// (long-running operations that shouldn't block the interactive loop)
const BACKGROUND_TOOLS = new Set([
	"file-search__search_files",
	"code__generate_code",
	"code__scaffold",
	"code__explain_code",
	"code__run_tests",
	"code__install_deps",
	"code__fix_errors",
]);

export class AlanAgent {
	private sessions = new Map<string, ConversationSession>();
	private pendingConfirmations = new Map<string, PendingConfirmation>();

	constructor(private eventBus: EventEmitter) {
		taskEngine.on("task:update", (update) => {
			this.eventBus.emit("agent:task_update", {
				taskId: update.taskId,
				type: update.type,
				message: update.message,
				data: update.data,
			});
		});
	}

	// ─── Public API ───────────────────────────────────────────────────────────

	async chat(sessionId: string, userMessage: string): Promise<AgentResponse> {
		const session = this.getOrCreateSession(sessionId);
		const graph = new AgentGraph(sessionId);

		// Quota check
		const quota = rateLimiter.getQuotaSnapshot();
		let quotaWarning: string | undefined;
		if (quota.rpm.used / quota.rpm.limit > 0.8) {
			quotaWarning = `Approaching rate limit (${quota.rpm.used}/${quota.rpm.limit} RPM used)`;
		}

		// ── Step 1: Memory recall ──────────────────────────────────────────────
		graph.transition(
			"THINKING",
			"Recalling memory",
			`Query: "${userMessage.substring(0, 60)}"`,
		);
		const memoryContext = memoryEngine.getContextForQuery(userMessage, 500);

		// ── Step 2: Planning (optional) ───────────────────────────────────────
		let plan: StepPlan | undefined;
		const allTools = skillRegistry.getAllTools();
		const toolNames = allTools.map((t) => t.name);

		if (shouldPlan(userMessage)) {
			graph.transition(
				"PLANNING",
				"Building execution plan",
				`Tools available: ${toolNames.length}`,
			);
			this.eventBus.emit("agent:state_change", {
				sessionId,
				runId: graph.runId,
				state: "PLANNING",
				label: "Building plan…",
			});
			try {
				plan = await buildPlan(userMessage, toolNames);
				graph.setPlan(plan.steps.map((s) => s.goal));
			} catch {
				// planning failed — continue without plan
			}
		}

		// Add user message to history
		session.history.push({
			role: "user",
			content: userMessage,
			timestamp: Date.now(),
		});
		if (session.history.length > MAX_HISTORY) {
			session.history = session.history.slice(-MAX_HISTORY);
		}

		const systemPrompt = this.buildSystemPrompt(memoryContext, plan);
		const toolsUsed: string[] = [];
		const reactTurns: ReActTurn[] = [];

		try {
			// ── Step 3: ReAct loop ───────────────────────────────────────────────
			graph.transition("THINKING", "Gemini initial reasoning");
			this.eventBus.emit("agent:state_change", {
				sessionId,
				runId: graph.runId,
				state: "THINKING",
				label: "Thinking…",
			});

			let response = await geminiClient.chat(session.history, {
				priority: "INTERACTIVE",
				config: { systemPrompt },
				tools: allTools,
			});

			let rounds = 0;

			while (response.toolCalls.length > 0 && rounds < MAX_TOOL_ROUNDS) {
				rounds++;

				// Extract thought if the model produced text before tool calls
				const thoughtText = response.text?.trim();
				const currentTurn: ReActTurn = {
					thought: thoughtText || `Round ${rounds}: calling tools`,
				};
				reactTurns.push(currentTurn);

				graph.transition(
					"CALLING_TOOL",
					`Tool round ${rounds}`,
					`Calls: ${response.toolCalls.map((c) => c.toolName).join(", ")}`,
				);
				this.eventBus.emit("agent:state_change", {
					sessionId,
					runId: graph.runId,
					state: "CALLING_TOOL",
					label: `Calling: ${response.toolCalls.map((c) => c.actionId).join(", ")}`,
					tools: response.toolCalls.map((c) => c.toolName),
				});

				const toolResults: Array<{ toolName: string; result: unknown }> = [];

				for (const call of response.toolCalls) {
					const tier = this.getTierForTool(call.skillId, call.actionId);
					graph.recordTool(call.toolName);

					// ── Background dispatch ──────────────────────────────────────────
					if (BACKGROUND_TOOLS.has(call.toolName)) {
						const taskId = this.dispatchBackgroundTool(call, sessionId);
						const msg = this.makeAgentMessage(
							sessionId,
							`I've kicked off that search in the background (task ${taskId.slice(0, 8)}…). I'll notify you when it's done.`,
							taskId,
							toolsUsed,
							graph.complete(),
							undefined,
							plan,
						);
						session.history.push({
							role: "assistant",
							content: msg.content,
							timestamp: Date.now(),
						});
						session.lastActive = Date.now();
						return { message: msg, backgroundTaskId: taskId, quotaWarning };
					}

					// ── READ: auto-execute ───────────────────────────────────────────
					if (tier === "READ") {
						const result = await this.executeTool(call);
						toolResults.push({ toolName: call.toolName, result });
						toolsUsed.push(call.toolName);
						currentTurn.observation = `${call.actionId} returned ${JSON.stringify(result).substring(0, 120)}`;
					}

					// ── WRITE: pause for confirmation ────────────────────────────────
					else if (tier === "WRITE") {
						graph.transition(
							"AWAITING_CONFIRMATION",
							`Confirm WRITE: ${call.actionId}`,
						);
						this.eventBus.emit("agent:state_change", {
							sessionId,
							runId: graph.runId,
							state: "AWAITING_CONFIRMATION",
							label: `Waiting for approval: ${call.actionId}`,
						});
						const approved = await this.requestConfirmation(
							sessionId,
							call,
							"WRITE",
						);
						graph.transition(
							"CALLING_TOOL",
							approved ? "WRITE approved" : "WRITE denied",
						);
						if (approved) {
							const result = await this.executeTool(call);
							toolResults.push({ toolName: call.toolName, result });
							toolsUsed.push(call.toolName);
							currentTurn.observation = `${call.actionId}: executed (approved)`;
						} else {
							toolResults.push({
								toolName: call.toolName,
								result: { denied: true, reason: "User denied this action." },
							});
							currentTurn.observation = `${call.actionId}: denied by user`;
						}
					}

					// ── DESTRUCTIVE: pause for confirmation ──────────────────────────
					else if (tier === "DESTRUCTIVE") {
						graph.transition(
							"AWAITING_CONFIRMATION",
							`Confirm DESTRUCTIVE: ${call.actionId}`,
						);
						this.eventBus.emit("agent:state_change", {
							sessionId,
							runId: graph.runId,
							state: "AWAITING_CONFIRMATION",
							label: `⚠️ Waiting for approval: ${call.actionId} (destructive)`,
						});
						const approved = await this.requestConfirmation(
							sessionId,
							call,
							"DESTRUCTIVE",
						);
						graph.transition(
							"CALLING_TOOL",
							approved ? "DESTRUCTIVE approved" : "DESTRUCTIVE denied",
						);
						if (approved) {
							const result = await this.executeTool(call);
							toolResults.push({ toolName: call.toolName, result });
							toolsUsed.push(call.toolName);
							currentTurn.observation = `${call.actionId}: executed (destructive, approved)`;
						} else {
							toolResults.push({
								toolName: call.toolName,
								result: {
									denied: true,
									reason: "User denied this destructive action.",
								},
							});
							currentTurn.observation = `${call.actionId}: denied by user`;
						}
					}
				}

				// Send observations back to Gemini
				graph.transition("THINKING", `Synthesising round ${rounds} results`);
				this.eventBus.emit("agent:state_change", {
					sessionId,
					runId: graph.runId,
					state: "THINKING",
					label: `Processing results…`,
				});

				response = await geminiClient.sendToolResults(
					session.history,
					toolResults,
					{
						priority: "INTERACTIVE",
						config: { systemPrompt },
						tools: allTools,
					},
				);
			}

			// ── Step 4: Final text ───────────────────────────────────────────────
			const finalText = response.text || "Done.";
			session.history.push({
				role: "assistant",
				content: finalText,
				timestamp: Date.now(),
			});
			session.lastActive = Date.now();

			// ── Step 5: Reflection ───────────────────────────────────────────────
			graph.transition("REFLECTING", "Evaluating response quality");
			this.eventBus.emit("agent:state_change", {
				sessionId,
				runId: graph.runId,
				state: "REFLECTING",
				label: "Reflecting…",
			});

			let reflectionGap: string | undefined;
			const hasWriteActions = toolsUsed.some((t) => {
				const [skillId, actionId] = t.split("__");
				return this.getTierForTool(skillId, actionId) !== "READ";
			});

			// Only reflect when confidence threshold warrants it (avoid extra quota usage on simple replies)
			if (toolsUsed.length > 0 || userMessage.split(" ").length > 8) {
				try {
					const reflection = await reflect(
						userMessage,
						finalText,
						toolsUsed,
						hasWriteActions,
					);
					graph.setReflection(
						reflection.adequate
							? `Adequate (confidence: ${(reflection.confidence * 100).toFixed(0)}%)`
							: `Gap found: ${reflection.gap}`,
					);

					if (
						!reflection.adequate &&
						reflection.confidence > REFLECT_CONFIDENCE_THRESHOLD &&
						reflection.gap
					) {
						reflectionGap = reflection.gap;
					}
					if (reflection.safetyFlag) {
						reflectionGap = `⚠️ Safety note: ${reflection.safetyFlag}`;
					}
				} catch {
					// reflection failed — not fatal
				}
			}

			// Auto-memorize notable user preferences
			this.autoMemorize(userMessage);

			graph.transition(
				"DONE",
				"Complete",
				`${toolsUsed.length} tools, ${rounds} rounds`,
			);

			const agentMessage = this.makeAgentMessage(
				sessionId,
				finalText,
				undefined,
				toolsUsed,
				graph.complete(),
				reflectionGap,
				plan,
			);

			return { message: agentMessage, quotaWarning };
		} catch (err) {
			graph.transition("ERROR", String(err));
			const error = err as Error;
			if (error.message.startsWith("RATE_LIMIT_WAIT:")) {
				const seconds = error.message.split(":")[1];
				return {
					message: this.makeAgentMessage(
						sessionId,
						`I'm at my Gemini rate limit. I'll process your message in ~${seconds}s.`,
					),
					quotaWarning: `Rate limited for ~${seconds}s`,
				};
			}
			throw error;
		}
	}

	respondToConfirmation(confirmationId: string, approved: boolean): boolean {
		const pending = this.pendingConfirmations.get(confirmationId);
		if (!pending) return false;
		this.pendingConfirmations.delete(confirmationId);
		pending.resolve(approved);
		return true;
	}

	confirmTaskAction(taskId: string, approved: boolean): boolean {
		return taskEngine.respondToConfirmation(taskId, approved);
	}

	cancelTask(taskId: string): boolean {
		return taskEngine.cancel(taskId);
	}

	getActiveTasks() {
		return taskEngine.getActiveTasks();
	}
	getQuotaSnapshot() {
		return rateLimiter.getQuotaSnapshot();
	}
	clearSession(sessionId: string): void {
		this.sessions.delete(sessionId);
	}

	// ─── Tool helpers ─────────────────────────────────────────────────────────

	private getTierForTool(skillId: string, actionId: string): ActionTier {
		const skill = skillRegistry.get(skillId);
		if (!skill) return "WRITE";
		const action = skill.manifest.actions.find((a) => a.id === actionId);
		return action?.tier ?? "WRITE";
	}

	private async executeTool(call: ToolCallRequest): Promise<unknown> {
		try {
			return await skillRegistry.execute(
				call.skillId,
				call.actionId,
				call.params,
			);
		} catch (err) {
			return { error: err instanceof Error ? err.message : String(err) };
		}
	}

	private requestConfirmation(
		sessionId: string,
		call: ToolCallRequest,
		tier: ActionTier,
	): Promise<boolean> {
		return new Promise((resolve) => {
			const confirmationId = crypto.randomUUID();

			this.pendingConfirmations.set(confirmationId, {
				sessionId,
				toolCall: call,
				tier,
				resolve,
			});

			this.eventBus.emit("agent:confirmation_required", {
				confirmationId,
				sessionId,
				tier,
				toolName: call.toolName,
				skillId: call.skillId,
				actionId: call.actionId,
				params: call.params,
				description: this.describeToolCall(call, tier),
			});

			// Auto-deny after 5 minutes
			setTimeout(
				() => {
					if (this.pendingConfirmations.has(confirmationId)) {
						this.pendingConfirmations.delete(confirmationId);
						resolve(false);
					}
				},
				5 * 60 * 1000,
			);
		});
	}

	private describeToolCall(call: ToolCallRequest, tier: ActionTier): string {
		const paramsStr = Object.entries(call.params)
			.map(([k, v]) => `${k}: "${v}"`)
			.join(", ");
		const prefix = tier === "DESTRUCTIVE" ? "⚠️ DESTRUCTIVE: " : "";
		return `${prefix}${call.skillId} → ${call.actionId}(${paramsStr})`;
	}

	private dispatchBackgroundTool(
		call: ToolCallRequest,
		sessionId: string,
	): string {
		return taskEngine.submit({
			id: crypto.randomUUID(),
			name: `${call.skillId}: ${call.actionId}`,
			description: this.describeToolCall(call, "READ"),
			skillId: call.skillId,
			priority: "NORMAL",
			params: { actionId: call.actionId, ...call.params },
		});
	}

	// ─── Session / prompt helpers ─────────────────────────────────────────────

	private getOrCreateSession(sessionId: string): ConversationSession {
		if (!this.sessions.has(sessionId)) {
			this.sessions.set(sessionId, {
				id: sessionId,
				history: [],
				createdAt: Date.now(),
				lastActive: Date.now(),
			});
		}
		return this.sessions.get(sessionId)!;
	}

	private buildSystemPrompt(memoryContext: string, plan?: StepPlan): string {
		const manifests = skillRegistry.getManifests();
		const toolList = manifests
			.flatMap((m) =>
				m.actions.map(
					(a) => `  • ${m.id}__${a.id} [${a.tier}] — ${a.description}`,
				),
			)
			.join("\n");

		const planSection =
			plan && plan.steps.length > 1
				? `\nEXECUTION PLAN (follow this order):\n${plan.steps.map((s) => `  ${s.id}. ${s.goal}`).join("\n")}\n`
				: "";

		return `You are A.L.A.N. — Autonomous Local Assistant Node. A powerful, locally-running AI engineer.

CAPABILITIES:
  - Read ANY file or directory on this machine
  - Write/create/delete ONLY inside ~/.alan/workspace/main (the workspace)
  - Execute terminal commands (safe ones instantly; others after user confirmation)
  - Spawn and monitor background processes (dev servers, watchers)
  - Scaffold full projects, generate code, patch files, run tests, install deps
  - Autonomous multi-step coding: plan → scaffold → implement → test → fix

WORKSPACE: ~/.alan/workspace/main
  All code you write goes here. Reference workspace paths without the full prefix.
  To read existing user files (e.g. on Desktop), use filesystem__read_file with the full path.

REASONING (ReAct pattern):
Before each tool call, state your thought in 1-2 sentences: what you know, what you're doing and why.
After observing results, reason about the next step. Chain tool calls autonomously — don't ask for permission between steps.

TIER RULES (enforced in code):
  READ        → execute immediately, zero friction
  WRITE       → system will auto-pause for confirmation before executing
  DESTRUCTIVE → system will warn with full detail before executing

CODING WORKFLOW (for complex apps):
  1. code__scaffold to create project structure
  2. filesystem__write_file for each component/module
  3. shell__run_safe for npm install, git init, etc.
  4. code__run_tests to verify
  5. code__fix_errors if tests fail (loop until passing)
  6. process__start for dev servers

AUTONOMOUS BEHAVIOUR:
  - Chain as many tool calls as needed to complete the goal
  - Use code__generate_code for complex logic (Gemini writes the code)
  - Use code__patch_file for targeted edits (safer than full rewrites)
  - Read existing files before modifying them
  - After creating a project, always run tests if a test suite exists

AVAILABLE TOOLS:
${toolList}
${planSection}
${memoryContext ? `RELEVANT MEMORIES:\n${memoryContext}\n` : ""}
STYLE: Direct, technically precise, terse. Never ask "shall I proceed?" for READ actions. Never say "As an AI".`;
	}

	private makeAgentMessage(
		sessionId: string,
		content: string,
		taskId?: string,
		toolsUsed?: string[],
		trace?: AgentTrace,
		reflectionGap?: string,
		plan?: StepPlan,
	): AgentMessage {
		return {
			id: crypto.randomUUID(),
			sessionId,
			role: "assistant",
			content,
			timestamp: Date.now(),
			taskId,
			toolsUsed,
			trace,
			reflectionGap,
			plan,
		};
	}

	private autoMemorize(userMessage: string): void {
		const patterns = [
			/i (prefer|like|love|hate|always|never)/i,
			/my (name|email|job|role|company|team|project)/i,
			/call me /i,
			/i('m| am) (a |the |working)/i,
			/remember (that|this)/i,
			/important:?/i,
		];
		if (patterns.some((p) => p.test(userMessage))) {
			memoryEngine.store({
				content: `User said: "${userMessage}"`,
				summary: userMessage.substring(0, 120),
				tags: ["preference"],
				source: "user",
				importance: 3,
			});
		}
	}
}
