/**
 * A.L.A.N. Secret Vault
 * AES-256-GCM encrypted SQLite storage for all credentials.
 * Secrets are NEVER written to logs, .env files, or memory traces.
 * Master key derived from passphrase using Argon2id (memory-hard KDF).
 */

import Database from "better-sqlite3";
import {
	createCipheriv,
	createDecipheriv,
	randomBytes,
	scryptSync,
} from "crypto";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import argon2 from "argon2";

const VAULT_DIR = join(homedir(), ".alan");
const VAULT_PATH = join(VAULT_DIR, "vault.db");
const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;

export type SecretTier = "RUNTIME" | "SKILL" | "ADMIN";

export interface SecretEntry {
	name: string;
	tier: SecretTier;
	scope?: string; // skill name if tier === 'SKILL'
	description: string;
	createdAt: number;
	updatedAt: number;
}

export class SecretVault {
	private db: Database.Database | null = null;
	private masterKey: Buffer | null = null;
	private unlocked = false;

	constructor() {
		if (!existsSync(VAULT_DIR)) {
			mkdirSync(VAULT_DIR, { mode: 0o700 }); // owner only
		}
	}

	get isUnlocked(): boolean {
		return this.unlocked;
	}

	get isInitialized(): boolean {
		return existsSync(VAULT_PATH);
	}

	/**
	 * Initialize vault with a master passphrase (first run only)
	 */
	async initialize(passphrase: string): Promise<void> {
		if (this.isInitialized)
			throw new Error("Vault already initialized. Use unlock() instead.");

		const salt = randomBytes(SALT_LENGTH);
		const masterKey = await this.deriveKey(passphrase, salt);

		this.db = new Database(VAULT_PATH, { fileMustExist: false });
		this.db.pragma("journal_mode = WAL");
		this.db.pragma("foreign_keys = ON");

		this.db.exec(`
      CREATE TABLE IF NOT EXISTS vault_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS secrets (
        name TEXT PRIMARY KEY,
        tier TEXT NOT NULL CHECK(tier IN ('RUNTIME', 'SKILL', 'ADMIN')),
        scope TEXT,
        description TEXT NOT NULL,
        ciphertext BLOB NOT NULL,
        iv BLOB NOT NULL,
        auth_tag BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT,
        tier TEXT,
        result TEXT NOT NULL,
        details TEXT
      );
    `);

		// Store salt for key derivation on future unlocks
		const saltHex = salt.toString("hex");
		// Store a vault verification token (encrypted "ALAN_VAULT_OK")
		const verificationPlaintext = Buffer.from("ALAN_VAULT_OK");
		const encrypted = this.encryptBuffer(verificationPlaintext, masterKey);

		this.db
			.prepare(`INSERT INTO vault_meta VALUES (?, ?)`)
			.run("salt", saltHex);
		this.db
			.prepare(`INSERT INTO vault_meta VALUES (?, ?)`)
			.run("verify_ct", encrypted.ciphertext.toString("hex"));
		this.db
			.prepare(`INSERT INTO vault_meta VALUES (?, ?)`)
			.run("verify_iv", encrypted.iv.toString("hex"));
		this.db
			.prepare(`INSERT INTO vault_meta VALUES (?, ?)`)
			.run("verify_tag", encrypted.authTag.toString("hex"));

		this.masterKey = masterKey;
		this.unlocked = true;
		console.log("✅ Vault initialized and unlocked");
	}

	/**
	 * Unlock vault with master passphrase
	 */
	async unlock(passphrase: string): Promise<boolean> {
		if (!this.isInitialized)
			throw new Error("Vault not initialized. Run setup first.");

		this.db = new Database(VAULT_PATH, { fileMustExist: true });
		this.db.pragma("journal_mode = WAL");

		const saltHex = this.db
			.prepare(`SELECT value FROM vault_meta WHERE key = 'salt'`)
			.get() as { value: string };
		const salt = Buffer.from(saltHex.value, "hex");
		const masterKey = await this.deriveKey(passphrase, salt);

		// Verify passphrase by decrypting verification token
		try {
			const ct = this.db
				.prepare(`SELECT value FROM vault_meta WHERE key = 'verify_ct'`)
				.get() as { value: string };
			const iv = this.db
				.prepare(`SELECT value FROM vault_meta WHERE key = 'verify_iv'`)
				.get() as { value: string };
			const tag = this.db
				.prepare(`SELECT value FROM vault_meta WHERE key = 'verify_tag'`)
				.get() as { value: string };

			const decrypted = this.decryptBuffer(
				Buffer.from(ct.value, "hex"),
				Buffer.from(iv.value, "hex"),
				Buffer.from(tag.value, "hex"),
				masterKey,
			);

			if (decrypted.toString() !== "ALAN_VAULT_OK") {
				this.lock();
				return false;
			}

			this.masterKey = masterKey;
			this.unlocked = true;
			return true;
		} catch {
			this.lock();
			return false;
		}
	}

	/**
	 * Lock vault and clear master key from memory
	 */
	lock(): void {
		if (this.masterKey) {
			this.masterKey.fill(0); // zero out key bytes
			this.masterKey = null;
		}
		this.unlocked = false;
	}

	/**
	 * Store a secret in the vault
	 */
	setSecret(
		name: string,
		value: string,
		tier: SecretTier,
		description: string,
		scope?: string,
	): void {
		this.assertUnlocked();
		this.validateSecretName(name);

		const now = Date.now();
		const plaintext = Buffer.from(value, "utf8");
		const encrypted = this.encryptBuffer(plaintext, this.masterKey!);

		this.db!.prepare(
			`
      INSERT INTO secrets (name, tier, scope, description, ciphertext, iv, auth_tag, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        tier = excluded.tier,
        scope = excluded.scope,
        description = excluded.description,
        ciphertext = excluded.ciphertext,
        iv = excluded.iv,
        auth_tag = excluded.auth_tag,
        updated_at = excluded.updated_at
    `,
		).run(
			name,
			tier,
			scope ?? null,
			description,
			encrypted.ciphertext,
			encrypted.iv,
			encrypted.authTag,
			now,
			now,
		);

		this.writeAuditLog("VAULT", "SET_SECRET", name, tier, "SUCCESS");
		// NEVER log the value
	}

