# A.L.A.N.

### Autonomous Local Assistant Node

A production-grade, security-hardened local AI assistant powered by Google Gemini. Built as a direct improvement over OpenClaw/ClawdBot, fixing every documented security flaw while adding a proper autonomous task engine.

---

## Why ALAN Exists

OpenClaw's documented failures became ALAN's design requirements:

| OpenClaw Problem                                     | ALAN Solution                                                                     |
| ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| Secrets stored in plaintext `~/.clawdbot/.env`       | AES-256-GCM encrypted SQLite vault, Argon2id KDF                                  |
| Bound to `0.0.0.0` — accessible from the internet    | Hardcoded `127.0.0.1` binding, refused at connection level                        |
| Session tokens passable via query string             | Tokens only via `x-alan-token` header or WS auth frame                            |
| Skills could read any secret in the environment      | Secrets are scoped per-skill — cross-skill reads throw and are audit-logged       |
| Agent took autonomous actions without user awareness | Three-tier confirmation model enforced in code, not left to LLM judgment          |
| No task tracking — long operations blocked the agent | Non-blocking async task engine with progress, pause, cancel, and restart recovery |

---

## Quick Start

### Prerequisites

- Node.js 20+
- A Gemini API key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey)

### 2. Install backend dependencies

```bash
cd ALAN
npm install
```

### 2. Install UI dependencies

```bash
cd ALAN/ui
npm install
```

### 3. Start the backend (Terminal 1)

```bash
cd ALAN
npm run dev
```

You should see:

```
╔═══════════════════════════════════════╗
║         A.L.A.N. is running           ║
║  URL:   http://127.0.0.1:7432         ║
║  Mode:  localhost-only (secure)       ║
╚═══════════════════════════════════════╝
```

### 4. Start the UI (Terminal 2)

```bash
cd ALAN/ui
npm run dev
```

### 5. Open in browser

```
http://127.0.0.1:5173
```

### 6. First-run setup

On first visit you will be prompted to:

1. Set a **master passphrase** (minimum 8 characters) — this encrypts your vault with Argon2id
2. Enter your **Gemini API key** — stored encrypted immediately, never written to disk in plaintext

On subsequent starts, enter your passphrase to unlock the vault. If you delete your Gemini key from the Secrets tab, re-add it with the name `gemini.api_key` and tier `RUNTIME`.

---

## File Structure

```
ALAN/
├── README.md
├── package.json
├── tsconfig.json
│
├── src/                          Backend — Node.js + TypeScript
│   ├── main.ts                   Entry point
│   ├── vault/
│   │   └── vault.ts              AES-256-GCM encrypted secret store
│   ├── llm/
│   │   ├── gemini-client.ts      Gemini API with native function calling
│   │   └── rate-limiter.ts       4-dimension token bucket queue (RPM/TPM/RPD/IPM)
│   ├── tasks/
│   │   └── task-engine.ts        Non-blocking background task engine
│   ├── memory/
│   │   └── memory-engine.ts      SQLite FTS5 persistent memory
│   ├── skills/
│   │   └── skill-system.ts       Sandboxed skill registry + built-in skills
│   ├── agent/
│   │   └── agent.ts              Main orchestrator — tool loop + tier enforcement
│   └── server/
│       └── index.ts              Express + WebSocket server (localhost-only)
│
└── ui/                           Frontend — React 18 + Vite + Tailwind
    ├── index.html
    ├── package.json
    ├── vite.config.ts
    ├── tailwind.config.js
    ├── postcss.config.js
    ├── tsconfig.json
    ├── tsconfig.node.json
    └── src/
        ├── main.tsx
        ├── index.css
        └── App.tsx               Full dashboard: chat, tasks, memory, secrets, audit, settings
```

### Runtime data (written to `~/.alan/`, never committed)

```
~/.alan/
├── vault.db     Encrypted secrets (AES-256-GCM)
├── tasks.db     Task queue and history (survives restarts)
└── memory.db    FTS5 full-text searchable memories
```

---

## Security Model

### Secret Vault

