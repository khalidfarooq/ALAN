/**
 * A.L.A.N. Main Agent
 *
 * Tool execution loop:
 *   1. Send message to Gemini with all registered tools
 *   2. If model returns toolCalls → execute them by tier:
 *        READ        → auto-execute immediately, no confirmation
 *        WRITE       → pause, ask user to confirm via UI, then execute
 *        DESTRUCTIVE → pause, require explicit typed confirmation, then execute
 *   3. Send tool results back to Gemini for synthesis
 *   4. Repeat until no more tool calls (max 5 rounds)
 *
 * Long-running tasks (estimated >3s) are dispatched to the TaskEngine
 * so the main thread stays responsive.
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
}

export interface AgentResponse {
	message: AgentMessage;
	backgroundTaskId?: string;
	quotaWarning?: string;
}

// Pending confirmation: a WRITE/DESTRUCTIVE tool call waiting for user approval
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

const MAX_HISTORY = 20;
const MAX_TOOL_ROUNDS = 5; // prevent infinite loops

// Tools that are likely long-running and should be backgrounded
const BACKGROUND_TOOLS = new Set(["file-search__search_files"]);

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

		const quota = rateLimiter.getQuotaSnapshot();
		let quotaWarning: string | undefined;
		if (quota.rpm.used / quota.rpm.limit > 0.8) {
			quotaWarning = `Approaching rate limit (${quota.rpm.used}/${quota.rpm.limit} RPM used)`;
		}

		// Inject relevant memories into system prompt
		const memoryContext = memoryEngine.getContextForQuery(userMessage, 500);
		const systemPrompt = this.buildSystemPrompt(memoryContext);

		// Add user turn to history
		session.history.push({
			role: "user",
			content: userMessage,
			timestamp: Date.now(),
		});
		if (session.history.length > MAX_HISTORY) {
			session.history = session.history.slice(-MAX_HISTORY);
		}

		const allTools = skillRegistry.getAllTools();
		const toolsUsed: string[] = [];

		try {
			let response = await geminiClient.chat(session.history, {
				priority: "INTERACTIVE",
				config: { systemPrompt },
				tools: allTools,
			});

			// ── Tool execution loop ──────────────────────────────────────────────
			let rounds = 0;
			while (response.toolCalls.length > 0 && rounds < MAX_TOOL_ROUNDS) {
				rounds++;

				const toolResults: Array<{ toolName: string; result: unknown }> = [];

				for (const call of response.toolCalls) {
					const tier = this.getTierForTool(call.skillId, call.actionId);

					// READ → auto-execute, no questions asked
					if (tier === "READ") {
						const result = await this.executeTool(call);
						toolResults.push({ toolName: call.toolName, result });
						toolsUsed.push(call.toolName);

						// If this tool is expected to be slow, dispatch to background
						if (BACKGROUND_TOOLS.has(call.toolName)) {
							const taskId = this.dispatchBackgroundTool(call, sessionId);
							const msg = this.makeAgentMessage(
								sessionId,
								`I've started searching in the background. I'll report back when done.`,
								taskId,
								toolsUsed,
							);
							session.history.push({
								role: "assistant",
								content: msg.content,
								timestamp: Date.now(),
							});
							session.lastActive = Date.now();
							return { message: msg, backgroundTaskId: taskId, quotaWarning };
						}
					}

					// WRITE → pause and ask user to confirm
					else if (tier === "WRITE") {
						const approved = await this.requestConfirmation(
							sessionId,
							call,
							"WRITE",
						);
						if (approved) {
							const result = await this.executeTool(call);
							toolResults.push({ toolName: call.toolName, result });
							toolsUsed.push(call.toolName);
						} else {
							toolResults.push({
								toolName: call.toolName,
								result: { denied: true, reason: "User denied this action." },
							});
						}
					}

					// DESTRUCTIVE → pause and ask user with strong warning
					else if (tier === "DESTRUCTIVE") {
						const approved = await this.requestConfirmation(
							sessionId,
							call,
							"DESTRUCTIVE",
						);
						if (approved) {
							const result = await this.executeTool(call);
							toolResults.push({ toolName: call.toolName, result });
							toolsUsed.push(call.toolName);
						} else {
							toolResults.push({
								toolName: call.toolName,
								result: {
									denied: true,
									reason: "User denied this destructive action.",
								},
							});
						}
					}
				}

				// Send results back to Gemini for synthesis
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

			// ── Final text response ──────────────────────────────────────────────
			const finalText = response.text || "Done.";
			session.history.push({
				role: "assistant",
				content: finalText,
				timestamp: Date.now(),
			});
			session.lastActive = Date.now();

			// Auto-memorize notable user statements
			this.autoMemorize(userMessage);

			const agentMessage = this.makeAgentMessage(
				sessionId,
				finalText,
				undefined,
				toolsUsed,
			);
			return { message: agentMessage, quotaWarning };
		} catch (err) {
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

	/**
	 * Respond to a pending WRITE/DESTRUCTIVE confirmation.
	 * Called when user clicks Approve/Deny in the UI.
	 */
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

	/**
	 * Look up the ActionTier for a given skill+action from the manifest.
	 * Defaults to WRITE if not found (safe default).
	 */
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

	/**
	 * Request confirmation from the user for a WRITE or DESTRUCTIVE action.
	 * Emits an event to the UI and awaits the user's response.
	 * Times out after 5 minutes and defaults to denied.
	 */
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

			// Emit to UI
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

			// Auto-deny after 5 minutes to prevent hanging indefinitely
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

	/**
	 * Dispatch a long-running tool to the background task engine.
	 * Returns the task ID so the UI can track it.
	 */
	private dispatchBackgroundTool(
		call: ToolCallRequest,
		sessionId: string,
	): string {
		const skill = skillRegistry.get(call.skillId);
		const action = skill?.manifest.actions.find((a) => a.id === call.actionId);

		const taskId = taskEngine.submit({
			id: crypto.randomUUID(),
			name: `${call.skillId}: ${call.actionId}`,
			description: this.describeToolCall(call, "READ"),
			skillId: call.skillId,
			priority: "NORMAL",
			params: { actionId: call.actionId, ...call.params },
		});

		return taskId;
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

	private buildSystemPrompt(memoryContext: string): string {
		const manifests = skillRegistry.getManifests();
		const toolList = manifests
			.flatMap((m) =>
				m.actions.map(
					(a) => `  • ${m.id}__${a.id} [${a.tier}] — ${a.description}`,
				),
			)
			.join("\n");

		return `You are A.L.A.N. — Autonomous Local Assistant Node. Privacy-first local AI assistant.

TIER RULES (enforced in code — do NOT ask user permission for READ actions):
  READ        → call the tool immediately, no confirmation needed
  WRITE       → the system will automatically pause and ask the user before executing
  DESTRUCTIVE → the system will automatically pause and warn the user before executing

You never need to ask "shall I proceed?" for READ actions — just call the tool.
For WRITE/DESTRUCTIVE, just call the tool — the confirmation UI handles it automatically.

AVAILABLE TOOLS:
${toolList}

BACKGROUND TASKS:
If a task will take more than a few seconds, say "I'll run this in the background and report back."
The system will handle dispatching it automatically.

${memoryContext ? `RELEVANT MEMORIES:\n${memoryContext}` : ""}

Be concise, direct, and helpful. Integrate memories naturally.`;
	}

	private makeAgentMessage(
		sessionId: string,
		content: string,
		taskId?: string,
		toolsUsed?: string[],
	): AgentMessage {
		return {
			id: crypto.randomUUID(),
			sessionId,
			role: "assistant",
			content,
			timestamp: Date.now(),
			taskId,
			toolsUsed,
		};
	}

	private autoMemorize(userMessage: string): void {
		const patterns = [
			/i (prefer|like|love|hate|always|never)/i,
			/my (name|email|job|role|company|team)/i,
			/call me /i,
			/i('m| am) (a |the )/i,
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
