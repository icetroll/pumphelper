/**
 * @fileoverview PumpChatClient - A WebSocket client for connecting to pump.fun token chat rooms.
 * This client handles the socket.io protocol communication with pump.fun's chat servers,
 * providing an easy-to-use interface for reading and sending chat messages.
 * 
 * @module pump-chat-client
 * @author codingbutter
 * @license MIT
 */

import WebSocket from "websocket"
import { EventEmitter } from "events"

/**
 * Represents a chat message from pump.fun.
 * @interface IMessage
 * @property {string} id - Unique identifier for the message
 * @property {string} roomId - The token address/room ID where the message was sent
 * @property {string} username - Display name of the user who sent the message
 * @property {string} userAddress - Wallet address of the user
 * @property {string} message - The actual message content
 * @property {string} profile_image - URL to the user's profile image
 * @property {string} timestamp - ISO 8601 timestamp when the message was sent
 * @property {string} messageType - Type of message (e.g., "REGULAR")
 * @property {number} expiresAt - Unix timestamp when the message expires
 */
interface IMessage {
  id: string
  roomId: string
  username: string
  userAddress: string
  message: string
  profile_image: string
  timestamp: Date
  messageType: string
  expiresAt: number
}

/**
 * Configuration options for creating a PumpChatClient instance.
 * @interface PumpChatClientOptions
 * @property {string} roomId - The token address to connect to (required)
 * @property {string} [username="anonymous"] - Username to display in chat (optional)
 * @property {number} [messageHistoryLimit=100] - Maximum number of messages to store in memory (optional)
 */
interface PumpChatClientOptions {
  roomId: string
  username?: string
  messageHistoryLimit?: number
  token?: string
}

/**
 * Event definitions for PumpChatClient
 * @event PumpChatClient#connected - Emitted when successfully connected to the chat room
 * @event PumpChatClient#disconnected - Emitted when disconnected from the chat room
 * @event PumpChatClient#message - Emitted when a new message is received
 * @event PumpChatClient#messageHistory - Emitted when message history is received
 * @event PumpChatClient#error - Emitted when a connection or protocol error occurs
 * @event PumpChatClient#serverError - Emitted when the server returns an error (e.g., authentication required)
 * @event PumpChatClient#userLeft - Emitted when a user leaves the chat room
 * @event PumpChatClient#maxReconnectAttemptsReached - Emitted after exhausting all reconnection attempts
 */

/**
 * WebSocket client for connecting to pump.fun token chat rooms.
 * Extends EventEmitter to provide event-driven communication.
 * 
 * @class PumpChatClient
 * @extends {EventEmitter}
 * @example
 * ```typescript
 * const client = new PumpChatClient({
 *   roomId: 'YOUR_TOKEN_ADDRESS',
 *   username: 'myUsername',
 *   messageHistoryLimit: 50
 * });
 * 
 * client.on('message', (msg) => {
 *   console.log(`${msg.username}: ${msg.message}`);
 * });
 * 
 * client.connect();
 * ```
 */
export class PumpChatClient extends EventEmitter {
  /** WebSocket client instance from the 'websocket' library */
  private client: WebSocket.client
  
  /** Active WebSocket connection, null when disconnected */
  private connection: WebSocket.connection | null = null
  
  /** The token address/room ID we're connected to */
  private roomId: string
  
  /** Username displayed in chat messages */
  private username: string
  
  /** In-memory storage of chat messages */
  private messageHistory: IMessage[] = []
  
  /** Maximum number of messages to keep in memory */
  private messageHistoryLimit: number
  
  /** Current connection state */
  private isConnected: boolean = false
  
  /** Interval timer for sending ping messages to keep connection alive */
  private pingInterval: NodeJS.Timeout | null = null
  
  /** Heartbeat watchdog to proactively reconnect on missed pongs */
  private heartbeatMonitor: NodeJS.Timeout | null = null
  
  /** Timestamp of the last pong observed from the server */
  private lastPongAt: number = 0
  