All credentials are stored in an AES-256-GCM encrypted SQLite database at `~/.alan/vault.db`.

- **Key derivation**: Argon2id — 64MB memory cost, 3 iterations, 4 threads. Brute-forcing the passphrase against the vault file is computationally prohibitive.
- **No plaintext ever**: API keys are injected directly into the encrypted vault at setup. They never appear in `.env` files, shell history, or log output.
- **Secret tiers**:
  - `RUNTIME` — automatically injected on every LLM call (e.g. `gemini.api_key`)
  - `SKILL` — scoped to one specific skill; another skill attempting to read it throws an exception and creates an audit log entry
  - `ADMIN` — only accessible via explicit vault unlock UI; never readable by the agent
- **Memory zeroing**: The master key `Buffer` is explicitly zeroed on vault lock via `buf.fill(0)`
- **Audit log**: Every secret read, write, delete, and denied access attempt is recorded immutably

### Network Hardening

- Server binds to `127.0.0.1` only — enforced in both `listen()` and a middleware check on every request
- CORS locked to `localhost` origins only
- WebSocket connections from non-local IPs are immediately closed with code 1008
- Session tokens are generated fresh on every server restart with `crypto.randomUUID()`
- Tokens transmitted via `x-alan-token` header (HTTP) or auth frame (WebSocket) — never via query parameters

---

## Action Tier System

Every skill action declares a tier in its manifest. The agent enforces this **in code** — the LLM cannot bypass it by saying the right words.

| Tier             | Examples                                              | Behaviour                                                         |
| ---------------- | ----------------------------------------------------- | ----------------------------------------------------------------- |
| 🟢 `READ`        | Search files, web search, recall memory               | Executes immediately, zero friction                               |
| 🟡 `WRITE`       | Store memory, send email draft, create calendar event | Agent loop pauses — approval banner appears in chat               |
| 🔴 `DESTRUCTIVE` | Delete files, run shell commands, post publicly       | Agent loop pauses — red warning banner with full parameter detail |

When a WRITE or DESTRUCTIVE action is required, ALAN emits a `confirmation:required` WebSocket event. An inline banner appears in the chat thread with the full action description and parameter values. The user clicks **Approve** or **Deny**. Unanswered confirmations auto-deny after 5 minutes.

---

## Tool Execution Loop

ALAN uses Gemini's native `FunctionDeclaration` function calling — not text heuristics.

```
User message
     ↓
Gemini (all registered skill tools passed as FunctionDeclarations)
     ↓
toolCalls[] in response?
  ├── Yes → for each call:
  │           READ        → execute immediately, no prompt
  │           WRITE       → pause → await user confirm → execute or skip
  │           DESTRUCTIVE → pause → await user confirm → execute or skip
  │         → send all results back to Gemini via functionResponse
  │         → repeat (max 5 rounds to prevent infinite loops)
  └── No  → return final text response to user
```

---

## Background Task Engine

Tasks that are expected to take more than a few seconds are dispatched to the non-blocking task engine. The main agent thread returns a response immediately.

**Task lifecycle:**

```
submit() → PENDING → RUNNING → COMPLETED
                   ↘ AWAITING_CONFIRMATION  (WRITE action needed mid-task)
                   ↘ FAILED
                   ↘ CANCELLED
```

- Tasks are written to SQLite before dispatch — ALAN resumes interrupted tasks on restart
- Up to 4 concurrent tasks (configurable in `TaskEngine` constructor)
- Each task reports progress 0–100% with optional status messages
- A background task that hits a WRITE/DESTRUCTIVE action pauses and notifies you — it never acts silently
- Any task can be cancelled from the Tasks tab; the worker receives an abort signal immediately

---

## Gemini Rate Limiting

ALAN tracks all four Gemini quota dimensions simultaneously using token buckets that refill continuously.

| Dimension               | Free Tier | Paid Tier 1 |
| ----------------------- | --------- | ----------- |
| RPM (requests / minute) | 15        | 150         |
| TPM (tokens / minute)   | 1,000,000 | 4,000,000   |
| RPD (requests / day)    | 1,500     | 10,000      |
| IPM (images / minute)   | 10        | 100         |

