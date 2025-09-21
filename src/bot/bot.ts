import { PumpChatClient, IMessage } from "../index"
import { BotConfig, BotStatus } from "./types"
import { getDb } from "../config/db"
import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js"

type Recent = { lastAllowedAt: number; messages: { id: string; at: number }[] }
type GambleEvent =
	| { type: "deposit-info"; username?: string; userAddress?: string; address: string; timestamp: number }
	| { type: "balance"; username?: string; userAddress?: string; balanceLamports: number; balanceSol: number; timestamp: number }
	| { type: "bet"; username?: string; userAddress?: string; amountLamports: number; amountSol: number; won: boolean; newBalanceLamports: number; newBalanceSol: number; timestamp: number }

type BlockedMessageEvent = {
	type: "blocked-message"
	messageId: string
	username?: string
	userAddress?: string
	message?: string
	reason: string
	timestamp: number
}

type DeleteQueueItem = {
	msg: IMessage
	reason: string
	timestamp: number
}

export class PumpChatBot {
	private config: BotConfig
	private client: PumpChatClient | null = null
	private recentByUser: Map<string, Recent> = new Map()
	private giveaway = {
		open: false,
		entrants: new Map<string, { name: string; address?: string; joinedAt: number }>(),
	}
	private connected: boolean = false

	private subscribers: Set<(msg: IMessage) => void> = new Set()
	private gamblingSubscribers: Set<(ev: GambleEvent) => void> = new Set()
	private blockedMessageSubscribers: Set<(ev: BlockedMessageEvent) => void> = new Set()

	// Wallet sync state
	private solConnection: Connection | null = null
	private pollTimer: ReturnType<typeof setInterval> | null = null
	private syncing: boolean = false

	// Message blocking tracking
	private blockedMessageCount: number = 0

	// Delete queue system
	private deleteQueue: DeleteQueueItem[] = []
	private deleteQueueTimer: ReturnType<typeof setInterval> | null = null
	private isProcessingDeleteQueue: boolean = false
	messageHistory: IMessage[] = []

	constructor(config: BotConfig) {
		this.config = { ...config }
	}

	public getStatus(): BotStatus {
		return {
			running: !!this.client,
			connected: this.connected,
			roomId: this.config.roomId,
			username: this.config.username,
		}
	}

	public getBlockedMessageCount(): number {
		return this.blockedMessageCount
	}

	public getDeleteQueueStatus(): { queueSize: number; isProcessing: boolean } {
		return {
			queueSize: this.deleteQueue.length,
			isProcessing: this.isProcessingDeleteQueue
		}
	}

	public resetBlockedMessageCount(): void {
		this.blockedMessageCount = 0
		// eslint-disable-next-line no-console
		console.log("🔄 Reset blocked message count to 0")
	}

	/**
	 * Queues a message for deletion with proper rate limiting
	 * @param msg The message to delete
	 * @param reason The reason for deletion
	 */
	private queueDeleteMessage(msg: IMessage, reason: string = "TOXIC"): void {
		// Check if message is already in queue to avoid duplicates
		const alreadyQueued = this.deleteQueue.some(item => item.msg.id === msg.id)
		if (alreadyQueued) {
			// eslint-disable-next-line no-console
			console.log(`⚠️ Message ${msg.id} already queued for deletion, skipping`)
			return
		}

		this.deleteQueue.push({
			msg,
			reason,
			timestamp: Date.now()
		})

		// eslint-disable-next-line no-console
		console.log(`📝 Queued message for deletion: ${msg.username} - "${msg.message}" (reason: ${reason}) [Queue size: ${this.deleteQueue.length}]`)

		// Start the queue processor if not already running
		this.startDeleteQueueProcessor()
	}

	/**
	 * Starts the delete queue processor with 500ms intervals
	 */
	private startDeleteQueueProcessor(): void {
		if (this.deleteQueueTimer) return // Already running

		this.deleteQueueTimer = setInterval(() => {
			this.processDeleteQueue()
		}, 500)

		// eslint-disable-next-line no-console
		console.log("🚀 Started delete queue processor (500ms intervals)")
	}

	/**
	 * Stops the delete queue processor
	 */
	private stopDeleteQueueProcessor(): void {
		if (this.deleteQueueTimer) {
			clearInterval(this.deleteQueueTimer)
			this.deleteQueueTimer = null
			// eslint-disable-next-line no-console
			console.log("🛑 Stopped delete queue processor")
		}
	}