  /** Counter for reconnection attempts */
  private reconnectAttempts: number = 0
  
  /** Maximum number of times to attempt reconnection before giving up */
  private maxReconnectAttempts: number = Infinity
  
  /** Flag to prevent reconnection when explicitly disconnected */
  private isExplicitlyDisconnected: boolean = false
  
  /** 
   * Current acknowledgment ID for socket.io protocol.
   * Cycles from 0-9 to match request/response pairs.
   */
  private ackId: number = 0
  
  /** 
   * Map of pending acknowledgments waiting for server responses.
   * Key is the ack ID, value contains the event name and timestamp.
   */
  private pendingAcks: Map<number, { event: string, timestamp: number }> = new Map()

  /** Optional auth token used for authentication with pump.fun */
  private token: string | null = null

  /**
   * Creates a new PumpChatClient instance.
   * @param {PumpChatClientOptions} options - Configuration options
   * @param {string} options.roomId - The token address to connect to
   * @param {string} [options.username="anonymous"] - Username for chat messages
   * @param {number} [options.messageHistoryLimit=100] - Max messages to store
   * @constructor
   */
  constructor(options: PumpChatClientOptions) {
    super()
    
    // Store configuration
    this.roomId = options.roomId
    this.username = options.username || "anonymous"
    this.messageHistoryLimit = options.messageHistoryLimit || 100
    this.token = options.token || null
    
    // Initialize WebSocket client
    this.client = new WebSocket.client()
    
    // Set up WebSocket event handlers
    this.setupClientHandlers()
  }

  /**
   * Sets up event handlers for the WebSocket client.
   * These handlers manage the initial connection establishment.
   * @private
   */
  private setupClientHandlers() {
    /**
     * Handle successful WebSocket connection.
     * This is called when the WebSocket upgrade is successful.
     */
    this.client.on("connect", (connection: WebSocket.connection) => {
      // Store the connection reference
      this.connection = connection
      this.isConnected = true
      
      // Reset reconnection counter on successful connection
      this.reconnectAttempts = 0
      
      console.error("WebSocket Client Connected")
      
      // Emit connected event for consumers
      this.emit("connected")

      // Set up handlers for this specific connection
      this.setupConnectionHandlers(connection)
      
      // Initialize the socket.io protocol handshake
      this.initializeConnection()
    })

    /**
     * Handle connection failures.
     * This is called when the WebSocket connection cannot be established.
     */
    this.client.on("connectFailed", (error) => {
      console.error("Connection Failed:", error.toString())
      
      // Emit error event for consumers
      this.emit("error", error)
      
      // Attempt to reconnect with exponential backoff
      this.attemptReconnect()
    })
  }

  /**
   * Sets up event handlers for an active WebSocket connection.
   * These handlers manage the ongoing communication and lifecycle.
   * @param {WebSocket.connection} connection - The active WebSocket connection
   * @private
   */
  private setupConnectionHandlers(connection: WebSocket.connection) {
    /**
     * Handle connection errors during active connection.
     * These are different from connection establishment errors.
     */
    connection.on("error", (error) => {
      console.error("Connection Error:", error.toString())
      this.emit("error", error)
    })

    /**
     * Handle connection closure.
     * This can happen due to network issues, server shutdown, or explicit disconnection.
     */
    connection.on("close", (code?: number, description?: string) => {
      console.error("WebSocket Connection Closed", code, description)
      
      // Update connection state
      this.isConnected = false
      this.connection = null
      
      // Notify consumers
      this.emit("disconnected")
      
      // Stop sending ping messages
      this.stopPing()
      // Stop heartbeat
      this.stopHeartbeat()
      // Stop ack cleanup timer
      this.stopAckCleanup()
      
      // Attempt to reconnect unless explicitly disconnected
      this.attemptReconnect()
    })

    /**
     * Handle incoming WebSocket messages.
     * All messages from pump.fun come through this handler.
     */
    connection.on("message", (message: WebSocket.Message) => {
      // pump.fun sends UTF-8 encoded text messages
      if (message.type === "utf8" && message.utf8Data) {
        this.handleMessage(message.utf8Data)
      }
    })

    /**
     * Set up periodic cleanup of stale acknowledgments.
     * This prevents memory leaks from acknowledgments that never receive responses.
     */
    if (!this.ackCleanupInterval) {
      this.ackCleanupInterval = setInterval(() => {
        this.cleanupStaleAcks()
      }, 10000) // Run cleanup every 10 seconds
    }
  }

