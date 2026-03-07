/**
 * A.L.A.N. Task Engine
 * Non-blocking background task execution.
 * Tasks run in the same process but are async and non-blocking to the main thread.
 * Tasks report back to the main agent thread via the EventBus.
 * All tasks are persisted to SQLite and survive restarts.
 */

import Database from "better-sqlite3";
import { EventEmitter } from "events";
import { join } from "path";
import { homedir } from "os";
import { existsSync } from "fs";

export type TaskStatus =
	| "PENDING"
	| "RUNNING"
	| "AWAITING_CONFIRMATION"
	| "PAUSED"
	| "COMPLETED"
	| "FAILED"
	| "CANCELLED";
export type TaskPriority = "HIGH" | "NORMAL" | "LOW";
export type ActionTier = "READ" | "WRITE" | "DESTRUCTIVE";

export interface TaskDefinition {
	id: string;
	name: string;
	description: string;
	skillId: string;
	priority: TaskPriority;
	estimatedDurationMs?: number;
	params: Record<string, unknown>;
}

export interface TaskRecord extends TaskDefinition {
	status: TaskStatus;
	progress: number; // 0-100
	progressMessage?: string;
	result?: unknown;
	error?: string;
	createdAt: number;
	startedAt?: number;
	completedAt?: number;
	pendingAction?: PendingAction;
}

export interface PendingAction {
	tier: ActionTier;
	description: string;
	details: Record<string, unknown>;
	confirmationToken: string;
}

export interface TaskUpdate {
	taskId: string;
	type:
		| "PROGRESS"
		| "COMPLETED"
		| "FAILED"
		| "AWAITING_CONFIRMATION"
		| "CANCELLED";
	data: Partial<TaskRecord>;
	message: string;
}

const DB_PATH = join(homedir(), ".alan", "tasks.db");

class TaskDatabase {
	private db: Database.Database;