	/**
	 * Processes one item from the delete queue
	 */
	private async processDeleteQueue(): Promise<void> {
		if (this.isProcessingDeleteQueue || this.deleteQueue.length === 0) {
			return
		}

		this.isProcessingDeleteQueue = true

		try {
			const item = this.deleteQueue.shift()
			if (!item) return

			const { msg, reason } = item

			if (!this.client) {
				// eslint-disable-next-line no-console
				console.error("Cannot delete message: bot client not available")
				return
			}

			try {
				const result = await this.client.deleteMessage(msg, reason)
				
				if (result.ok) {
					// eslint-disable-next-line no-console
					console.log(`✅ Successfully deleted message from ${msg.username}: "${msg.message}" (reason: ${reason}) [Queue remaining: ${this.deleteQueue.length}]`)
				} else {
					// eslint-disable-next-line no-console
					console.error(`❌ Failed to delete message from ${msg.username}: HTTP ${result.status}`, result.body)
				}
			} catch (err) {
				// eslint-disable-next-line no-console
				console.error(`❌ Error deleting message from ${msg.username}:`, err)
			}
		} finally {
			this.isProcessingDeleteQueue = false
		}
	}

	public sendMessage(message: string): void {
		if (!this.client) {
			throw new Error("Bot is not running")
		}
		
		if (!this.connected) {
			throw new Error("Bot is not connected")
		}
		
		this.client.sendMessage(message)
	}


	public isRunning(): boolean {
		return !!this.client
	}

	private trackBlockedMessage(msg: IMessage, reason: string): void {
		this.blockedMessageCount++
		const timestamp = Date.now()
		
		try {
			const db = getDb()
			db.prepare(`
				INSERT INTO blocked_messages (messageId, username, userAddress, message, reason, timestamp)
				VALUES (?, ?, ?, ?, ?, ?)
			`).run(
				msg.id,
				msg.username || null,
				msg.userAddress || null,
				msg.message || null,
				reason,
				timestamp
			)
		} catch (err) {
			// eslint-disable-next-line no-console
			console.error("Failed to track blocked message:", err)
		}

		// Notify subscribers
		const event: BlockedMessageEvent = {
			type: "blocked-message",
			messageId: msg.id,
			username: msg.username,
			userAddress: msg.userAddress,
			message: msg.message,
			reason,
			timestamp
		}

		for (const fn of this.blockedMessageSubscribers) {
			try {
				fn(event)
			} catch (err) {
				// eslint-disable-next-line no-console
				console.error("Error notifying blocked message subscriber:", err)
			}
		}
	}

	public updateConfig(newConfig: Partial<BotConfig>): void {
		const prevRpc = this.config.solanaRpcUrl
		const prevAddr = this.config.botWalletAddress
		const prevRoomId = this.config.roomId
		const prevUsername = this.config.username
		const prevMessageHistoryLimit = this.config.messageHistoryLimit
		const prevToken = this.config.token
		
		this.config = { ...this.config, ...newConfig }
		
		// Check if connection-related settings changed
		const roomChanged = newConfig.roomId != null && newConfig.roomId !== prevRoomId
		const usernameChanged = newConfig.username !== prevUsername
		const historyLimitChanged = newConfig.messageHistoryLimit != null && newConfig.messageHistoryLimit !== prevMessageHistoryLimit
		const tokenChanged = newConfig.token !== prevToken
		
		// If connection settings changed and bot is running, restart the connection
		if ((roomChanged || usernameChanged || historyLimitChanged || tokenChanged) && this.client) {
			// eslint-disable-next-line no-console
			console.log(`🔄 Connection settings changed, restarting bot...`)
			if (roomChanged) console.log(`   Room changed: ${prevRoomId} → ${newConfig.roomId}`)
			if (usernameChanged) console.log(`   Username changed: ${prevUsername} → ${newConfig.username}`)
			if (tokenChanged) console.log(`   Token changed: ${prevToken ? 'provided' : 'none'} → ${newConfig.token ? 'provided' : 'none'}`)
			
			// Stop the current connection and wait a moment before starting new one
			this.stop()
			
			// Small delay to ensure clean disconnection
			setTimeout(() => {
				this.start()
			}, 100)
		}
		
		// Restart wallet sync only if relevant settings changed
		const rpcChanged = newConfig.solanaRpcUrl != null && newConfig.solanaRpcUrl !== prevRpc
		const addrChanged = newConfig.botWalletAddress != null && newConfig.botWalletAddress !== prevAddr
		if (rpcChanged || addrChanged) {
			this.stopWalletSync()
			this.startWalletSync()
		}
	}