  /**
   * Main message handler that routes messages based on socket.io protocol type.
   * Socket.io uses numeric prefixes to identify different message types.
   * @param {string} data - Raw message data from the WebSocket
   * @private
   */
  private handleMessage(data: string) {
    // Extract the numeric message type prefix using regex
    // Socket.io messages start with a number (e.g., "42[...]", "430[...]")
    const messageType = data.match(/^(\d+)/)?.[1]
    
    // Route to appropriate handler based on message type
    switch (messageType) {
      case "0": // Connect message - Server is ready
        this.handleConnect(data)
        break
        
      case "40": // Connected acknowledgment - Handshake accepted
        this.handleConnectedAck(data)
        break
        
      case "42": // Event message - Regular events without acknowledgment
        this.handleEvent(data)
        break
        
      case "43": // Event with acknowledgment - Generic acknowledgment
        this.handleEventWithAck(data)
        break
        
      // Numbered acknowledgments (430-439) correspond to requests (420-429)
      case "430": // Response to 420 (usually joinRoom)
      case "431": // Response to 421 (usually getMessageHistory)
        this.handleMessageHistoryAck(data)
      case "432": // Response to 422
      case "433": // Response to 423
      case "434": // Response to 424
      case "435": // Response to 425
      case "436": // Response to 426
      case "437": // Response to 427
      case "438": // Response to 428 (usually sendMessage errors)
      case "439": // Response to 429
        this.handleNumberedAck(data)
        break
        
      case "2": // Ping from server - Keep-alive mechanism
        this.sendPong()
        this.lastPongAt = Date.now()
        break
        
      case "3": // Pong from server - Response to our ping
        // Update heartbeat timestamp
        this.lastPongAt = Date.now()
        break
        
      default:
        // Log unknown message types for debugging
        console.error(`Unknown message type: ${messageType}`)
    }
  }

  /**
   * Handles the initial connection message from the server.
   * This message contains configuration like ping interval.
   * @param {string} data - Raw message data starting with "0"
   * @private
   */
  private handleConnect(data: string) {
    // Remove the "0" prefix and parse the JSON
    const jsonData = data.substring(1)
    const connectData = JSON.parse(jsonData)
    
    // Set up ping interval if specified by server
    if (connectData.pingInterval) {
      this.startPing(connectData.pingInterval)
    }

    // Send socket.io handshake with origin and timestamp and optional token
    // The "40" prefix indicates this is a handshake message
    const payload = {
      origin: "https://pump.fun",
      timestamp: Date.now(),
      token: this.token,
    }
    this.send(`40${JSON.stringify(payload)}`)
  }

  /**
   * Handles the server's acknowledgment of our handshake.
   * After this, we can join the specific chat room.
   * @param {string} data - Raw message data starting with "40"
   * @private
   */
  private handleConnectedAck(data: string) {
    // Get the next acknowledgment ID (0-9)
    const joinAckId = this.getNextAckId()
    
    // Track this pending acknowledgment
    this.pendingAcks.set(joinAckId, { event: "joinRoom", timestamp: Date.now() })
    
    // Send joinRoom request with acknowledgment ID
    // Format: 42X["joinRoom",{...}] where X is the ack ID
    const joinMessage = `42${joinAckId}["joinRoom",{"roomId":"${this.roomId}","username":"${this.username}"}]`
    console.log(`🔗 Attempting to join room: ${this.roomId} with username: ${this.username}`)
    this.send(joinMessage)
    
    // Note: Message history request will be sent after successful join
  }

