/**
 * A.L.A.N. Gemini Rate Limiter
 * Tracks all 4 Gemini quota dimensions: RPM, TPM, RPD, IPM
 * Priority queue: INTERACTIVE > BACKGROUND > BULK
 * Exponential backoff with full jitter on 429 errors
 */

export type RequestPriority = "INTERACTIVE" | "BACKGROUND" | "BULK";

export interface GeminiUsage {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
}

export interface RateLimitConfig {
	rpm: number; // requests per minute
	tpm: number; // tokens per minute
	rpd: number; // requests per day
	ipm: number; // images per minute (if using vision)
}

// Default to free tier — user can update in settings
const FREE_TIER: RateLimitConfig = {
	rpm: 15,
	tpm: 1_000_000,
	rpd: 1500,
	ipm: 10,
};

const PAID_TIER_1: RateLimitConfig = {
	rpm: 150,
	tpm: 4_000_000,
	rpd: 10_000,
	ipm: 100,
};

interface TokenBucket {
	tokens: number;
	capacity: number;
	refillRate: number; // tokens per ms
	lastRefill: number;
}

interface QueuedRequest {
	id: string;
	priority: RequestPriority;
	estimatedTokens: number;
	execute: () => Promise<unknown>;
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
	enqueueTime: number;
}

export interface QuotaSnapshot {
	rpm: { used: number; limit: number; resetInMs: number };
	tpm: { used: number; limit: number; resetInMs: number };
	rpd: { used: number; limit: number; resetInMs: number };
	queueDepth: number;
	queueByPriority: Record<RequestPriority, number>;
}

export class GeminiRateLimiter {
	private config: RateLimitConfig;
	private rpmBucket: TokenBucket;
	private tpmBucket: TokenBucket;
	private ipmBucket: TokenBucket;

	// Daily counter (resets at midnight UTC)
	private rpdCount = 0;
	private rpdDate = new Date().toDateString();

	// Priority queue
	private queue: QueuedRequest[] = [];
	private processing = false;
	private drainTimer: NodeJS.Timeout | null = null;

	// Metrics
	private totalRequests = 0;
	private totalRetries = 0;
	private totalQueueWaitMs = 0;

	constructor(config: Partial<RateLimitConfig> = {}) {
		this.config = { ...FREE_TIER, ...config };

		const now = Date.now();

		this.rpmBucket = {
			tokens: this.config.rpm,
			capacity: this.config.rpm,
			refillRate: this.config.rpm / 60000,
			lastRefill: now,
		};

		this.tpmBucket = {
			tokens: this.config.tpm,
			capacity: this.config.tpm,
			refillRate: this.config.tpm / 60000,
			lastRefill: now,
		};

		this.ipmBucket = {
			tokens: this.config.ipm,
			capacity: this.config.ipm,
			refillRate: this.config.ipm / 60000,
			lastRefill: now,
		};
	}

	updateConfig(config: Partial<RateLimitConfig>): void {
		this.config = { ...this.config, ...config };
		this.rpmBucket.capacity = this.config.rpm;
		this.rpmBucket.refillRate = this.config.rpm / 60000;
		this.tpmBucket.capacity = this.config.tpm;
		this.tpmBucket.refillRate = this.config.tpm / 60000;
	}

	usePaidTier(): void {
		this.updateConfig(PAID_TIER_1);
	}

	/**
	 * Execute a function with rate limiting and retry logic.
	 * Returns immediately for INTERACTIVE; queues for BACKGROUND/BULK.
	 */
	async execute<T>(
		fn: () => Promise<T>,
		priority: RequestPriority = "INTERACTIVE",
		estimatedTokens = 1000,
	): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const request: QueuedRequest = {
				id: crypto.randomUUID(),
				priority,
				estimatedTokens,
				execute: fn as () => Promise<unknown>,
				resolve: resolve as (v: unknown) => void,
				reject,
				enqueueTime: Date.now(),
			};