	public subscribe(handler: (msg: IMessage) => void): () => void {
		this.subscribers.add(handler)
		return () => {
			this.subscribers.delete(handler)
		}
	}

	public subscribeGambling(handler: (ev: GambleEvent) => void): () => void {
		this.gamblingSubscribers.add(handler)
		return () => this.gamblingSubscribers.delete(handler)
	}

	public subscribeBlockedMessages(handler: (ev: BlockedMessageEvent) => void): () => void {
		this.blockedMessageSubscribers.add(handler)
		return () => this.blockedMessageSubscribers.delete(handler)
	}

	public start(): void {
		if (this.client) return
		const { roomId, username, messageHistoryLimit, token } = this.config
		
		// eslint-disable-next-line no-console
		console.log(`🚀 Starting bot with roomId: ${roomId}, username: ${username}, token: ${token ? 'provided' : 'none'}`)
		
		this.client = new PumpChatClient({ roomId, username, messageHistoryLimit, token })

		this.client.on("connected", () => {
			this.connected = true
			// eslint-disable-next-line no-console
			console.log(`✅ Connected to room ${roomId}`)
		})

		this.client.on("disconnected", () => {
			this.connected = false
			// eslint-disable-next-line no-console
			console.log(`❌ Disconnected from room ${roomId}`)

		})

		this.client.on("getMessageHistory", (messages: IMessage[]) => {
			this.messageHistory = messages;
			for(const msg of messages) {
				this.client?.deleteMessage(msg);
			}
		})

		this.client.on("error", (err) => {
			// eslint-disable-next-line no-console
			console.error(`❌ WebSocket Error: ${err}`)
		})

		this.client.on("serverError", (err) => {
			
			// eslint-disable-next-line no-console
			console.error(`❌ Server Error: ${JSON.stringify(err)}`)
		})

		this.client.on("message", (msg) => this.onMessage(msg))

		this.client.connect()

		// Start Solana deposit sync if configured
		this.startWalletSync()
	}

	public stop(): void {
		if (!this.client) return
		try {
			// eslint-disable-next-line no-console
			console.log(`🛑 Stopping bot for room ${this.config.roomId}`)
			this.client.disconnect()
		} finally {
			this.client = null
			this.connected = false
			this.recentByUser.clear()
			this.giveaway.open = false
			this.giveaway.entrants.clear()
			this.stopWalletSync()
			this.stopDeleteQueueProcessor()
			// Clear any remaining queued deletions
			this.deleteQueue.length = 0
		}
	}

	private escapeRegExp(s: string): string {
		// Escape regex metacharacters
		return s.replace(/[.*+?^${}()|\[\]\\]/g, "\\$&")
	}

	private containsExactBlacklistedWord(text: string): boolean {
		const blacklistWords = (this.config.blacklist || []).map((w) => w.toLowerCase())
		if (!text || blacklistWords.length === 0) return false
		for (const word of blacklistWords) {


			
			const re = new RegExp(`\\b${this.escapeRegExp(word)}\\b`, "i")
			if (re.test(text)) return true
		}
		return false
	}

	private containsWildcardBlacklistedWord(text: string): boolean {
		const blacklistWords = (this.config.wildcardBlacklist || []).map((w) => w.toLowerCase())
		if (!text || blacklistWords.length === 0) return false
		for (const word of blacklistWords) {
			const re = new RegExp(`\\b${this.escapeRegExp(word)}\\b`, "i")
			if (re.test(text)) return true
		}
		return false
	}