  /**
   * Handles regular event messages that don't expect acknowledgments.
   * These are typically server-initiated events.
   * @param {string} data - Raw message data starting with "42"
   * @private
   */
  private handleEvent(data: string) {
    try {
      // Remove "42" prefix and parse the JSON array
      const eventData = JSON.parse(data.substring(2))
      const [eventName, payload] = eventData

      // Handle different event types
      switch (eventName) {
        case "setCookie":
          // Server wants us to store a cookie (we don't actually use cookies)
          // After this, we can request message history
          this.requestMessageHistory()
          break
          
        case "newMessage":
          // A new chat message was posted
          this.handleNewMessage(payload)
          break
          
        case "userLeft":
          // A user left the chat room
          this.emit("userLeft", payload)
          break

        case "messageDeleted":
          // A message was deleted
          break
          
        default:
          console.error(`Unknown event: ${eventName}`)
      }
    } catch (error) {
      console.error("Error parsing event:", error)
    }
  }

  /**
   * Handles acknowledgment messages without specific IDs.
   * These are typically responses to requests without acknowledgment IDs.
   * @param {string} data - Raw message data starting with "43"
   * @private
   */
  private handleEventWithAck(data: string) {
    try {
      // Remove "43" prefix and parse the response
      const ackData = JSON.parse(data.substring(2))
      const eventData = ackData[0]
      
      // Handle different response formats for message history
      if (eventData && eventData.messages) {
        // Response includes a messages array in an object
        this.messageHistory = this.sortMessagesChronologically(eventData.messages).slice(-this.messageHistoryLimit)
        this.emit("messageHistory", this.messageHistory)
      } else if (Array.isArray(eventData)) {
        // Response is directly an array of messages
        this.messageHistory = this.sortMessagesChronologically(eventData).slice(-this.messageHistoryLimit)
        this.emit("messageHistory", this.messageHistory)
      } else if (Array.isArray(ackData) && ackData.length > 0) {
        // Response is wrapped in another array
        this.messageHistory = this.sortMessagesChronologically(ackData[0]).slice(-this.messageHistoryLimit)
        this.emit("messageHistory", this.messageHistory)
      }
    } catch (error) {
      console.error("Error parsing acknowledgment:", error)
    }
  }



  private handleMessageHistoryAck(data: string) {
    try {
      const ackData = JSON.parse(data.substring(2))
      this.messageHistory = this.sortMessagesChronologically(ackData).slice(-this.messageHistoryLimit)
      this.emit("messageHistory", this.messageHistory)
    } catch (error) {
      console.error("Error parsing message history acknowledgment:", error)
    }
  }

  /**
   * Handles numbered acknowledgment messages (430-439).
   * These correspond to our numbered requests (420-429).
   * @param {string} data - Raw message data starting with "43X"
   * @private
   */
  private handleNumberedAck(data: string) {
    try {
      // Extract the message type (e.g., "431" from "431[...]")
      const messageType = data.match(/^(\d+)/)?.[1]
      if (!messageType) return
      
      // Get the acknowledgment ID (last digit: 0-9)
      const ackId = parseInt(messageType.substring(2))
      
      // Look up the pending acknowledgment
      const pendingAck = this.pendingAcks.get(ackId)
      
      if (pendingAck) {
        // Remove from pending list
        this.pendingAcks.delete(ackId)
        console.error(`Received ack ${messageType} for ${pendingAck.event}`)
      }
      
      // Parse the response data (remove the 3-digit prefix)
      const ackData = JSON.parse(data.substring(3))
      
      // Handle response based on the original request type
      if (pendingAck?.event === "joinRoom") {
        // Successfully joined the room, now request message history
        console.log(`✅ Successfully joined room: ${this.roomId}`)
        this.requestMessageHistory()
      } else if (pendingAck?.event === "getMessageHistory") {
        // Received message history - support multiple response shapes
        const payload = ackData[0]
        if (Array.isArray(payload)) {
          this.messageHistory = this.sortMessagesChronologically(payload).slice(-this.messageHistoryLimit)
          this.emit("messageHistory", this.messageHistory)
        } else if (payload && Array.isArray(payload.messages)) {
          this.messageHistory = this.sortMessagesChronologically(payload.messages).slice(-this.messageHistoryLimit)
          this.emit("messageHistory", this.messageHistory)
        } else {
          // Fallback log to help diagnose unexpected formats
          try {
            console.error(
              "Unexpected getMessageHistory ack shape:",
              JSON.stringify(ackData).slice(0, 500)
            )
          } catch {}
        }
      } else if (pendingAck?.event === "sendMessage") {
        // Handle send message response (usually errors)
        if (ackData[0] && ackData[0].error) {
          console.error("Server error:", ackData[0])
          this.emit("serverError", ackData[0])
        }
      }
    } catch (error) {
      console.error("Error parsing numbered acknowledgment:", error)
    }
  }

