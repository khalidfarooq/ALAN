/**
 * A.L.A.N. Memory Engine
 * Persistent, searchable memory with full user control.
 * Users can view, edit, and delete any memory.
 * Tagged by context: work, personal, project, preference, fact
 */

import Database from "better-sqlite3";
import { join } from "path";
import { homedir } from "os";

const DB_PATH = join(homedir(), ".alan", "memory.db");

export type MemoryTag =
	| "work"
	| "personal"
	| "project"
	| "preference"
	| "fact"
	| "task"
	| "context";

export interface Memory {
	id: string;
	content: string;
	summary: string;
	tags: MemoryTag[];
	source: "user" | "agent" | "skill";
	importance: number; // 1-5
	createdAt: number;
	accessedAt: number;
	accessCount: number;
}

export interface MemorySearchResult {
	memory: Memory;
	relevanceScore: number;
}

export class MemoryEngine {
	private db: Database.Database;

	constructor() {
		this.db = new Database(DB_PATH);
		this.db.pragma("journal_mode = WAL");
		this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        summary TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL DEFAULT 'agent',
        importance INTEGER NOT NULL DEFAULT 3,
        created_at INTEGER NOT NULL,
        accessed_at INTEGER NOT NULL,
        access_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        id UNINDEXED,
        content,
        summary,
        tags,
        content='memories',
        content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, id, content, summary, tags)
        VALUES (new.rowid, new.id, new.content, new.summary, new.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, id, content, summary, tags)
        VALUES ('delete', old.rowid, old.id, old.content, old.summary, old.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, id, content, summary, tags)
        VALUES ('delete', old.rowid, old.id, old.content, old.summary, old.tags);
        INSERT INTO memories_fts(rowid, id, content, summary, tags)
        VALUES (new.rowid, new.id, new.content, new.summary, new.tags);
      END;
    `);
	}

	store(
		memory: Omit<Memory, "id" | "createdAt" | "accessedAt" | "accessCount">,
	): Memory {
		const now = Date.now();
		const id = crypto.randomUUID();
		const full: Memory = {
			...memory,
			id,
			createdAt: now,
			accessedAt: now,
			accessCount: 0,
		};

		this.db
			.prepare(
				`
      INSERT INTO memories (id, content, summary, tags, source, importance, created_at, accessed_at, access_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
			)
			.run(
				id,
				full.content,
				full.summary,
				JSON.stringify(full.tags),
				full.source,
				full.importance,
				now,
				now,
				0,
			);

		return full;
	}

	search(query: string, limit = 10): MemorySearchResult[] {
		if (!query.trim()) return [];

		try {
			const rows = this.db
				.prepare(
					`
        SELECT m.*, rank
        FROM memories m
        JOIN memories_fts ON m.id = memories_fts.id
        WHERE memories_fts MATCH ?
        ORDER BY rank, m.importance DESC, m.accessed_at DESC
        LIMIT ?
      `,
				)
				.all(query, limit) as Array<Record<string, unknown>>;

			// Update access stats
			const ids = rows.map((r) => r.id as string);
			if (ids.length > 0) {
				this.db
					.prepare(
						`
          UPDATE memories SET accessed_at = ?, access_count = access_count + 1
          WHERE id IN (${ids.map(() => "?").join(",")})
        `,
					)
					.run(Date.now(), ...ids);
			}

			return rows.map((r) => ({
				memory: this.deserialize(r),
				relevanceScore: Math.abs(r.rank as number),
			}));
		} catch {
			return [];
		}
	}

	getRecent(limit = 20): Memory[] {
		const rows = this.db
			.prepare(
				`
      SELECT * FROM memories ORDER BY accessed_at DESC LIMIT ?
    `,
			)
			.all(limit) as Array<Record<string, unknown>>;
		return rows.map((r) => this.deserialize(r));
	}

	getByTags(tags: MemoryTag[], limit = 20): Memory[] {
		const rows = this.db
			.prepare(
				`
      SELECT * FROM memories ORDER BY importance DESC, created_at DESC LIMIT ?
    `,
			)
			.all(limit) as Array<Record<string, unknown>>;

		return rows
			.map((r) => this.deserialize(r))
			.filter((m) => tags.some((t) => m.tags.includes(t)));
	}

	update(
		id: string,
		updates: Partial<
			Pick<Memory, "content" | "summary" | "tags" | "importance">
		>,
	): void {
		const existing = this.getById(id);
		if (!existing) throw new Error(`Memory ${id} not found`);

		const merged = { ...existing, ...updates };
		this.db
			.prepare(
				`
      UPDATE memories SET content = ?, summary = ?, tags = ?, importance = ?
      WHERE id = ?
    `,
			)
			.run(
				merged.content,
				merged.summary,
				JSON.stringify(merged.tags),
				merged.importance,
				id,
			);
	}

	delete(id: string): void {
		this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
	}

	deleteAll(): void {
		this.db.prepare(`DELETE FROM memories`).run();
	}

	getById(id: string): Memory | null {
		const row = this.db
			.prepare(`SELECT * FROM memories WHERE id = ?`)
			.get(id) as Record<string, unknown> | undefined;
		return row ? this.deserialize(row) : null;
	}

	count(): number {
		const result = this.db
			.prepare(`SELECT COUNT(*) as count FROM memories`)
			.get() as { count: number };
		return result.count;
	}

	/**
	 * Get context for LLM — returns most relevant memories for a given query
	 */
	getContextForQuery(query: string, maxTokens = 2000): string {
		const results = this.search(query, 5);
		if (results.length === 0) return "";

		const lines = results.map(
			(r) => `- [${r.memory.tags.join(",")}] ${r.memory.summary}`,
		);
		const context = lines.join("\n");

		// Rough token estimate: 4 chars per token
		return context.length > maxTokens * 4
			? context.substring(0, maxTokens * 4)
			: context;
	}

	private deserialize(row: Record<string, unknown>): Memory {
		return {
			id: row.id as string,
			content: row.content as string,
			summary: row.summary as string,
			tags: JSON.parse(row.tags as string),
			source: row.source as Memory["source"],
			importance: row.importance as number,
			createdAt: row.created_at as number,
			accessedAt: row.accessed_at as number,
			accessCount: row.access_count as number,
		};
	}
}

export const memoryEngine = new MemoryEngine();