	private startWalletSync(): void {
		try {
			const rpc = this.config.solanaRpcUrl
			const tatum = this.config.tatumApiKey
			const depositAddress = this.config.botWalletAddress
			if (!(rpc || tatum) || !depositAddress) {
				// eslint-disable-next-line no-console
				console.log("[wallet] Skipping wallet sync: missing solanaRpcUrl or botWalletAddress")
				return
			}
			const endpoint = tatum ? "https://api.tatum.io/v3/blockchain/node/solana-mainnet" : String(rpc)
			const httpHeaders = tatum ? { "x-api-key": String(tatum) } : undefined
			this.solConnection = new Connection(endpoint, { commitment: "confirmed", httpHeaders })
			if (this.pollTimer) clearInterval(this.pollTimer)
			// eslint-disable-next-line no-console
			console.log(`[wallet] Starting wallet sync. Endpoint=${endpoint} (tatum=${!!tatum}) address=${depositAddress}`)
			// Ensure only one interval is active
			// this.pollTimer = setInterval(() => this.syncDeposits().catch(() => { }), 20_000)
			// // Kick off immediately
			// void this.syncDeposits().catch(() => { })
		} catch { }
	}

	private stopWalletSync(): void {
		if (this.pollTimer) {
			clearInterval(this.pollTimer)
			this.pollTimer = null
		}
		// eslint-disable-next-line no-console
		console.log("[wallet] Stopped wallet sync")
		this.solConnection = null
	}