			this.enqueue(request);
			this.scheduleDrain();
		});
	}

	private enqueue(request: QueuedRequest): void {
		// Insert in priority order: INTERACTIVE first, then BACKGROUND, then BULK
		const priorityScore = { INTERACTIVE: 0, BACKGROUND: 1, BULK: 2 }[
			request.priority
		];

		let insertIdx = this.queue.length;
		for (let i = 0; i < this.queue.length; i++) {
			const existingScore = { INTERACTIVE: 0, BACKGROUND: 1, BULK: 2 }[
				this.queue[i].priority
			];
			if (priorityScore < existingScore) {
				insertIdx = i;
				break;
			}
		}

		this.queue.splice(insertIdx, 0, request);
	}

	private scheduleDrain(): void {
		if (!this.processing) {
			if (this.drainTimer) clearTimeout(this.drainTimer);
			this.drainTimer = setTimeout(() => this.drain(), 0);
		}
	}

	private async drain(): Promise<void> {
		if (this.processing || this.queue.length === 0) return;
		this.processing = true;

		while (this.queue.length > 0) {
			const next = this.queue[0];

			// Check daily limit
			this.checkRpdReset();
			if (this.rpdCount >= this.config.rpd) {
				const msUntilMidnight = this.msUntilMidnightUTC();
				console.warn(
					`[RateLimiter] Daily limit reached. Pausing queue for ${Math.ceil(msUntilMidnight / 1000)}s`,
				);
				// Reject INTERACTIVE immediately; delay others
				if (next.priority === "INTERACTIVE") {
					this.queue.shift();
					next.reject(
						new Error(
							`Daily Gemini quota (${this.config.rpd} requests) exhausted. Resets at midnight UTC.`,
						),
					);
				} else {
					await this.sleep(Math.min(msUntilMidnight, 60000));
				}
				continue;
			}

			this.refillBuckets();

			const canProceed =
				this.rpmBucket.tokens >= 1 &&
				this.tpmBucket.tokens >= Math.min(next.estimatedTokens, 100);

			if (!canProceed) {
				const waitMs = this.msUntilBucketFills(next.estimatedTokens);

				// INTERACTIVE requests get told immediately; don't silently wait > 2s
				if (next.priority === "INTERACTIVE" && waitMs > 2000) {
					this.queue.shift();
					next.reject(new Error(`RATE_LIMIT_WAIT:${Math.ceil(waitMs / 1000)}`));
					continue;
				}

				await this.sleep(Math.min(waitMs, 5000));
				continue;
			}

			// Consume bucket tokens optimistically
			this.rpmBucket.tokens -= 1;
			this.tpmBucket.tokens -= Math.min(
				next.estimatedTokens,
				this.tpmBucket.tokens,
			);
			this.rpdCount += 1;
			this.queue.shift();

			// Execute with retry
			const waitTime = Date.now() - next.enqueueTime;
			this.totalQueueWaitMs += waitTime;
			this.totalRequests++;

			this.executeWithRetry(next).catch(() => {
				/* already handled */
			});
		}

		this.processing = false;
	}

	private async executeWithRetry(
		request: QueuedRequest,
		attempt = 0,
	): Promise<void> {
		const maxAttempts = 5;

		try {
			const result = await request.execute();
			request.resolve(result);
		} catch (err: unknown) {
			const error = err as { status?: number; message?: string };

			if (error?.status === 429 && attempt < maxAttempts) {
				this.totalRetries++;

				// Exponential backoff with full jitter
				const base = 1000;
				const cap = 30000;
				const delay =
					Math.min(cap, base * Math.pow(2, attempt)) * Math.random();

				console.warn(
					`[RateLimiter] 429 on attempt ${attempt + 1}. Retrying in ${Math.round(delay)}ms`,
				);

				// Refund RPM token since the request failed
				this.rpmBucket.tokens = Math.min(
					this.rpmBucket.capacity,
					this.rpmBucket.tokens + 1,
				);
				this.rpdCount = Math.max(0, this.rpdCount - 1);

				await this.sleep(delay);
				await this.executeWithRetry(request, attempt + 1);
			} else if (error?.status === 429) {
				request.reject(
					new Error(
						`Gemini rate limit exceeded after ${maxAttempts} retries. Please wait before trying again.`,
					),
				);
			} else {
				request.reject(err instanceof Error ? err : new Error(String(err)));
			}
		}
	}

	// ─── Token Bucket Refill ─────────────────────────────────────────────────

	private refillBuckets(): void {
		const now = Date.now();

		this.refillBucket(this.rpmBucket, now);
		this.refillBucket(this.tpmBucket, now);
		this.refillBucket(this.ipmBucket, now);
	}

	private refillBucket(bucket: TokenBucket, now: number): void {
		const elapsed = now - bucket.lastRefill;
		const tokensToAdd = elapsed * bucket.refillRate;
		bucket.tokens = Math.min(bucket.capacity, bucket.tokens + tokensToAdd);
		bucket.lastRefill = now;
	}

	private msUntilBucketFills(neededTokens: number): number {
		this.refillBuckets();
		const rpmWait =
			this.rpmBucket.tokens < 1
				? (1 - this.rpmBucket.tokens) / this.rpmBucket.refillRate
				: 0;
		const tpmWait =
			this.tpmBucket.tokens < neededTokens
				? (neededTokens - this.tpmBucket.tokens) / this.tpmBucket.refillRate
				: 0;
		return Math.max(rpmWait, tpmWait);
	}

	// ─── Daily Reset ─────────────────────────────────────────────────────────

	private checkRpdReset(): void {
		const today = new Date().toDateString();
		if (today !== this.rpdDate) {
			this.rpdCount = 0;
			this.rpdDate = today;
		}
	}

	private msUntilMidnightUTC(): number {
		const now = new Date();
		const midnight = new Date();
		midnight.setUTCHours(24, 0, 0, 0);
		return midnight.getTime() - now.getTime();
	}

	// ─── Quota Snapshot ───────────────────────────────────────────────────────

	getQuotaSnapshot(): QuotaSnapshot {
		this.refillBuckets();
		this.checkRpdReset();

		const rpmUsed = Math.round(this.rpmBucket.capacity - this.rpmBucket.tokens);
		const tpmUsed = Math.round(this.tpmBucket.capacity - this.tpmBucket.tokens);

		const queueByPriority: Record<RequestPriority, number> = {
			INTERACTIVE: this.queue.filter((r) => r.priority === "INTERACTIVE")
				.length,
			BACKGROUND: this.queue.filter((r) => r.priority === "BACKGROUND").length,
			BULK: this.queue.filter((r) => r.priority === "BULK").length,
		};

		return {
			rpm: {
				used: rpmUsed,
				limit: this.config.rpm,
				resetInMs:
					rpmUsed > 0 ? Math.ceil(rpmUsed / this.rpmBucket.refillRate) : 0,
			},
			tpm: {
				used: tpmUsed,
				limit: this.config.tpm,
				resetInMs:
					tpmUsed > 0 ? Math.ceil(tpmUsed / this.tpmBucket.refillRate) : 0,
			},
			rpd: {
				used: this.rpdCount,
				limit: this.config.rpd,
				resetInMs: this.msUntilMidnightUTC(),
			},
			queueDepth: this.queue.length,
			queueByPriority,
		};
	}

	getMetrics() {
		return {
			totalRequests: this.totalRequests,
			totalRetries: this.totalRetries,
			avgQueueWaitMs:
				this.totalRequests > 0
					? Math.round(this.totalQueueWaitMs / this.totalRequests)
					: 0,
		};
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}

export const rateLimiter = new GeminiRateLimiter();
