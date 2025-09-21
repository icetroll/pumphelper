import express, { Request, Response } from "express"
import path from "path"
import bodyParser from "body-parser"
import { loadConfig, saveConfig } from "../config/store"
import { PumpChatBot } from "../bot/bot"
import { getDb } from "../config/db"
import type { Server } from "http"
import fs from "fs"

export function createServer(port: number = 3000, providedBot?: PumpChatBot): Server {
	const app = express()
	app.use(bodyParser.json())

	let bot: PumpChatBot | null = providedBot || null

	app.get("/api/config", (req: Request, res: Response) => {
		res.json(loadConfig())
	})

	app.post("/api/config", (req: Request, res: Response) => {
		const merged = saveConfig(req.body || {})
		if (bot) {
			bot.updateConfig(merged)
		} else {
			// If no bot exists but we have a room ID, create one
			if (merged.roomId) {
				bot = new PumpChatBot(merged)
			}
		}
		res.json(merged)
	})

	app.post("/api/bot/start", (req: Request, res: Response) => {
		if (!bot) bot = new PumpChatBot(loadConfig())
		bot.start()
		res.json({ ok: true })
	})

	app.post("/api/bot/stop", (req: Request, res: Response) => {
		if (bot) bot.stop()
		res.json({ ok: true })
	})

	app.get("/api/bot/status", (req: Request, res: Response) => {
		if (!bot) return res.json({ running: false, connected: false })
		res.json(bot.getStatus())
	})

	app.get("/api/blocked-messages", (req: Request, res: Response) => {
		try {
			const db = getDb()
			const stats = db.prepare(`
				SELECT 
					COUNT(*) as total,
					SUM(CASE WHEN reason = 'restricted_mode' THEN 1 ELSE 0 END) as restricted_mode,
					SUM(CASE WHEN reason = 'blacklist' THEN 1 ELSE 0 END) as blacklist,
					SUM(CASE WHEN reason = 'cooldown' THEN 1 ELSE 0 END) as cooldown,
					SUM(CASE WHEN reason = 'flip_command_lost' THEN 1 ELSE 0 END) as flip_command_lost
				FROM blocked_messages
			`).get() as any

			const recent = db.prepare(`
				SELECT messageId, username, userAddress, message, reason, timestamp
				FROM blocked_messages
				ORDER BY timestamp DESC
				LIMIT 50
			`).all()

			res.json({
				stats: {
					total: stats.total || 0,
					restricted_mode: stats.restricted_mode || 0,
					blacklist: stats.blacklist || 0,
					cooldown: stats.cooldown || 0,
					flip_command_lost: stats.flip_command_lost || 0
				},
				recent: recent
			})
		} catch (err) {
			res.status(500).json({ error: "Failed to fetch blocked messages" })
		}
	})

	app.post("/api/blocked-messages/clear", (req: Request, res: Response) => {
		try {
			const db = getDb()
			
			// Clear all blocked messages
			const result = db.prepare("DELETE FROM blocked_messages").run()
			
			// Reset bot's blocked message count if bot exists
			if (bot) {
				bot.resetBlockedMessageCount()
			}
			
			res.json({ 
				success: true, 
				message: "Blocked messages and stats cleared successfully",
				deletedCount: result.changes
			})
		} catch (err) {
			console.error("Failed to clear blocked messages:", err)
			res.status(500).json({ error: "Failed to clear blocked messages" })
		}
	})

	app.get("/api/live-streams", async (req: Request, res: Response) => {
		try {
			const response = await fetch("https://frontend-api-v3.pump.fun/coins/currently-live?offset=0&limit=60&sort=currently_live&order=DESC&includeNsfw=false")
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`)
			}
			
			const data = await response.json()
			res.json(data)
		} catch (err) {
			console.error("Failed to fetch live streams:", err)
			res.status(500).json({ error: "Failed to fetch live streams" })
		}
	})


	// Server-Sent Events stream for live messages
	app.get("/api/stream", (req: Request, res: Response) => {
		res.setHeader("Content-Type", "text/event-stream")
		res.setHeader("Cache-Control", "no-cache, no-transform")
		res.setHeader("Connection", "keep-alive")
		res.setHeader("X-Accel-Buffering", "no")
		// Keep the TCP connection alive and disable timeouts for SSE
		req.socket.setTimeout?.(0)
		req.socket.setKeepAlive?.(true)
		res.flushHeaders?.()

		// Suggest client retry interval and send initial comment to open the stream
		try {
			res.write("retry: 2000\n\n")
			res.write(": connected\n\n")
		} catch {}

		const heartbeat = setInterval(() => {
			res.write(`: ping\n\n`)
		}, 10000)

		if (!bot) bot = new PumpChatBot(loadConfig())
		const unsubscribe = bot.subscribe((msg) => {
			try {
				res.write(`data: ${JSON.stringify({
					id: msg.id,
					username: msg.username,
					userAddress: msg.userAddress,
					message: msg.message,
					timestamp: msg.timestamp,
				})}\n\n`)
			} catch {
                console.log('error');
            }
		})

		req.on("close", () => {
            console.log('bot closed');
			clearInterval(heartbeat)
			unsubscribe()
			try { res.end() } catch {}
            console.log('bot ended');
		})
	})

	// Server-Sent Events stream for gambling events
	app.get("/api/gambling-stream", (req: Request, res: Response) => {
		res.setHeader("Content-Type", "text/event-stream")
		res.setHeader("Cache-Control", "no-cache, no-transform")
		res.setHeader("Connection", "keep-alive")
		res.setHeader("X-Accel-Buffering", "no")
		req.socket.setTimeout?.(0)
		req.socket.setKeepAlive?.(true)
		res.flushHeaders?.()

		try { res.write("retry: 2000\n\n"); res.write(": connected\n\n") } catch {}

		const heartbeat = setInterval(() => { try { res.write(`: ping\n\n`) } catch {} }, 10000)

		if (!bot) bot = new PumpChatBot(loadConfig())
		const unsubscribe = bot.subscribeGambling((ev) => {
			try { res.write(`data: ${JSON.stringify(ev)}\n\n`) } catch {}
		})

		req.on("close", () => {
			clearInterval(heartbeat)
			unsubscribe()
			try { res.end() } catch {}
		})
	})

	// Server-Sent Events stream for blocked messages
	app.get("/api/blocked-messages-stream", (req: Request, res: Response) => {
		res.setHeader("Content-Type", "text/event-stream")
		res.setHeader("Cache-Control", "no-cache, no-transform")
		res.setHeader("Connection", "keep-alive")
		res.setHeader("X-Accel-Buffering", "no")
		req.socket.setTimeout?.(0)
		req.socket.setKeepAlive?.(true)
		res.flushHeaders?.()

		try { res.write("retry: 2000\n\n"); res.write(": connected\n\n") } catch {}

		const heartbeat = setInterval(() => { try { res.write(`: ping\n\n`) } catch {} }, 10000)

		if (!bot) bot = new PumpChatBot(loadConfig())
		const unsubscribe = bot.subscribeBlockedMessages((ev) => {
			try { res.write(`data: ${JSON.stringify(ev)}\n\n`) } catch {}
		})

		req.on("close", () => {
			clearInterval(heartbeat)
			unsubscribe()
			try { res.end() } catch {}
		})
	})


	// Serve static dashboard
	const distPublic = path.join(__dirname, "public")
	const srcPublic = path.resolve(process.cwd(), "src", "server", "public")
	const staticRoot = fs.existsSync(distPublic) ? distPublic : srcPublic
	app.use(express.static(staticRoot))
	app.get(["/", "/index.html"], (_req: Request, res: Response) => {
		res.sendFile(path.join(staticRoot, "index.html"))
	})

	app.get(["/chat", "/chat.html"], (_req: Request, res: Response) => {
		res.sendFile(path.join(staticRoot, "chat.html"))
	})
	app.get(["/guess", "/guess.html"], (_req: Request, res: Response) => {
		res.sendFile(path.join(staticRoot, "guess.html"))
	})
	app.get(["/gambling", "/gambling.html"], (_req: Request, res: Response) => {
		res.sendFile(path.join(staticRoot, "gambling.html"))
	})
	app.get(["/restricted", "/restricted.html"], (_req: Request, res: Response) => {
		res.sendFile(path.join(staticRoot, "restricted.html"))
	})
	// Fallback to index for any route
	app.use((req: Request, res: Response) => {
		res.sendFile(path.join(staticRoot, "index.html"))
	})

	return app.listen(port, () => {
		// eslint-disable-next-line no-console
		console.log(`Dashboard listening on http://localhost:${port}`)
	})
}