	// private async syncDeposits(): Promise<void> {
	// 	if (this.syncing) return
	// 	this.syncing = true
	// 	try {
	// 		const rpc = this.config.solanaRpcUrl || (this.config.tatumApiKey ? "tatum" : "")
	// 		const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
	// 		console.log(`[wallet] Syncing deposits. RPC=${rpc} address=${this.config.botWalletAddress}`)
	// 		const depositAddress = this.config.botWalletAddress
	// 		if (!depositAddress) return
	// 		const conn = this.solConnection
	// 		if (!conn) return
	// 		const addr = new PublicKey(depositAddress)
	// 		// eslint-disable-next-line no-console
	// 		console.log("[wallet] Sync tick… fetching signatures")
	// 		// Fetch recent confirmed signatures to deposit address
	// 		const sigs = await conn.getSignaturesForAddress(addr, { limit: 50 })
	// 		await sleep(500)
	// 		if (!sigs || sigs.length === 0) {
	// 			// eslint-disable-next-line no-console
	// 			console.log("[wallet] No signatures found")
	// 			return
	// 		}
	// 		// eslint-disable-next-line no-console
	// 		console.log(`[wallet] Received ${sigs.length} signatures`)
	// 		const db = getDb()
	// 		const seen = db.prepare("SELECT signature FROM processed_sigs WHERE signature IN (" + sigs.map(() => "?").join(",") + ")").all(...sigs.map((s: any) => s.signature)) as { signature: string }[]
	// 		const seenSet = new Set(seen.map(s => s.signature))
	// 		const newSigs = sigs.filter((s: any) => !seenSet.has(s.signature))
	// 		// eslint-disable-next-line no-console
	// 		console.log(`[wallet] ${newSigs.length} new signatures`)
	// 		for (const s of newSigs) {
	// 			if (seenSet.has(s.signature)) continue
	// 			const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 })
	// 			if (!tx) continue
	// 			const pre = tx.meta?.preBalances || []
	// 			const post = tx.meta?.postBalances || []
	// 			await sleep(500)
	// 			const keysStatic = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses }).staticAccountKeys
	// 			const keysLoadedWritable = tx.meta?.loadedAddresses?.writable || []
	// 			const keysLoadedReadonly = tx.meta?.loadedAddresses?.readonly || []
	// 			const allKeys = [...keysStatic, ...keysLoadedWritable, ...keysLoadedReadonly]
	// 			const acctIndexStatic = keysStatic.findIndex((k) => k.equals(addr))
	// 			if (acctIndexStatic < 0) continue
	// 			// Compute credited amount for provided token mint (roomId), fallback to SOL lamports
	// 			let creditedAmount = 0
	// 			const targetMint = this.config.roomId
	// 			try {
	// 				const preTokens = (tx.meta as any)?.preTokenBalances || []
	// 				const postTokens = (tx.meta as any)?.postTokenBalances || []
	// 				if (targetMint) {
	// 					const ownerStr = depositAddress
	// 					const postMatches = (postTokens as any[]).filter((tb) => tb?.mint === targetMint && tb?.owner === ownerStr)
	// 					for (const postMatch of postMatches) {
	// 						const idx = postMatch.accountIndex
	// 						const postAmt = BigInt(String(postMatch.uiTokenAmount?.amount || "0"))
	// 						const preMatch = (preTokens as any[]).find((tb) => tb?.accountIndex === idx && tb?.mint === targetMint && tb?.owner === ownerStr)
	// 						const preAmt = BigInt(String(preMatch?.uiTokenAmount?.amount || "0"))
	// 						const deltaToken = postAmt - preAmt
	// 						if (deltaToken > BigInt(0)) creditedAmount += Number(deltaToken)
	// 					}
	// 				}
	// 			} catch {}
	// 			if (creditedAmount === 0) {
	// 				const deltaLamports = (post[acctIndexStatic] ?? 0) - (pre[acctIndexStatic] ?? 0)
	// 				creditedAmount = deltaLamports > 0 ? deltaLamports : 0
	// 			}
	// 			// Mark signature as processed regardless, so we don't loop on non-deposits
	// 			db.prepare("INSERT OR IGNORE INTO processed_sigs(signature) VALUES (?)").run(s.signature)
	// 			if (creditedAmount <= 0) continue
	// 			// Attribute deposit to the sender (prefer token source or SOL decrement; fallback: fee payer)
	// 			let sender: string | undefined
	// 			try {
	// 				const preTokens = (tx.meta as any)?.preTokenBalances || []
	// 				const postTokens = (tx.meta as any)?.postTokenBalances || []
	// 				const targetMint = this.config.roomId
	// 				if (targetMint) {
	// 					// Find an owner (not deposit wallet) whose balance decreased for the target mint
	// 					const preByOwner: Record<string, bigint> = {}
	// 					for (const b of preTokens as any[]) {
	// 						if (b?.mint === targetMint && b?.owner && b.owner !== depositAddress) {
	// 							const amt = BigInt(String(b.uiTokenAmount?.amount || "0"))
	// 							preByOwner[b.owner] = (preByOwner[b.owner] || BigInt(0)) + amt
	// 						}
	// 					}
	// 					const postByOwner: Record<string, bigint> = {}
	// 					for (const b of postTokens as any[]) {
	// 						if (b?.mint === targetMint && b?.owner && b.owner !== depositAddress) {
	// 							const amt = BigInt(String(b.uiTokenAmount?.amount || "0"))
	// 							postByOwner[b.owner] = (postByOwner[b.owner] || BigInt(0)) + amt
	// 						}
	// 					}
	// 					for (const owner of Object.keys(preByOwner)) {
	// 						const preAmt = preByOwner[owner] || BigInt(0)
	// 						const postAmt = postByOwner[owner] || BigInt(0)
	// 						if (postAmt < preAmt) { sender = owner; break }
	// 					}
	// 				}
	// 			} catch {}
	// 			if (!sender) {
	// 				// Find SOL sender by lamport decrease
	// 				let maxDrop = 0
	// 				for (let i = 0; i < keysStatic.length; i++) {
	// 					const k = keysStatic[i]
	// 					if (k.equals(addr)) continue
	// 					const drop = (pre[i] ?? 0) - (post[i] ?? 0)
	// 					if (drop > maxDrop) { maxDrop = drop; sender = k.toBase58() }
	// 				}
	// 			}
	// 			if (!sender) {
	// 				const feePayer = keysStatic[0]?.toBase58()
	// 				sender = feePayer
	// 			}
	// 			if (!sender || sender === depositAddress) continue
	// 			db.prepare("INSERT INTO wallet_balances(userAddress, balanceLamports) VALUES(?, ?) ON CONFLICT(userAddress) DO UPDATE SET balanceLamports = balanceLamports + excluded.balanceLamports").run(sender, creditedAmount)
	// 			// eslint-disable-next-line no-console
	// 			console.log(`[wallet] Credited ${sender} +${creditedAmount} base units (to ${depositAddress}) sig=${s.signature}`)
	// 			await sleep(500)
	// 		}
	// 		// eslint-disable-next-line no-console
	// 		console.log("[wallet] Sync complete")
	// 	} catch (err) {
	// 		// eslint-disable-next-line no-console
	// 		console.error("[wallet] Sync error:", err)
	// 	}
	// 	finally { this.syncing = false }
	// }

