# A.L.A.N.

### Autonomous Local Assistant Node · v2.1.0

A production-grade, security-hardened local AI engineer powered by Google Gemini. Reads any file on your machine, writes exclusively to a sandboxed workspace, executes terminal commands, manages background processes, and autonomously builds full applications end-to-end.

Originally built as a direct improvement over OpenClaw/ClawdBot, fixing every documented security flaw.

---

## What's new in v2 (this release)

### Agent Runtime — complete rewrite

| v1                                   | v2                                                   |
| ------------------------------------ | ---------------------------------------------------- |
| Flat `while` loop, max 5 tool rounds | Graph state machine, max 8 tool rounds               |
| No planning — reacts directly        | Plan→Execute: decomposes complex goals before acting |
| No self-evaluation                   | Reflection pass after every response                 |
| Regex-only memory trigger            | Extended auto-memorize patterns                      |
| No observability                     | Full per-run trace: every state, tool, and duration  |
| Single system prompt                 | Autonomous coding instructions, workspace awareness  |

### New skills (7 → 4 new, 35 total actions)

| Skill                 | Actions | Write boundary                                                                       |
| --------------------- | ------- | ------------------------------------------------------------------------------------ |
| **Filesystem**        | 11      | Read anywhere · Write workspace only (hard path check)                               |
| **Shell**             | 3       | Safe commands auto-proceed · Dangerous commands confirmed · 10 hard-blocked patterns |
| **Code Intelligence** | 7       | Scaffold, generate, patch, test, fix, explain, install                               |
| **Process Manager**   | 5       | Start/stop/restart/list/logs for background processes                                |

### Frontend — Workspace view added

- Live file tree of `~/.alan/workspace/main`
- Running process monitor with one-click stop
- Quick-action buttons (scaffold React/Node/Python/Express)
- Installed skills dashboard
- Real-time graph state indicator in header (PLANNING → THINKING → CALLING_TOOL → REFLECTING)
- Per-message trace panel (collapsible, shows every step + ms durations)
- Plan badge on messages that triggered the planner

---

## Quick Start

### Prerequisites

