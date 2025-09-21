import { getDb } from "./db"
import { BotConfig } from "../bot/types"

export function loadConfig(): BotConfig {
	const db = getDb()
	const row = db.prepare("SELECT * FROM settings WHERE id = 1").get() as any
	return {
		roomId: row.roomId || "",
		username: row.username || undefined,
		messageHistoryLimit: row.messageHistoryLimit ?? 100,
		token: row.token || undefined,
		sendIntervalMs: row.sendIntervalMs ?? 60000,
		blacklist: row.blacklist ? JSON.parse(row.blacklist) : [],
		cooldownSeconds: row.cooldownSeconds ?? 5,
		restrictedMode: !!row.restrictedMode,
		botWalletAddress: row.botWalletAddress || undefined,
		solanaRpcUrl: row.solanaRpcUrl || undefined,
		tatumApiKey: row.tatumApiKey || undefined,
	}
}

export function saveConfig(cfg: Partial<BotConfig>): BotConfig {
	const current = loadConfig()
	const merged: BotConfig = { ...current, ...cfg }
	const db = getDb()
	db.prepare(
		`UPDATE settings SET roomId=@roomId, username=@username, messageHistoryLimit=@messageHistoryLimit,
		 token=@token, sendIntervalMs=@sendIntervalMs, blacklist=@blacklist, cooldownSeconds=@cooldownSeconds, restrictedMode=@restrictedMode,
		 botWalletAddress=@botWalletAddress, solanaRpcUrl=@solanaRpcUrl, tatumApiKey=@tatumApiKey WHERE id = 1`
	).run({
		roomId: merged.roomId,
		username: merged.username ?? null,
		messageHistoryLimit: merged.messageHistoryLimit ?? null,
		token: merged.token ?? null,
		sendIntervalMs: merged.sendIntervalMs ?? null,
		blacklist: JSON.stringify(merged.blacklist || []),
		cooldownSeconds: merged.cooldownSeconds ?? null,
		restrictedMode: merged.restrictedMode ? 1 : 0,
		botWalletAddress: merged.botWalletAddress ?? null,
		solanaRpcUrl: merged.solanaRpcUrl ?? null,
		tatumApiKey: merged.tatumApiKey ?? null,
	})
	return merged
}