	private async handleBalanceCommand(msg: IMessage): Promise<void> {
		const db = getDb()
		const row = db.prepare("SELECT balanceLamports FROM wallet_balances WHERE userAddress = ?").get(msg.userAddress) as any
		const lamports = Number(row?.balanceLamports || 0)
		const sol = (lamports / LAMPORTS_PER_SOL).toFixed(4)
		// publish to gambling stream instead of chat
		for (const fn of this.gamblingSubscribers) {
			try { fn({ type: "balance", username: msg.username, userAddress: msg.userAddress, balanceLamports: lamports, balanceSol: Number(sol), timestamp: Date.now() }) } catch { }
		}
		this.queueDeleteMessage(msg, "balance_command")
	}

	private async handleDepositCommand(msg: IMessage): Promise<void> {
		const addr = this.config.botWalletAddress
		if (!addr) return
		// publish to gambling stream instead of chat
		for (const fn of this.gamblingSubscribers) {
			try { fn({ type: "deposit-info", username: msg.username, userAddress: msg.userAddress, address: addr, timestamp: Date.now() }) } catch { }
		}
		this.queueDeleteMessage(msg, "deposit_command")
	}

	private async handleBetCommand(msg: IMessage, lc: string): Promise<void> {
		// syntax: /bet <side> <amount>  e.g., "/bet a 0.1" or "/bet b 0.5"
		const parts = lc.split(/\s+/)
		const side = parts[1]
		const amtStr = parts[2]
		if (!amtStr) return
		const amountSol = Number(amtStr.replace(/[^0-9.]/g, ""))
		if (!isFinite(amountSol) || amountSol <= 0) return
		const amountLamports = Math.floor(amountSol * LAMPORTS_PER_SOL)
		const db = getDb()
		const row = db.prepare("SELECT balanceLamports FROM wallet_balances WHERE userAddress = ?").get(msg.userAddress) as any
		const current = Number(row?.balanceLamports || 0)
		if (current < amountLamports) {
			this.queueDeleteMessage(msg, "insufficient_balance")
			await this.client?.sendMessage(`${msg.username} insufficient balance.`)
			return
		}
		// Simple 50/50 bet; side must be 'a' or 'b'
		const userOnA = (side || '').startsWith('a')
		const coinA = Math.random() < 0.5
		const win = userOnA === coinA
		const delta = win ? amountLamports : -amountLamports
		db.prepare("UPDATE wallet_balances SET balanceLamports = balanceLamports + ? WHERE userAddress = ?").run(delta, msg.userAddress)
		// publish to gambling stream instead of chat
		for (const fn of this.gamblingSubscribers) {
			try { fn({ type: "bet", username: msg.username, userAddress: msg.userAddress, amountLamports, amountSol, won: win, newBalanceLamports: current + delta, newBalanceSol: (current + delta) / LAMPORTS_PER_SOL, timestamp: Date.now() }) } catch { }
		}
		this.queueDeleteMessage(msg, "bet_command")
	}

