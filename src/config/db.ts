import Database from "better-sqlite3"
import path from "path"
import fs from "fs"

let db: Database.Database | null = null

function ensureDir(dir: string) {
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true })
	}
}

export function getDb(): Database.Database {
	if (db) return db
	const dataDir = path.resolve(process.cwd(), ".data")
	ensureDir(dataDir)
	const dbPath = path.join(dataDir, "pump-chat.db")
	db = new Database(dbPath)
	// Create table if needed (base columns)
	db.exec(`
		CREATE TABLE IF NOT EXISTS settings (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			roomId TEXT NOT NULL,
			username TEXT,
			messageHistoryLimit INTEGER,
			token TEXT,
			sendIntervalMs INTEGER,
			blacklist TEXT,
			cooldownSeconds INTEGER
		);
	`)

	// Backfill migrations for older databases missing new columns, and ensure latest schema
	let hasRestricted = false
	let hasBotWalletAddress = false
	let hasSolanaRpcUrl = false
	let hasTatumApiKey = false
	try {
		const cols = db.prepare("PRAGMA table_info(settings)").all() as { name: string }[]
		hasRestricted = cols.some((c) => c.name === "restrictedMode")
		hasBotWalletAddress = cols.some((c) => c.name === "botWalletAddress")
		hasSolanaRpcUrl = cols.some((c) => c.name === "solanaRpcUrl")
		hasTatumApiKey = cols.some((c) => c.name === "tatumApiKey")
		if (!hasRestricted) {
			db.exec("ALTER TABLE settings ADD COLUMN restrictedMode INTEGER DEFAULT 0")
			hasRestricted = true
		}
		if (!hasBotWalletAddress) {
			db.exec("ALTER TABLE settings ADD COLUMN botWalletAddress TEXT")
			hasBotWalletAddress = true
		}
		if (!hasSolanaRpcUrl) {
			db.exec("ALTER TABLE settings ADD COLUMN solanaRpcUrl TEXT")
			hasSolanaRpcUrl = true
		}
		if (!hasTatumApiKey) {
			db.exec("ALTER TABLE settings ADD COLUMN tatumApiKey TEXT")
			hasTatumApiKey = true
		}
		if (hasRestricted) {
			db.exec("UPDATE settings SET restrictedMode = 0 WHERE restrictedMode IS NULL")
		}
	} catch {}

	// Seed defaults row
	try {
		const cols = [
			"id", "roomId", "username", "messageHistoryLimit", "token", "sendIntervalMs", "blacklist", "cooldownSeconds",
			...(hasRestricted ? ["restrictedMode"] : []),
			...(hasBotWalletAddress ? ["botWalletAddress"] : []),
			...(hasSolanaRpcUrl ? ["solanaRpcUrl"] : []),
			...(hasTatumApiKey ? ["tatumApiKey"] : []),
		]
		const vals = [
			"1", "''", "NULL", "100", "NULL", "60000", "'[]'", "5",
			...(hasRestricted ? ["0"] : []),
			...(hasBotWalletAddress ? ["NULL"] : []),
			...(hasSolanaRpcUrl ? ["NULL"] : []),
			...(hasTatumApiKey ? ["NULL"] : []),
		]
		db.exec(`INSERT OR IGNORE INTO settings (${cols.join(", ")}) VALUES (${vals.join(", ")});`)
	} catch {}

	// Wallet tables
	try {
		db.exec(`
			CREATE TABLE IF NOT EXISTS wallet_balances (
				userAddress TEXT PRIMARY KEY,
				balanceLamports INTEGER NOT NULL DEFAULT 0
			);
			CREATE TABLE IF NOT EXISTS processed_sigs (
				signature TEXT PRIMARY KEY
			);
			CREATE TABLE IF NOT EXISTS blocked_messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				messageId TEXT NOT NULL,
				username TEXT,
				userAddress TEXT,
				message TEXT,
				reason TEXT NOT NULL,
				timestamp INTEGER NOT NULL
			);
		`)
	} catch {}
	return db
}


