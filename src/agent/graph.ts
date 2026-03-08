/**
 * A.L.A.N. Agent Graph
 *
 * Models agent execution as an explicit state machine.
 * Each AgentState transition is logged to the trace — full observability.
 *
 * States:
 *   IDLE → PLANNING → THINKING → CALLING_TOOL → REFLECTING → DONE | ERROR
 *
 * If a WRITE/DESTRUCTIVE tool is needed:
 *   THINKING → AWAITING_CONFIRMATION → CALLING_TOOL (if approved) | THINKING (if denied)
 */

export type GraphState =
	| "IDLE"
	| "PLANNING"
	| "THINKING"
	| "CALLING_TOOL"
	| "AWAITING_CONFIRMATION"
	| "REFLECTING"
	| "DONE"
	| "ERROR";

export interface TraceStep {
	state: GraphState;
	label: string;
	detail?: string;
	durationMs?: number;
	ts: number;
}

export interface AgentTrace {
	sessionId: string;
	runId: string;
	steps: TraceStep[];
	startTs: number;
	endTs?: number;
	totalDurationMs?: number;
	planSteps?: string[];
	toolsUsed: string[];
	reflectionNote?: string;
}

export class AgentGraph {
	private currentState: GraphState = "IDLE";
	private trace: AgentTrace;
	private stepStart: number = Date.now();

	constructor(sessionId: string) {
		const runId = crypto.randomUUID();
		this.trace = {
			sessionId,
			runId,
			steps: [],
			startTs: Date.now(),
			toolsUsed: [],
		};
	}

	get state(): GraphState {
		return this.currentState;
	}
	get runId(): string {
		return this.trace.runId;
	}

	transition(next: GraphState, label: string, detail?: string): void {
		const now = Date.now();
		this.trace.steps.push({
			state: next,
			label,
			detail,
			durationMs: now - this.stepStart,
			ts: now,
		});
		this.stepStart = now;
		this.currentState = next;
	}

	recordTool(toolName: string): void {
		if (!this.trace.toolsUsed.includes(toolName)) {
			this.trace.toolsUsed.push(toolName);
		}
	}

	setPlan(steps: string[]): void {
		this.trace.planSteps = steps;
	}

	setReflection(note: string): void {
		this.trace.reflectionNote = note;
	}

	complete(): AgentTrace {
		this.trace.endTs = Date.now();
		this.trace.totalDurationMs = this.trace.endTs - this.trace.startTs;
		return this.trace;
	}

	getTrace(): AgentTrace {
		return this.trace;
	}
}