- Node.js 20+
- Gemini API key — [aistudio.google.com/apikey](https://aistudio.google.com/apikey)

### Install & run

```bash
# Backend
cd ALAN && npm install
npm run dev

# Frontend (separate terminal)
cd ALAN/ui && npm install
npm run dev
```

Open **http://127.0.0.1:5173**

**First run:** set master passphrase → enter Gemini API key → done.  
**Subsequent runs:** enter passphrase only.

---

## File Structure

```
ALAN/
├── README.md
├── package.json
├── tsconfig.json
│
├── src/
│   ├── main.ts                          Entry point
│   │
│   ├── agent/
│   │   ├── agent.ts                     Main orchestrator — v2 rewrite
│   │   ├── graph.ts                     NEW — graph state machine + per-run trace
│   │   ├── planner.ts                   NEW — Plan→Execute decomposition
│   │   └── reflector.ts                 NEW — post-response quality reflection
│   │
│   ├── llm/
│   │   ├── gemini-client.ts             Gemini API — native function calling
│   │   └── rate-limiter.ts              4-dimension token bucket (RPM/TPM/RPD/IPM)
│   │
│   ├── memory/
│   │   └── memory-engine.ts             SQLite FTS5 persistent memory
│   │
│   ├── server/
│   │   └── index.ts                     Express + WebSocket (localhost-only)
│   │
│   ├── skills/
│   │   ├── skill-system.ts              Registry + v1 built-ins (file-search, web-search, memory)
│   │   ├── filesystem-skill.ts          NEW — read anywhere, write workspace only
│   │   ├── shell-skill.ts               NEW — terminal command execution
│   │   ├── code-skill.ts                NEW — scaffold, generate, patch, test, fix
│   │   └── process-skill.ts             NEW — background process manager
│   │
│   ├── tasks/
│   │   └── task-engine.ts               Non-blocking background task engine (SQLite)
│   │
│   └── vault/
│       └── vault.ts                     AES-256-GCM encrypted secret store
│
└── ui/
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
        └── App.tsx                      Dashboard — chat, workspace, tasks, memory,
                                         secrets, audit, settings
```

### Runtime data (written to `~/.alan/`, never committed)

```
~/.alan/
├── vault.db                 AES-256-GCM encrypted secrets
├── tasks.db                 Task queue + history (SQLite)
├── memory.db                FTS5 full-text memories (SQLite)
└── workspace/
    └── main/                ALL AI writes go here
        └── (your projects)  scaffolded apps, generated code, patches
```

---

## Security Model

### Secret Vault

- **AES-256-GCM** encryption, SQLite at `~/.alan/vault.db`
- **Argon2id** key derivation — 64MB memory, 3 iterations, 4 threads
- **Secret tiers:** `RUNTIME` (auto-injected) / `SKILL` (scope-locked) / `ADMIN` (manual only)
- **Memory zeroing** — master key buffer zeroed on vault lock
- **Immutable audit log** — every access (including denied) recorded

### Network Hardening

- Binds to `127.0.0.1` only — enforced at both `listen()` and middleware level
- CORS locked to localhost origins
- WebSocket non-local connections closed immediately (code 1008)
- Session tokens regenerated on every restart via `crypto.randomUUID()`

### Filesystem Boundary

The write boundary is enforced in code, not by prompt trust.

Every write operation calls `assertWriteAllowed()` which does:

```typescript
const abs = resolve(target); // follows symlinks
if (!abs.startsWith(WORKSPACE_ROOT + "/") && abs !== WORKSPACE_ROOT) {
	throw new Error(`Write blocked: outside workspace`);
}
```

This means symlink traversal and `../` path games are blocked — `resolve()` normalises the path before the check.

### Shell Safety

Two execution tiers:

- **`run_safe` (READ)** — only commands whose base name is in the `SAFE_COMMANDS` allowlist run without confirmation: `node`, `npm`, `npx`, `git`, `python`, `tsc`, `jest`, `ls`, `grep`, `curl`, `make`, and ~30 others
- **`run` (DESTRUCTIVE)** — any other command goes through the confirmation banner

Both tiers go through `HARDBLOCKED` pattern matching first. The following patterns are **never executed** regardless of user confirmation:

```
rm -rf /          fork bombs :(){ ... }     mkfs.*
dd if=.*of=/dev/  chmod -R 777 /            >/dev/sd*
shutdown/reboot   passwd root               iptables -F
```

---

## Agent Runtime — Architecture

### Graph State Machine

Every `chat()` call creates an `AgentGraph` instance that records every state transition with a label and millisecond duration. The completed trace is attached to the response message and rendered as a collapsible panel in the UI.

```
IDLE → PLANNING → THINKING → CALLING_TOOL → REFLECTING → DONE
                      ↓              ↓
              AWAITING_CONFIRMATION ←┘ (on WRITE/DESTRUCTIVE tools)
                      ↓
              CALLING_TOOL (if approved) | THINKING (if denied)
```

### ReAct Reasoning

Before each tool call, Gemini produces a brief thought (1-2 sentences) explaining its reasoning. Tool results become observations. The thought → action → observation cycle repeats up to 8 rounds.

### Plan → Execute

`shouldPlan()` fires when the message is over 15 words or contains sequential keywords (`then`, `after that`, `first...then`, `followed by`, `step by step`, etc.). When triggered, a dedicated low-temperature Gemini call decomposes the goal into a typed `StepPlan` with ordered steps and tool hints before the main loop begins.

### Reflection

After producing a final text response, a second low-temperature Gemini call evaluates whether the response fully addressed the goal. If confidence exceeds 0.4 and a gap is found, the gap note appears below the message in the UI. For WRITE/DESTRUCTIVE actions, a safety check runs regardless.

### Autonomous Coding Workflow

For complex coding requests, ALAN chains tools automatically:

```
1. code__scaffold        — create project structure + install deps
2. filesystem__write_file — write each component / module
3. shell__run_safe        — npm install, git init, build checks
4. code__run_tests        — verify correctness
5. code__fix_errors       — if tests fail: read file + error → Gemini fix → write back → repeat
6. process__start         — launch dev server
```

---

## Skills Reference

### Filesystem (`filesystem__*`)

| Action           | Tier        | Description                                              |
| ---------------- | ----------- | -------------------------------------------------------- |
| `read_file`      | READ        | Read any text file. Truncates at 40,000 chars by default |
| `list_dir`       | READ        | Recursive directory listing with sizes, up to depth 4    |
| `file_info`      | READ        | Metadata: size, modified date, type, is-text             |
| `search_files`   | READ        | Search by filename or content substring                  |
| `workspace_tree` | READ        | Full tree of `~/.alan/workspace/main`                    |
| `write_file`     | WRITE       | Create or overwrite a file in workspace                  |
| `append_file`    | WRITE       | Append to an existing workspace file                     |
| `create_dir`     | WRITE       | Create directory (recursive) in workspace                |
| `move_file`      | WRITE       | Move/rename within workspace                             |
| `copy_file`      | WRITE       | Copy from anywhere into workspace                        |
| `delete_file`    | DESTRUCTIVE | Delete a workspace file                                  |

### Shell (`shell__*`)

| Action         | Tier        | Description                                                    |
| -------------- | ----------- | -------------------------------------------------------------- |
| `run_safe`     | READ        | Allowlisted commands only (node, npm, git, python, grep, etc.) |
| `run`          | DESTRUCTIVE | Any command — hard-blocked patterns still refused              |
| `kill_process` | DESTRUCTIVE | Kill a background PID with SIGTERM                             |

Default working directory: `~/.alan/workspace/main`. Timeout: 30s (max 300s). Output cap: 10MB.

### Code Intelligence (`code__*`)

| Action          | Tier  | Description                                                                  |
| --------------- | ----- | ---------------------------------------------------------------------------- |
| `scaffold`      | WRITE | Create full project from template (node-ts, react-vite, python, express-api) |
| `generate_code` | WRITE | Gemini writes code to spec → saves directly to workspace file                |
| `patch_file`    | WRITE | Search-and-replace targeted edit (safer than full rewrites)                  |
| `install_deps`  | WRITE | npm / pip / yarn / pnpm install                                              |
| `run_tests`     | READ  | Run test suite, parse pass/fail counts                                       |
| `explain_code`  | READ  | Line-by-line explanation with Gemini                                         |
| `fix_errors`    | WRITE | Read file + error output → Gemini fix → write back                           |

### Process Manager (`process__*`)

| Action    | Tier        | Description                                           |
| --------- | ----------- | ----------------------------------------------------- |
| `start`   | DESTRUCTIVE | Spawn named background process, capture stdout/stderr |
| `stop`    | DESTRUCTIVE | SIGTERM a named process (SIGKILL after 3s)            |
| `restart` | DESTRUCTIVE | Stop then start                                       |
| `list`    | READ        | All managed processes with status, PID, uptime        |
| `logs`    | READ        | Last N lines of stdout/stderr for a named process     |

Processes are tracked in an in-memory map with a 200-line ring buffer per stream.

---

## Gemini Rate Limiting

Tracks all four Gemini quota dimensions with token buckets:

| Dimension | Free Tier | Paid Tier 1 |
| --------- | --------- | ----------- |
| RPM       | 15        | 150         |
| TPM       | 1,000,000 | 4,000,000   |
| RPD       | 1,500     | 10,000      |
| IPM       | 10        | 100         |

**Priority queue:** `INTERACTIVE` (chat) > `BACKGROUND` (tasks) > `BULK`

On 429: exponential backoff with full jitter — `min(30s, 2ⁿ × random)` — up to 5 retries.

---

## REST API

All endpoints except `/api/status`, `/api/vault/setup`, `/api/vault/unlock` require `x-alan-token`.

| Method | Endpoint                        | Description                             |
| ------ | ------------------------------- | --------------------------------------- |
| GET    | `/api/status`                   | Vault initialized/unlocked              |
| POST   | `/api/vault/setup`              | First-run initialization                |
| POST   | `/api/vault/unlock`             | Unlock vault, get session token         |
| GET    | `/api/secrets`                  | List secret metadata (never values)     |
| POST   | `/api/secrets`                  | Add/update secret                       |
| DELETE | `/api/secrets/:name`            | Delete secret                           |
| GET    | `/api/tasks`                    | All tasks                               |
| DELETE | `/api/tasks/:id`                | Cancel task                             |
| POST   | `/api/tasks/:id/confirm`        | Approve/deny background task action     |
| POST   | `/api/confirmations/:id`        | Approve/deny inline tool action         |
| GET    | `/api/memory`                   | Recent memories                         |
| DELETE | `/api/memory/:id`               | Delete one memory                       |
| DELETE | `/api/memory`                   | Clear all memories                      |
| GET    | `/api/skills`                   | Registered skill manifests              |
| GET    | `/api/quota`                    | Live Gemini quota snapshot              |
| GET    | `/api/audit`                    | Vault audit log (last 100 entries)      |
| GET    | `/api/workspace`                | Workspace file tree + running processes |
| POST   | `/api/settings/rate-limit-tier` | Switch to paid tier limits              |

---

## WebSocket Protocol

Connect to `ws://127.0.0.1:7432`, authenticate immediately:

```json
{ "type": "auth", "token": "<session_token>" }
```

**Server → Client:**

| Type                    | Description                                                        |
| ----------------------- | ------------------------------------------------------------------ |
| `auth:success`          | Authenticated                                                      |
| `chat:thinking`         | Agent processing                                                   |
| `chat:response`         | Agent reply with optional `trace`, `plan`, `reflectionGap`         |
| `chat:error`            | Error                                                              |
| `task:update`           | Task progress/status                                               |
| `confirmation:required` | WRITE/DESTRUCTIVE tool awaiting approval                           |
| `agent:state`           | Graph state transition (PLANNING/THINKING/CALLING_TOOL/REFLECTING) |

**Client → Server:**

| Type                   | Payload                                 |
| ---------------------- | --------------------------------------- |
| `chat`                 | `{ content: string }`                   |
| `task:confirm`         | `{ taskId, approved: boolean }`         |
| `task:cancel`          | `{ taskId }`                            |
| `confirmation:respond` | `{ confirmationId, approved: boolean }` |

---

## Tech Stack

| Layer            | Technology                                        |
| ---------------- | ------------------------------------------------- |
| Backend          | Node.js 20 + TypeScript 5                         |
| LLM              | Google Gemini 2.5 Flash (`@google/generative-ai`) |
| Secret vault     | `better-sqlite3` + Node.js `crypto` (AES-256-GCM) |
| Key derivation   | `argon2` (Argon2id)                               |
| Task persistence | SQLite via `better-sqlite3`                       |
| HTTP server      | Express 4 + `helmet` + `cors`                     |
| WebSocket        | `ws`                                              |
| Frontend         | React 18 + Vite 5 + Tailwind CSS 3                |
| Icons            | `lucide-react`                                    |
