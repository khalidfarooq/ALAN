/**
 * A.L.A.N. Entry Point
 */
import { vault } from "./vault/vault.js";
import { startServer } from "./server/index.js";

async function main() {
	console.log("🤖 Starting A.L.A.N. — Autonomous Local Assistant Node\n");

	// If vault exists, try to prompt for passphrase
	if (vault.isInitialized) {
		console.log(
			"Vault found. Start the UI to unlock, or set ALAN_PASSPHRASE env var.\n",
		);

		// Support env var for automated/dev unlocking (not for production)
		const envPassphrase = process.env.ALAN_PASSPHRASE;
		if (envPassphrase) {
			const success = await vault.unlock(envPassphrase);
			if (success) {
				console.log("✅ Vault unlocked via environment variable\n");
			} else {
				console.error("❌ Invalid passphrase in ALAN_PASSPHRASE\n");
			}
		}
	} else {
		console.log(
			"First run detected. Open http://127.0.0.1:7432 to complete setup.\n",
		);
	}

	await startServer();
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