	private async onMessage(msg: IMessage): Promise<void> {
		const client = this.client
		if (!client) return

		const now = Date.now()
		const key = msg.userAddress || msg.username
		if (!key) return


		if (key === '8xG4H7FrNDpcAo8SU2KSo7LxXPqpHzisabmuvqn5XYeK' && this.config.restrictedMode) {
			return;
		}

		const content = String(msg.message || "").trim()
		const lc = content.toLowerCase()

		// Gambling commands are handled and published to the gambling stream (not to chat)
		if (lc.startsWith('/balance')) {
			await this.handleBalanceCommand(msg)
			return
		}

		if (lc.startsWith('/bet')) {
			await this.handleBetCommand(msg, lc)
			return
		}

		// Restricted mode: delete every other incoming message
		if (this.config.restrictedMode) {
			this.trackBlockedMessage(msg, "restricted_mode")
			this.queueDeleteMessage(msg, "restricted_mode")
			return
		}

		// !flip command
		if (lc.startsWith("/flip")) {
			const randomNumber = Math.floor(Math.random() * 2)
			if (randomNumber === 0) {
				this.trackBlockedMessage(msg, "flip_command_lost")
				this.queueDeleteMessage(msg, "flip_command_lost")
			} else {
				await client.sendMessage(`${msg.username} flipped a coin and and got heads`)
			}
			return
		}

		// Giveaway commands (admin: userAddress must equal configured username)
		if (lc === "/giveaway open" || lc === "/open") {
			if (msg.userAddress !== this.config.username) return
			this.queueDeleteMessage(msg, "giveaway_command")
			this.giveaway.open = true
			this.giveaway.entrants.clear()
			await new Promise((resolve) => setTimeout(resolve, 250))
			await client.sendMessage("Giveaway opened. Type !join to enter.")
			return
		}

		if (lc === "/giveaway close" || lc === "/close") {
			if (msg.userAddress !== this.config.username) return
			this.queueDeleteMessage(msg, "giveaway_command")
			this.giveaway.open = false
			await new Promise((resolve) => setTimeout(resolve, 250))
			await client.sendMessage("Giveaway closed.")
			return
		}

		if (lc === "/giveaway reset" || lc === "/reset") {
			if (msg.userAddress !== this.config.username) return
			this.queueDeleteMessage(msg, "giveaway_command")
			this.giveaway.open = false
			this.giveaway.entrants.clear()
			await new Promise((resolve) => setTimeout(resolve, 250))
			await client.sendMessage("Giveaway reset.")
			return
		}

		if (lc === "/draw" || lc === "/winner" || lc === "/giveaway draw") {
			if (msg.userAddress !== this.config.username) return
			this.queueDeleteMessage(msg, "giveaway_command")
			if (this.giveaway.entrants.size === 0) {
				await new Promise((resolve) => setTimeout(resolve, 250))
				await client.sendMessage("No entrants.")
				return
			}
			const entries = Array.from(this.giveaway.entrants.values())
			const winner = entries[Math.floor(Math.random() * entries.length)]
			this.giveaway.open = false
			this.giveaway.entrants.clear()
			await new Promise((resolve) => setTimeout(resolve, 250))
			// eslint-disable-next-line no-console
			console.log(`Winner: ${winner.name} ! Congrats! ${winner.address}`)
			await client.sendMessage(`Winner: ${winner.name} ! Congrats! ${winner.address}`)
			return
		}

		if (lc === "/join") {
			this.queueDeleteMessage(msg, "join_command")
			if (!this.giveaway.open) return
			if (!this.giveaway.entrants.has(key)) {
				this.giveaway.entrants.set(key, { name: msg.username, address: msg.userAddress, joinedAt: now })
			}
			return
		}

		// Blacklist check
		if (this.containsExactBlacklistedWord(String(msg.message || ""))) {
			// eslint-disable-next-line no-console
			console.log(`Deleting message ${msg.username} message ${msg.message}`)
			this.trackBlockedMessage(msg, "blacklist")
			this.queueDeleteMessage(msg, "blacklist")
			return
		}

		if(this.containsWildcardBlacklistedWord(String(msg.message || ""))) {
			// eslint-disable-next-line no-console
			this.trackBlockedMessage(msg, "blacklist")
			this.queueDeleteMessage(msg, "blacklist")
			return
		}

		// eslint-disable-next-line no-console
		console.log(`Message ${msg.username} message ${msg.message}`)


		const cooldownMs = this.config.cooldownSeconds != null
			? Math.max(0, Math.floor(this.config.cooldownSeconds * 1000))
			: 5000
		const current: Recent = this.recentByUser.get(key) || { lastAllowedAt: 0, messages: [] }

		// Prune
		if (cooldownMs > 0) {
			current.messages = current.messages.filter((m) => now - m.at <= cooldownMs)
		}

		const delta = current.lastAllowedAt ? now - current.lastAllowedAt : Number.POSITIVE_INFINITY
		current.messages.push({ id: msg.id, at: now })

		if (cooldownMs > 0 && delta <= cooldownMs) {
			// eslint-disable-next-line no-console
			console.log(`Deleting message ${msg.username} message ${msg.message}`)
			this.trackBlockedMessage(msg, "cooldown")
			this.queueDeleteMessage(msg, "cooldown")
			this.recentByUser.set(key, current)
		} else {

			// Notify subscribers for live feed
			for (const fn of this.subscribers) {
				try {
					fn(msg)
				} catch {
					console.log('error');
				}
			}
			if (cooldownMs > 0) current.lastAllowedAt = now
			this.recentByUser.set(key, current)
		}
	}
}