	constructor() {
		this.db = new Database(DB_PATH);
		this.db.pragma("journal_mode = WAL");
		this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        priority TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        progress INTEGER NOT NULL DEFAULT 0,
        progress_message TEXT,
        params TEXT NOT NULL DEFAULT '{}',
        result TEXT,
        error TEXT,
        pending_action TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER
      );
    `);
	}

	upsert(task: TaskRecord): void {
		this.db
			.prepare(
				`
      INSERT INTO tasks (id, name, description, skill_id, priority, status, progress, progress_message, params, result, error, pending_action, created_at, started_at, completed_at)
      VALUES (@id, @name, @description, @skillId, @priority, @status, @progress, @progressMessage, @params, @result, @error, @pendingAction, @createdAt, @startedAt, @completedAt)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        progress = excluded.progress,
        progress_message = excluded.progress_message,
        result = excluded.result,
        error = excluded.error,
        pending_action = excluded.pending_action,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at
    `,
			)
			.run({
				...task,
				params: JSON.stringify(task.params),
				result: task.result ? JSON.stringify(task.result) : null,
				pendingAction: task.pendingAction
					? JSON.stringify(task.pendingAction)
					: null,
				startedAt: task.startedAt ?? null,
				completedAt: task.completedAt ?? null,
				progressMessage: task.progressMessage ?? null,
				error: task.error ?? null,
			});
	}

	getById(id: string): TaskRecord | null {
		const row = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as
			| Record<string, unknown>
			| undefined;
		return row ? this.deserialize(row) : null;
	}

	getActive(): TaskRecord[] {
		const rows = this.db
			.prepare(
				`
      SELECT * FROM tasks WHERE status IN ('PENDING', 'RUNNING', 'AWAITING_CONFIRMATION', 'PAUSED')
      ORDER BY CASE priority WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END, created_at
    `,
			)
			.all() as Record<string, unknown>[];
		return rows.map((r) => this.deserialize(r));
	}

	getAll(limit = 50): TaskRecord[] {
		const rows = this.db
			.prepare(`SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?`)
			.all(limit) as Record<string, unknown>[];
		return rows.map((r) => this.deserialize(r));
	}

	private deserialize(row: Record<string, unknown>): TaskRecord {
		return {
			id: row.id as string,
			name: row.name as string,
			description: row.description as string,
			skillId: row.skill_id as string,
			priority: row.priority as TaskPriority,
			status: row.status as TaskStatus,
			progress: row.progress as number,
			progressMessage: row.progress_message as string | undefined,
			params: JSON.parse(row.params as string),
			result: row.result ? JSON.parse(row.result as string) : undefined,
			error: row.error as string | undefined,
			pendingAction: row.pending_action
				? JSON.parse(row.pending_action as string)
				: undefined,
			createdAt: row.created_at as number,
			startedAt: row.started_at as number | undefined,
			completedAt: row.completed_at as number | undefined,
			estimatedDurationMs: undefined,
		};
	}
}

export type TaskExecutorFn = (
	task: TaskRecord,
	helpers: TaskHelpers,
) => Promise<unknown>;

export interface TaskHelpers {
	/** Report progress (0-100) with an optional message */
	progress(percent: number, message?: string): void;
	/** Pause and request user confirmation before a WRITE/DESTRUCTIVE action */
	requestConfirmation(
		action: Omit<PendingAction, "confirmationToken">,
	): Promise<boolean>;
	/** Check if task has been cancelled */
	isCancelled(): boolean;
}

export class TaskEngine extends EventEmitter {
	private db: TaskDatabase;
	private executors = new Map<string, TaskExecutorFn>();
	private runningTasks = new Map<string, { cancelled: boolean }>();
	private pendingConfirmations = new Map<string, (approved: boolean) => void>();
	private maxConcurrent: number;
	private currentRunning = 0;

	constructor(maxConcurrent = 4) {
		super();
		this.db = new TaskDatabase();
		this.maxConcurrent = maxConcurrent;
		// Resume interrupted tasks on startup
		setTimeout(() => this.resumeInterrupted(), 500);
	}

	/**
	 * Register a skill executor
	 */
	registerExecutor(skillId: string, fn: TaskExecutorFn): void {
		this.executors.set(skillId, fn);
	}

	/**
	 * Submit a background task. Returns immediately with task ID.
	 * Main thread is never blocked.
	 */
	submit(definition: TaskDefinition): string {
		const task: TaskRecord = {
			...definition,
			status: "PENDING",
			progress: 0,
			createdAt: Date.now(),
		};

		this.db.upsert(task);
		this.emit("task:submitted", { taskId: task.id, name: task.name });

		// Schedule without blocking
		setImmediate(() => this.tryRunNext());

		return task.id;
	}

	/**
	 * Cancel a running or pending task
	 */
	cancel(taskId: string): boolean {
		const task = this.db.getById(taskId);
		if (!task) return false;
		if (["COMPLETED", "FAILED", "CANCELLED"].includes(task.status))
			return false;

		const running = this.runningTasks.get(taskId);
		if (running) running.cancelled = true;

		task.status = "CANCELLED";
		task.completedAt = Date.now();
		this.db.upsert(task);

		this.emitUpdate({
			taskId,
			type: "CANCELLED",
			data: task,
			message: `Task "${task.name}" was cancelled.`,
		});

		return true;
	}

	/**
	 * Respond to a pending action confirmation
	 */
	respondToConfirmation(taskId: string, approved: boolean): boolean {
		const resolver = this.pendingConfirmations.get(taskId);
		if (!resolver) return false;
		this.pendingConfirmations.delete(taskId);
		resolver(approved);
		return true;
	}

	getTask(taskId: string): TaskRecord | null {
		return this.db.getById(taskId);
	}

	getActiveTasks(): TaskRecord[] {
		return this.db.getActive();
	}

	getAllTasks(limit?: number): TaskRecord[] {
		return this.db.getAll(limit);
	}

	// ─── Internal ─────────────────────────────────────────────────────────────

	private async tryRunNext(): Promise<void> {
		if (this.currentRunning >= this.maxConcurrent) return;

		const pending = this.db.getActive().filter((t) => t.status === "PENDING");
		if (pending.length === 0) return;

		const next = pending[0];
		this.runTask(next);
	}

	private async runTask(task: TaskRecord): Promise<void> {
		const executor = this.executors.get(task.skillId);
		if (!executor) {
			task.status = "FAILED";
			task.error = `No executor registered for skill '${task.skillId}'`;
			task.completedAt = Date.now();
			this.db.upsert(task);
			this.emitUpdate({
				taskId: task.id,
				type: "FAILED",
				data: task,
				message: task.error,
			});
			return;
		}

		const state = { cancelled: false };
		this.runningTasks.set(task.id, state);
		this.currentRunning++;

		task.status = "RUNNING";
		task.startedAt = Date.now();
		this.db.upsert(task);

		const helpers: TaskHelpers = {
			progress: (percent: number, message?: string) => {
				task.progress = Math.max(0, Math.min(100, percent));
				task.progressMessage = message;
				this.db.upsert(task);
				this.emitUpdate({
					taskId: task.id,
					type: "PROGRESS",
					data: { progress: task.progress, progressMessage: message },
					message: message ?? `${task.name}: ${percent}%`,
				});
			},

			requestConfirmation: (
				action: Omit<PendingAction, "confirmationToken">,
			) => {
				return new Promise<boolean>((resolve) => {
					const token = crypto.randomUUID();
					const pendingAction: PendingAction = {
						...action,
						confirmationToken: token,
					};

					task.status = "AWAITING_CONFIRMATION";
					task.pendingAction = pendingAction;
					this.db.upsert(task);

					this.pendingConfirmations.set(task.id, resolve);
					this.emitUpdate({
						taskId: task.id,
						type: "AWAITING_CONFIRMATION",
						data: { pendingAction },
						message: `⚠️ "${task.name}" needs your approval: ${action.description}`,
					});
				});
			},

			isCancelled: () => state.cancelled,
		};

		try {
			const result = await executor(task, helpers);

			if (!state.cancelled) {
				task.status = "COMPLETED";
				task.progress = 100;
				task.result = result;
				task.completedAt = Date.now();
				this.db.upsert(task);

				this.emitUpdate({
					taskId: task.id,
					type: "COMPLETED",
					data: task,
					message: `✅ "${task.name}" completed.`,
				});
			}
		} catch (err) {
			if (!state.cancelled) {
				task.status = "FAILED";
				task.error = err instanceof Error ? err.message : String(err);
				task.completedAt = Date.now();
				this.db.upsert(task);

				this.emitUpdate({
					taskId: task.id,
					type: "FAILED",
					data: task,
					message: `❌ "${task.name}" failed: ${task.error}`,
				});
			}
		} finally {
			this.runningTasks.delete(task.id);
			this.currentRunning--;
			// Try to run the next queued task
			setImmediate(() => this.tryRunNext());
		}
	}

	private emitUpdate(update: TaskUpdate): void {
		this.emit("task:update", update);
	}

	private resumeInterrupted(): void {
		const active = this.db.getActive();
		for (const task of active) {
			if (task.status === "RUNNING") {
				// Was interrupted mid-run — reset to PENDING
				task.status = "PENDING";
				this.db.upsert(task);
			}
		}
		this.tryRunNext();
	}
}

export const taskEngine = new TaskEngine();