**Priority queue** — all requests enter a priority queue before executing:

- `INTERACTIVE` — your chat messages; highest priority, gracefully rejects with a wait estimate if delay > 2s
- `BACKGROUND` — autonomous tasks; queued and spread across available quota
- `BULK` — large file or batch analysis; uses leftover TPM budget only

**On 429 errors**: exponential backoff with full jitter — `min(30s, 1s × 2ⁿ) × random(0,1)` — up to 5 retries before surfacing to the user.

The sidebar shows live RPM and RPD bars. Full quota detail is in Settings. To switch to paid tier limits: **Settings → Gemini Quota → Switch to Paid Tier limits**.

---

## Built-in Skills

| Skill         | Action         | Tier  | Notes                                                                         |
| ------------- | -------------- | ----- | ----------------------------------------------------------------------------- |
| `file-search` | `search_files` | READ  | Recursive directory walk, 3 levels deep, 50 result cap                        |
| `file-search` | `read_file`    | READ  | Text files only (.txt, .md, .json, .ts, .py, etc.), truncates at 10,000 chars |
| `web-search`  | `search`       | READ  | DuckDuckGo instant answers — no API key required                              |
| `memory`      | `remember`     | WRITE | Stores tagged memory; triggers confirmation banner                            |
| `memory`      | `recall`       | READ  | FTS5 full-text search across all stored memories                              |

---

## Memory

Memories are stored in SQLite with FTS5 full-text search indexing. Tags:

`work` · `personal` · `project` · `preference` · `fact` · `task` · `context`

The agent automatically stores notable user statements (preferences, personal facts) and injects the most relevant memories as context on every message. The Memory tab lets you view, edit, or delete any individual memory, or clear everything at once.

---

## Adding Custom Skills

```typescript
import { type Skill, skillRegistry } from "./src/skills/skill-system.js";
import { taskEngine } from "./src/tasks/task-engine.js";

const mySkill: Skill = {
	manifest: {
		id: "my-skill",
		name: "My Skill",
		version: "1.0.0",
		description: "What this skill does",
		author: "Your Name",
		permissions: [
			{
				type: "network",
				scope: "api.example.com",
				description: "Calls Example API",
			},
		],
		secrets: [
			{
				name: "my-skill.api_key",
				description: "Example API key",
				required: true,
			},
		],
		actions: [
			{
				id: "do_thing",
				name: "Do Thing",
				description: "Does the thing",
				tier: "READ", // READ | WRITE | DESTRUCTIVE
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
		return this.manifest.actions.map((a) => ({
			name: `${this.manifest.id}__${a.id}`,
			description: `[${a.tier}] ${a.description}`,
			parameters: {
				type: "object" as const,
				properties: { query: { type: "string", description: "Search query" } },
				required: ["query"],
			},
		}));
	},

	async execute(actionId, params) {
		const { vault } = await import("./src/vault/vault.js");
		// Secret is scope-locked to 'my-skill' — other skills cannot read it
		const apiKey = vault.getSecret("my-skill.api_key", "my-skill");
		// ... do work
		return { result: "..." };
	},
};

// Register skill
skillRegistry.register(mySkill);

// Register background executor (so tasks can run non-blocking)
taskEngine.registerExecutor("my-skill", async (task, helpers) => {
	helpers.progress(10, "Starting...");
	const { actionId, ...params } = task.params as { actionId: string } & Record<
		string,
		unknown
	>;
	helpers.progress(50, "Processing...");
	const result = await mySkill.execute(actionId, params);
	helpers.progress(100);
	return result;
});
```

---

## REST API Reference

All endpoints except `/api/status`, `/api/vault/setup`, and `/api/vault/unlock` require the `x-alan-token` header.

