/**
 * A.L.A.N. Server
 * Express HTTP + WebSocket, localhost ONLY.
 * Session tokens rotated on every restart.
 * No 0.0.0.0 binding. No query-parameter tokens.
 */

import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import helmet from "helmet";
import cors from "cors";
import { EventEmitter } from "events";
import { vault } from "../vault/vault.js";
import { AlanAgent } from "../agent/agent.js";
import { rateLimiter } from "../llm/rate-limiter.js";
import { taskEngine } from "../tasks/task-engine.js";
import { memoryEngine } from "../memory/memory-engine.js";
import {
	skillRegistry,
	registerBuiltinSkills,
} from "../skills/skill-system.js";

const HOST = "127.0.0.1"; // NEVER 0.0.0.0
const PORT = parseInt(process.env.ALAN_PORT ?? "7432");

// Generate a session token on every restart
const SESSION_TOKEN = crypto.randomUUID().replace(/-/g, "");

interface WSClient {
	ws: WebSocket;
	sessionId: string;
	authenticated: boolean;
	lastActivity: number;
}

export async function startServer(): Promise<void> {
	const app = express();
	const eventBus = new EventEmitter();
	const agent = new AlanAgent(eventBus);

	// ─── Security Middleware ───────────────────────────────────────────────────

	app.use(
		helmet({
			contentSecurityPolicy: {
				directives: {
					defaultSrc: ["'self'"],
					scriptSrc: ["'self'"],
					connectSrc: ["'self'", "ws://127.0.0.1:7432"],
					imgSrc: ["'self'", "data:"],
					styleSrc: ["'self'", "'unsafe-inline'"],
				},
			},
		}),
	);

	app.use(
		cors({
			origin: [
				`http://127.0.0.1:${PORT}`,
				`http://localhost:${PORT}`,
				`http://127.0.0.1:5173`,
				`http://localhost:5173`,
			],
			credentials: true,
		}),
	);

	app.use(express.json({ limit: "1mb" }));

	// Bind to 127.0.0.1 ONLY — enforced at server level too
	app.use((req, _res, next) => {
		const remoteAddr = req.socket.remoteAddress;
		if (remoteAddr !== "127.0.0.1" && remoteAddr !== "::1") {
			console.warn(
				`[Security] Rejected connection from non-local address: ${remoteAddr}`,
			);
			_res.status(403).json({ error: "ALAN only accepts local connections" });
			return;
		}
		next();
	});

	// ─── REST API ──────────────────────────────────────────────────────────────

	// Vault status (no auth required — public info only)
	app.get("/api/status", (_req, res) => {
		res.json({
			initialized: vault.isInitialized,
			unlocked: vault.isUnlocked,
			version: "1.0.0",
		});
	});

	// Vault setup (first run)
	app.post("/api/vault/setup", async (req, res) => {
		try {
			if (vault.isInitialized) {
				res.status(400).json({ error: "Vault already initialized" });
				return;
			}
			const { passphrase, geminiApiKey } = req.body;
			if (!passphrase || passphrase.length < 8) {
				res
					.status(400)
					.json({ error: "Passphrase must be at least 8 characters" });
				return;
			}
			await vault.initialize(passphrase);
			if (geminiApiKey) {
				vault.setSecret(
					"gemini.api_key",
					geminiApiKey,
					"RUNTIME",
					"Gemini API key for LLM calls",
				);
			}
			res.json({ success: true, sessionToken: SESSION_TOKEN });
		} catch (err) {
			res.status(500).json({ error: String(err) });
		}
	});

	// Vault unlock
	app.post("/api/vault/unlock", async (req, res) => {
		try {
			const { passphrase } = req.body;
			const success = await vault.unlock(passphrase);
			if (!success) {
				res.status(401).json({ error: "Invalid passphrase" });
				return;
			}
			res.json({ success: true, sessionToken: SESSION_TOKEN });
		} catch (err) {
			res.status(500).json({ error: String(err) });
		}
	});

	// Auth middleware for protected routes
	const requireAuth = (
		req: express.Request,
		res: express.Response,
		next: express.NextFunction,
	) => {
		const token = req.headers["x-alan-token"];
		if (token !== SESSION_TOKEN) {
			res.status(401).json({ error: "Invalid or missing session token" });
			return;
		}
		if (!vault.isUnlocked) {
			res.status(403).json({ error: "Vault is locked. Please unlock first." });
			return;
		}
		next();
	};

	// Secrets management
	app.get("/api/secrets", requireAuth, (_req, res) => {
		res.json({ secrets: vault.listSecrets() });
	});

	app.post("/api/secrets", requireAuth, (req, res) => {
		try {
			const { name, value, tier, description, scope } = req.body;
			vault.setSecret(name, value, tier, description, scope);
			res.json({ success: true });
		} catch (err) {
			res.status(400).json({ error: String(err) });
		}
	});

	app.delete("/api/secrets/:name", requireAuth, (req, res) => {
		vault.deleteSecret(req.params.name);
		res.json({ success: true });
	});

	// Quota
	app.get("/api/quota", requireAuth, (_req, res) => {
		res.json(rateLimiter.getQuotaSnapshot());
	});

	// Tasks
	app.get("/api/tasks", requireAuth, (_req, res) => {
		res.json({ tasks: taskEngine.getAllTasks() });
	});

	app.delete("/api/tasks/:id", requireAuth, (req, res) => {
		const success = taskEngine.cancel(req.params.id);
		res.json({ success });
	});

	app.post("/api/tasks/:id/confirm", requireAuth, (req, res) => {
		const { approved } = req.body;
		const success = taskEngine.respondToConfirmation(req.params.id, approved);
		res.json({ success });
	});

	// Inline tool confirmations (WRITE/DESTRUCTIVE actions waiting for user approval)
	app.post("/api/confirmations/:id", requireAuth, (req, res) => {
		const { approved } = req.body;
		const success = agent.respondToConfirmation(req.params.id, approved);
		res.json({ success });
	});

	// Memory
	app.get("/api/memory", requireAuth, (_req, res) => {
		res.json({
			memories: memoryEngine.getRecent(50),
			count: memoryEngine.count(),
		});
	});

	app.delete("/api/memory/:id", requireAuth, (req, res) => {
		memoryEngine.delete(req.params.id);
		res.json({ success: true });
	});

	app.delete("/api/memory", requireAuth, (_req, res) => {
		memoryEngine.deleteAll();
		res.json({ success: true });
	});

	// Skills
	app.get("/api/skills", requireAuth, (_req, res) => {
		res.json({ skills: skillRegistry.getManifests() });
	});

	// Audit log
	app.get("/api/audit", requireAuth, (_req, res) => {
		res.json({ log: vault.getAuditLog(100) });
	});

	// Rate limiter tier update
	app.post("/api/settings/rate-limit-tier", requireAuth, (req, res) => {
		const { tier } = req.body;
		if (tier === "paid") rateLimiter.usePaidTier();
		res.json({ success: true });
	});

	// ─── WebSocket Server ─────────────────────────────────────────────────────

	const httpServer = createServer(app);
	const wss = new WebSocketServer({ server: httpServer });
	const clients = new Map<string, WSClient>();

	wss.on("connection", (ws, req) => {
		const remoteAddr = req.socket.remoteAddress;
		if (remoteAddr !== "127.0.0.1" && remoteAddr !== "::1") {
			ws.close(1008, "Only local connections allowed");
			return;
		}

		const clientId = crypto.randomUUID();
		const sessionId = crypto.randomUUID();

		const client: WSClient = {
			ws,
			sessionId,
			authenticated: false,
			lastActivity: Date.now(),
		};
		clients.set(clientId, client);

		const send = (type: string, data: unknown) => {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({ type, data, ts: Date.now() }));
			}
		};

		send("connected", { clientId, sessionId, requiresAuth: true });

		ws.on("message", async (raw) => {
			let msg: { type: string; token?: string; data?: unknown };
			try {
				msg = JSON.parse(raw.toString());
			} catch {
				send("error", { message: "Invalid JSON" });
				return;
			}

			client.lastActivity = Date.now();

			// Auth handshake
			if (msg.type === "auth") {
				if (msg.token === SESSION_TOKEN && vault.isUnlocked) {
					client.authenticated = true;
					send("auth:success", { sessionId });
				} else {
					send("auth:failed", { message: "Invalid token or vault locked" });
					ws.close(1008, "Authentication failed");
				}
				return;
			}

			if (!client.authenticated) {
				send("error", { message: "Not authenticated" });
				return;
			}

			// Chat message
			if (msg.type === "chat") {
				const { content } = msg.data as { content: string };
				if (!content?.trim()) return;

				try {
					send("chat:thinking", { sessionId: client.sessionId });
					const response = await agent.chat(client.sessionId, content);

					send("chat:response", {
						message: response.message,
						backgroundTaskId: response.backgroundTaskId,
						quotaWarning: response.quotaWarning,
					});
				} catch (err) {
					send("chat:error", { message: String(err) });
				}
				return;
			}

			// Task confirmation
			if (msg.type === "task:confirm") {
				const { taskId, approved } = msg.data as {
					taskId: string;
					approved: boolean;
				};
				agent.confirmTaskAction(taskId, approved);
				send("task:confirmed", { taskId, approved });
				return;
			}

			// Inline tool confirmation response
			if (msg.type === "confirmation:respond") {
				const { confirmationId, approved } = msg.data as {
					confirmationId: string;
					approved: boolean;
				};
				agent.respondToConfirmation(confirmationId, approved);
				return;
			}

			// Task cancel
			if (msg.type === "task:cancel") {
				const { taskId } = msg.data as { taskId: string };
				agent.cancelTask(taskId);
				return;
			}
		});

		ws.on("close", () => {
			clients.delete(clientId);
		});

		ws.on("error", () => {
			clients.delete(clientId);
		});
	});

	// Broadcast task updates to all authenticated clients
	eventBus.on("agent:task_update", (update) => {
		for (const client of clients.values()) {
			if (client.authenticated && client.ws.readyState === WebSocket.OPEN) {
				client.ws.send(
					JSON.stringify({ type: "task:update", data: update, ts: Date.now() }),
				);
			}
		}
	});

	// Broadcast confirmation requests — route to the correct session
	eventBus.on("agent:confirmation_required", (payload) => {
		for (const client of clients.values()) {
			if (
				client.authenticated &&
				client.sessionId === payload.sessionId &&
				client.ws.readyState === WebSocket.OPEN
			) {
				client.ws.send(
					JSON.stringify({
						type: "confirmation:required",
						data: payload,
						ts: Date.now(),
					}),
				);
			}
		}
	});

	// Idle client cleanup
	setInterval(
		() => {
			const now = Date.now();
			for (const [id, client] of clients) {
				if (now - client.lastActivity > 30 * 60 * 1000) {
					// 30 min idle
					client.ws.close(1000, "Idle timeout");
					clients.delete(id);
				}
			}
		},
		5 * 60 * 1000,
	);

	// ─── Start ─────────────────────────────────────────────────────────────────

	registerBuiltinSkills();

	httpServer.listen(PORT, HOST, () => {
		console.log(`
╔═══════════════════════════════════════╗
║         A.L.A.N. is running           ║
║                                       ║
║  URL:   http://${HOST}:${PORT}         ║
║  Mode:  localhost-only (secure)       ║
║                                       ║
║  Vault: ${vault.isUnlocked ? "🔓 Unlocked" : "🔒 Locked — run setup"}          ║
╚═══════════════════════════════════════╝
    `);
	});
}