  /**
   * Handles new chat messages from the server.
   * Adds the message to history and emits an event.
   * @param {IMessage} message - The new message object
   * @private
   */
  private handleNewMessage(message: any) {
    const normalized = this.normalizeMessage(message)
    // Add to message history
    this.messageHistory.push(normalized)
    
    // Maintain message history limit by removing oldest messages
    if (this.messageHistory.length > this.messageHistoryLimit) {
      this.messageHistory.shift() // Remove the oldest message
    }
    
    // Emit event for consumers
    this.emit("message", normalized)
  }

  /**
   * Initializes the connection sequence.
   * Currently a placeholder as the handshake is handled by message handlers.
   * @private
   */
  private initializeConnection() {
    // The connection sequence is event-driven:
    // 1. We send handshake (40) in handleConnect
    // 2. Server responds with acknowledgment (40)
    // 3. We join room in handleConnectedAck
    // 4. Server confirms join (430)
    // 5. We request message history
  }

  /**
   * Requests the chat message history from the server.
   * Uses an acknowledgment ID to match the response.
   * @private
   */
  private requestMessageHistory() {
    // Get next acknowledgment ID
    const historyAckId = this.getNextAckId()
    
    // Track this pending request
    this.pendingAcks.set(historyAckId, { event: "getMessageHistory", timestamp: Date.now() })
    
    // Send request with acknowledgment ID
    // Format: 42X["getMessageHistory",{...}] where X is the ack ID
    console.log(`📜 Requesting message history for room: ${this.roomId}`)
    this.send(`42${historyAckId}["getMessageHistory",{"roomId":"${this.roomId}","before":null,"limit":${this.messageHistoryLimit}}]`)
  }

  /**
   * Sends raw data through the WebSocket connection.
   * Checks connection state before sending.
   * @param {string} data - The data to send
   * @private
   */
  private send(data: string) {
    if (this.connection && this.isConnected) {
      this.connection.sendUTF(data)
    } else {
      console.error("Cannot send data: not connected")
    }
  }

  /**
   * Starts sending periodic ping messages to keep the connection alive.
   * The interval is usually specified by the server.
   * @param {number} interval - Milliseconds between ping messages
   * @private
   */
  private startPing(interval: number) {
    // We no longer send client-initiated pings for Engine.IO v4.
    // Just ensure heartbeat monitoring is enabled based on server interval.
    this.stopPing()
    this.startHeartbeat(Math.max(interval * 2, interval + 5000))
  }