	/**
	 * Retrieve a secret value. Returns null if not found.
	 * Only use at the moment of injection — do not cache the returned value.
	 */
	getSecret(name: string, requestingScope?: string): string | null {
		this.assertUnlocked();

		const row = this.db!.prepare(
			`
      SELECT ciphertext, iv, auth_tag, tier, scope FROM secrets WHERE name = ?
    `,
		).get(name) as
			| {
					ciphertext: Buffer;
					iv: Buffer;
					auth_tag: Buffer;
					tier: SecretTier;
					scope: string | null;
			  }
			| undefined;

		if (!row) return null;

		// Scope enforcement: SKILL secrets can only be read by their owning skill
		if (
			row.tier === "SKILL" &&
			row.scope &&
			requestingScope &&
			row.scope !== requestingScope
		) {
			this.writeAuditLog(
				requestingScope,
				"GET_SECRET_DENIED",
				name,
				row.tier,
				"DENIED - scope mismatch",
			);
			throw new Error(
				`Secret '${name}' is scoped to skill '${row.scope}' — access denied for '${requestingScope}'`,
			);
		}

		try {
			const plaintext = this.decryptBuffer(
				row.ciphertext,
				row.iv,
				row.auth_tag,
				this.masterKey!,
			);
			this.writeAuditLog(
				requestingScope ?? "SYSTEM",
				"GET_SECRET",
				name,
				row.tier,
				"SUCCESS",
			);
			return plaintext.toString("utf8");
		} catch {
			this.writeAuditLog(
				requestingScope ?? "SYSTEM",
				"GET_SECRET",
				name,
				row.tier,
				"FAILED - decryption error",
			);
			return null;
		}
	}

	/**
	 * Check if a secret exists without retrieving it
	 */
	hasSecret(name: string): boolean {
		this.assertUnlocked();
		const row = this.db!.prepare(`SELECT name FROM secrets WHERE name = ?`).get(
			name,
		);
		return row !== undefined;
	}

	/**
	 * List all secret metadata (never values)
	 */
	listSecrets(): SecretEntry[] {
		this.assertUnlocked();
		const rows = this.db!.prepare(
			`
      SELECT name, tier, scope, description, created_at, updated_at FROM secrets ORDER BY tier, name
    `,
		).all() as Array<{
			name: string;
			tier: SecretTier;
			scope: string | null;
			description: string;
			created_at: number;
			updated_at: number;
		}>;

		return rows.map((r) => ({
			name: r.name,
			tier: r.tier,
			scope: r.scope ?? undefined,
			description: r.description,
			createdAt: r.created_at,
			updatedAt: r.updated_at,
		}));
	}

	/**
	 * Delete a secret
	 */
	deleteSecret(name: string): void {
		this.assertUnlocked();
		this.db!.prepare(`DELETE FROM secrets WHERE name = ?`).run(name);
		this.writeAuditLog("VAULT", "DELETE_SECRET", name, "ADMIN", "SUCCESS");
	}

	// ─── Audit Log ────────────────────────────────────────────────────────────

	private writeAuditLog(
		actor: string,
		action: string,
		target: string,
		tier: string,
		result: string,
	): void {
		this.db!.prepare(
			`
      INSERT INTO audit_log (ts, actor, action, target, tier, result)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
		).run(Date.now(), actor, action, target, tier, result);
	}

	getAuditLog(limit = 100): unknown[] {
		this.assertUnlocked();
		return this.db!.prepare(
			`
      SELECT * FROM audit_log ORDER BY ts DESC LIMIT ?
    `,
		).all(limit);
	}

	// ─── Crypto Helpers ───────────────────────────────────────────────────────

	private async deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
		const hash = await argon2.hash(passphrase, {
			type: argon2.argon2id,
			salt,
			memoryCost: 65536, // 64MB
			timeCost: 3,
			parallelism: 4,
			hashLength: KEY_LENGTH,
			raw: true,
		});
		return hash as Buffer;
	}

	private encryptBuffer(
		plaintext: Buffer,
		key: Buffer,
	): { ciphertext: Buffer; iv: Buffer; authTag: Buffer } {
		const iv = randomBytes(IV_LENGTH);
		const cipher = createCipheriv(ALGORITHM, key, iv);
		const ciphertext = Buffer.concat([
			cipher.update(plaintext),
			cipher.final(),
		]);
		const authTag = cipher.getAuthTag();
		return { ciphertext, iv, authTag };
	}

	private decryptBuffer(
		ciphertext: Buffer,
		iv: Buffer,
		authTag: Buffer,
		key: Buffer,
	): Buffer {
		const decipher = createDecipheriv(ALGORITHM, key, iv);
		decipher.setAuthTag(authTag);
		return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
	}

	private assertUnlocked(): void {
		if (!this.unlocked || !this.masterKey) {
			throw new Error("Vault is locked. Call unlock() first.");
		}
	}

	private validateSecretName(name: string): void {
		if (!/^[a-z0-9_.-]+$/.test(name)) {
			throw new Error(
				`Invalid secret name '${name}'. Use lowercase letters, numbers, dots, underscores, hyphens only.`,
			);
		}
	}
}

// Singleton
export const vault = new SecretVault();
