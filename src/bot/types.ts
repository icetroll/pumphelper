export type BotConfig = {
	roomId: string
	username?: string
	messageHistoryLimit?: number
	token?: string
	sendIntervalMs?: number
	blacklist?: string[]
	wildcardBlacklist?: string[]
	cooldownSeconds?: number
	restrictedMode?: boolean
	botWalletAddress?: string
	solanaRpcUrl?: string
	tatumApiKey?: string
}

export type BotStatus = {
	running: boolean
	connected: boolean
	roomId?: string
	username?: string
}