  /**
   * Stops sending ping messages.
   * Called when disconnecting or before setting a new interval.
   * @private
   */
  private stopPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }
  }

  /**
   * Starts a heartbeat watchdog that monitors last pong time
   * and triggers a reconnect if the server stops responding.
   * @param {number} timeout - Milliseconds allowed between pongs
   * @private
   */
  private startHeartbeat(timeout: number) {
    this.stopHeartbeat()
    this.lastPongAt = Date.now()
    this.heartbeatMonitor = setInterval(() => {
      const now = Date.now()
      if (now - this.lastPongAt > timeout) {
        console.error("Heartbeat missed. Reconnecting...")
        try {
          this.connection?.close()
        } catch {}
        this.isConnected = false
        this.attemptReconnect()
      }
    }, Math.min(timeout, 15000))
  }

  /** Stops the heartbeat watchdog */
  private stopHeartbeat() {
    if (this.heartbeatMonitor) {
      clearInterval(this.heartbeatMonitor)
      this.heartbeatMonitor = null
    }
  }

  /**
   * Sends a pong message in response to a server ping.
   * This is part of the keep-alive mechanism.
   * @private
   */
  private sendPong() {
    this.send("3") // "3" is the pong message in socket.io
  }

  /**
   * Attempts to reconnect after a connection failure.
   * Uses exponential backoff to avoid overwhelming the server.
   * @private
   */
  private attemptReconnect() {
    // Don't reconnect if explicitly disconnected
    if (this.isExplicitlyDisconnected) {
      console.log("Skipping reconnection - explicitly disconnected")
      return
    }
    
    // Check if we've exceeded max attempts
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++
      
      // Calculate exponential backoff delay
      // Starts at 2 seconds, doubles each time, max 30 seconds
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000)
      
      console.error(`Attempting to reconnect in ${delay}ms...`)
      
      // Schedule reconnection attempt
      setTimeout(() => {
        // Check again before reconnecting in case disconnect was called during delay
        if (!this.isExplicitlyDisconnected) {
          this.connect()
        }
      }, delay)
    } else {
      // Max attempts reached, notify consumers
      this.emit("maxReconnectAttemptsReached")
    }
  }

  /**
   * Connects to the pump.fun chat room.
   * Sets up all required headers for the WebSocket handshake.
   * @public
   * @example
   * ```typescript
   * const client = new PumpChatClient({ roomId: 'token123' });
   * client.connect();
   * ```
   */
  public connect() {
    // Reset the explicit disconnect flag when connecting
    this.isExplicitlyDisconnected = false
    
    // Headers required for successful WebSocket connection to pump.fun
    const headers: { [key: string]: string } = {
      // Standard WebSocket headers
      "Host": "livechat.pump.fun",
      "Connection": "Upgrade",
      "Pragma": "no-cache",
      "Cache-Control": "no-cache",
      
      // Browser identification
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
      
      // WebSocket specific headers
      "Upgrade": "websocket",
      "Origin": "https://pump.fun",
      "Sec-WebSocket-Version": "13",
      
      // Compression and language preferences
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "Accept-Language": "en-US,en;q=0.9",
      "Sec-WebSocket-Extensions": "permessage-deflate; client_max_window_bits"
    }

    if (this.token) {
      headers["auth-token"] = this.token
    }

    // Initiate WebSocket connection
    // EIO=4 specifies Engine.IO protocol version 4
    this.client.connect(
      "wss://livechat.pump.fun/socket.io/?EIO=4&transport=websocket",
      undefined, // No specific protocol
      undefined, // Use default origin
      headers
    )
  }

  /**
   * Disconnects from the chat room.
   * Stops all timers and closes the WebSocket connection.
   * @public
   * @example
   * ```typescript
   * client.disconnect();
   * ```
   */
  public disconnect() {
    // Set flag to prevent reconnection
    this.isExplicitlyDisconnected = true
    
    // Stop sending ping messages
    this.stopPing()
    
    // Stop acknowledgment cleanup
    this.stopAckCleanup()
    
    // Clear pending acknowledgments
    this.pendingAcks.clear()
    
    // Close the WebSocket connection if active
    if (this.connection) {
      this.connection.close()
    }
    
    // Reset connection state
    this.isConnected = false
    this.connection = null
  }

  /**
   * Retrieves stored chat messages.
   * @param {number} [limit] - Maximum number of messages to return (most recent)
   * @returns {IMessage[]} Array of chat messages
   * @public
   * @example
   * ```typescript
   * // Get all stored messages
   * const allMessages = client.getMessages();
   * 
   * // Get last 10 messages
   * const recentMessages = client.getMessages(10);
   * ```
   */
  public getMessages(limit?: number): IMessage[] {
    if (limit) {
      // Return the most recent messages up to the limit
      return this.messageHistory.slice(-limit)
    }
    // Return a copy of all messages to prevent external modifications
    return [...this.messageHistory]
  }

  /**
   * Gets the most recent message from the chat.
   * @returns {IMessage | null} The latest message or null if no messages
   * @public
   * @example
   * ```typescript
   * const latest = client.getLatestMessage();
   * if (latest) {
   *   console.log(`Latest: ${latest.username}: ${latest.message}`);
   * }
   * ```
   */
  public getLatestMessage(): IMessage | null {
    return this.messageHistory[this.messageHistory.length - 1] || null
  }

  /**
   * Sends a message to the chat room.
   * Note: Requires authentication with pump.fun to work.
   * @param {string} message - The message text to send
   * @public
   * @example
   * ```typescript
   * client.sendMessage('Hello everyone!');
   * ```
   * @remarks
   * Sending messages requires being logged into pump.fun with valid session cookies.
   * Without authentication, you'll receive a "Authentication required" error.
   */
  public sendMessage(message: string) {
    if (this.isConnected) {
      // Get acknowledgment ID for this request
      const sendAckId = this.getNextAckId()
      
      // Track pending acknowledgment
      this.pendingAcks.set(sendAckId, { event: "sendMessage", timestamp: Date.now() })
      
      // Send message with acknowledgment ID
      // Format: 42X["sendMessage",{...}] where X is the ack ID
      this.send(`42${sendAckId}["sendMessage",{"roomId":"${this.roomId}","message":"${message}","username":"${this.username}"}]`)
    } else {
      console.error("Cannot send message: not connected")
    }
  }

  /**
   * Deletes a message via pump.fun moderation HTTP endpoint.
   * Requires a valid token to be provided when constructing the client.
   * Also removes the message from local history and re-emits 'messageHistory'.
   * @param {string} messageId - The message id to delete
   * @param {string} [reason="TOXIC"] - Reason for deletion sent to the server
   * @returns {Promise<{ ok: boolean, status: number, body?: unknown }>}
   * @public
   */
  public async deleteMessage(
    msg: IMessage,
    reason: string = "TOXIC"
  ): Promise<{ ok: boolean; status: number; body?: unknown }> {
    if (!this.token) {
      throw new Error("deleteMessage requires an auth token. Provide 'token' when creating PumpChatClient.")
    }

    const iso = msg.timestamp instanceof Date ? msg.timestamp.getTime() : String(msg.timestamp)
    let timestamp = msg.timestamp ? iso : null != msg.id ? msg.id : '';

    const url = `https://livechat.pump.fun/chat/moderation/rooms/${encodeURIComponent(
      this.roomId
    )}/messages/${encodeURIComponent(timestamp)}/delete`
    const headers: { [key: string]: string } = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/plain, */*",
      "Origin": "https://pump.fun",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
    }

    // Include token in both common forms used by the service
    headers["Cookie"] = `auth-token=${this.token}`
    headers["auth-token"] = `${this.token}`
    headers["Authorization"] = `Bearer ${this.token}`

    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
    const maxRetries = 5
    let attempt = 0
    let response: Response | null = null
    let responseBody: unknown = undefined

    while (attempt <= maxRetries) {
      try {
        response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ reason }),
        })

        if (response.status === 429) {
          // Respect Retry-After if present; otherwise exponential backoff with jitter
          const ra = response.headers.get("retry-after") || response.headers.get("Retry-After")
          let waitMs = 0
          if (ra) {
            const asNumber = Number(ra)
            if (!Number.isNaN(asNumber)) {
              waitMs = Math.max(0, asNumber * 1000)
            } else {
              const dateMs = Date.parse(ra)
              if (!Number.isNaN(dateMs)) {
                waitMs = Math.max(0, dateMs - Date.now())
              }
            }
          }
          if (!waitMs) {
            const base = 500 * Math.pow(2, attempt)
            const jitter = Math.floor(Math.random() * 250)
            waitMs = Math.min(30000, base + jitter)
          }
          attempt++
          await sleep(waitMs)
          continue
        }

        // Parse body if possible (may be empty)
        try {
          responseBody = await response.json()
        } catch {}

        if (!response.ok) {
          this.emit("serverError", responseBody || { status: response.status })
          return { ok: false, status: response.status, body: responseBody }
        }

        // Success path
        break
      } catch (err) {
        // Network/transport error - retry with backoff
        if (attempt >= maxRetries) {
          this.emit("error", err)
          return { ok: false, status: 0, body: undefined }
        }
        const backoff = Math.min(30000, 500 * Math.pow(2, attempt))
        attempt++
        await sleep(backoff)
      }
    }

    // Remove from local history if present
    const beforeLength = this.messageHistory.length
    this.messageHistory = this.messageHistory.filter((m) => m.id !== msg.id)
    if (this.messageHistory.length !== beforeLength) {
      // this.emit("messageHistory", this.messageHistory)
    }

    return { ok: true, status: (response as Response).status, body: responseBody }
  }

  /**
   * Gets the next acknowledgment ID for socket.io protocol.
   * IDs cycle from 0 to 9 to match requests with responses.
   * @returns {number} The next acknowledgment ID (0-9)
   * @private
   */
  private getNextAckId(): number {
    const currentId = this.ackId
    // Increment and wrap around at 10
    this.ackId = (this.ackId + 1) % 10
    return currentId
  }

  /**
   * Cleans up acknowledgments that never received responses.
   * This prevents memory leaks from accumulating pending acknowledgments.
   * @private
   */
  private cleanupStaleAcks() {
    const now = Date.now()
    const timeout = 30000 // 30 seconds timeout for acknowledgments
    
    // Iterate through pending acknowledgments
    for (const [id, ack] of this.pendingAcks.entries()) {
      // Check if acknowledgment has timed out
      if (now - ack.timestamp > timeout) {
        this.pendingAcks.delete(id)
        console.error(`Cleaned up stale ack ${id} for ${ack.event}`)
      }
    }
  }

  // Dedicated interval reference so we can clear it on disconnect
  private ackCleanupInterval: NodeJS.Timeout | null = null

  private stopAckCleanup() {
    if (this.ackCleanupInterval) {
      clearInterval(this.ackCleanupInterval)
      this.ackCleanupInterval = null
    }
  }

  /**
   * Sorts messages in chronological order (oldest to newest) by timestamp
   * @param {IMessage[]} messages - Array of messages to sort
   * @returns {IMessage[]} Sorted messages array
   * @private
   */
  private sortMessagesChronologically(messages: any[]): IMessage[] {
    return [...messages].map(this.normalizeMessage).sort((a, b) => {
      const at = a.timestamp.getTime()
      const bt = b.timestamp.getTime()
      return at - bt
    })
  }

  /**
   * Normalizes raw message objects from server to IMessage with Date timestamp
   */
  private normalizeMessage(message: any): IMessage {
    const ts = message.timestamp
    const parsed = ts instanceof Date ? ts : new Date(ts)
    return {
      id: message.id,
      roomId: message.roomId,
      username: message.username,
      userAddress: message.userAddress,
      message: message.message,
      profile_image: message.profile_image,
      timestamp: parsed,
      messageType: message.messageType,
      expiresAt: message.expiresAt,
    }
  }

  /**
   * Checks if the client is currently connected to the chat room.
   * @returns {boolean} True if connected, false otherwise
   * @public
   * @example
   * ```typescript
   * if (client.isActive()) {
   *   client.sendMessage('Hello!');
   * }
   * ```
   */
  public isActive(): boolean {
    return this.isConnected
  }
}

/**
 * Export the IMessage interface for external use
 * @exports IMessage
 */
export type { IMessage }