| Method | Endpoint                        | Description                                                        |
| ------ | ------------------------------- | ------------------------------------------------------------------ |
| GET    | `/api/status`                   | Vault initialized/unlocked status                                  |
| POST   | `/api/vault/setup`              | First-run initialization — sets passphrase and optional Gemini key |
| POST   | `/api/vault/unlock`             | Unlock vault, returns session token                                |
| GET    | `/api/secrets`                  | List secret metadata (names, tiers, descriptions — never values)   |
| POST   | `/api/secrets`                  | Add or update a secret                                             |
| DELETE | `/api/secrets/:name`            | Delete a secret                                                    |
| GET    | `/api/tasks`                    | List all tasks (active + history)                                  |
| DELETE | `/api/tasks/:id`                | Cancel a task                                                      |
| POST   | `/api/tasks/:id/confirm`        | Approve/deny a background task's pending action                    |
| POST   | `/api/confirmations/:id`        | Approve/deny an inline agent tool confirmation                     |
| GET    | `/api/memory`                   | List recent memories (last 50)                                     |
| DELETE | `/api/memory/:id`               | Delete one memory                                                  |
| DELETE | `/api/memory`                   | Clear all memories                                                 |
| GET    | `/api/skills`                   | List registered skill manifests                                    |
| GET    | `/api/quota`                    | Live Gemini quota snapshot (RPM/TPM/RPD/IPM)                       |
| GET    | `/api/audit`                    | Vault audit log (last 100 entries)                                 |
| POST   | `/api/settings/rate-limit-tier` | Switch quota to `paid` tier limits                                 |

---

## WebSocket Protocol

Connect to `ws://127.0.0.1:7432`. Send auth immediately after connect:

```json
{ "type": "auth", "token": "<session_token>" }
```

**Server → Client events:**

| Type                    | Payload                                                   | Description                                |
| ----------------------- | --------------------------------------------------------- | ------------------------------------------ |
| `auth:success`          | `{ sessionId }`                                           | Authentication accepted                    |
| `auth:failed`           | `{ message }`                                             | Bad token or locked vault                  |
| `chat:thinking`         | —                                                         | Agent is processing                        |
| `chat:response`         | `{ message, quotaWarning? }`                              | Agent reply                                |
| `chat:error`            | `{ message }`                                             | Processing error                           |
| `task:update`           | `{ taskId, type, message, data }`                         | Task progress/status change                |
| `confirmation:required` | `{ confirmationId, tier, toolName, description, params }` | WRITE/DESTRUCTIVE action awaiting approval |

**Client → Server messages:**

| Type                   | Payload                                 | Description                           |
| ---------------------- | --------------------------------------- | ------------------------------------- |
| `chat`                 | `{ content: string }`                   | Send a user message                   |
| `task:confirm`         | `{ taskId, approved: boolean }`         | Approve/deny a background task action |
| `task:cancel`          | `{ taskId }`                            | Cancel a task                         |
| `confirmation:respond` | `{ confirmationId, approved: boolean }` | Approve/deny an inline tool action    |

---

## Environment Variables

| Variable          | Default | Description                                       |
| ----------------- | ------- | ------------------------------------------------- |
| `ALAN_PORT`       | `7432`  | Backend HTTP/WS port                              |
| `ALAN_PASSPHRASE` | —       | Auto-unlock vault on start (**development only**) |

> **Never set `ALAN_PASSPHRASE` in production.** It exposes your master key in the process environment and shell history. Use the UI unlock flow.

---

## Tech Stack

| Layer            | Technology                                        |
| ---------------- | ------------------------------------------------- |
| Backend runtime  | Node.js 20 + TypeScript 5                         |
| LLM              | Google Gemini 2.5 Flash (`@google/generative-ai`) |
| Secret vault     | `better-sqlite3` + Node.js `crypto` (AES-256-GCM) |
| Key derivation   | `argon2` (Argon2id — memory-hard)                 |
| Task persistence | SQLite via `better-sqlite3`                       |
| HTTP server      | Express 4 + `helmet` + `cors`                     |
| WebSocket        | `ws`                                              |
| Frontend         | React 18 + Vite 5 + Tailwind CSS 3                |
| Icons            | `lucide-react`                                    |
| Font             | JetBrains Mono                                    |
