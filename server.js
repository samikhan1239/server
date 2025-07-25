// WebSocket Server (index.js or similar)
require("dotenv").config({ path: "./.env.local" });

const { WebSocketServer } = require("ws");
const mongoose = require("mongoose");
const { parse } = require("url");
const http = require("http");

// MongoDB Models
const Message = require("./models/Message");
const User = require("./models/User");

// Explicitly register User model to avoid MissingSchemaError
mongoose.model("User");

// Use PORT for Render compatibility, default to 10000 for local
const port = process.env.PORT || 10000;
let wss;

// Connect to MongoDB
async function connectDB() {
  if (mongoose.connection.readyState >= 1) return;
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is not defined in .env.local");
  }
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("✅ MongoDB connected");
  } catch (err) {
    console.error("❌ MongoDB connection error:", {
      message: err.message,
      name: err.name,
      stack: err.stack,
    });
    throw err;
  }
}

// Create HTTP server for WebSocket on Render
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", mongoConnected: mongoose.connection.readyState === 1 }));
  } else {
    res.writeHead(200);
    res.end("WebSocket server running...");
  }
});

// Initialize WebSocket server
function startWebSocketServer() {
  if (wss) {
    console.log("✅ WebSocket server already running");
    return wss;
  }

  wss = new WebSocketServer({ server });
  console.log("✅ WebSocket server initialized");

  const activeConnections = new Map(); // Map<userId, Set<WebSocket>>

  wss.on("connection", async (ws, req) => {
    const { query } = parse(req.url, true);
    const { gigId, sellerId, userId } = query;

    // Validate query parameters
    if (!gigId || !sellerId || !userId) {
      ws.send(JSON.stringify({ error: "Missing required query parameters" }));
      ws.close(1008, "Missing gigId, sellerId, or userId");
      return;
    }

    // Validate ObjectIds
    if (
      !mongoose.Types.ObjectId.isValid(gigId) ||
      !mongoose.Types.ObjectId.isValid(sellerId) ||
      !mongoose.Types.ObjectId.isValid(userId)
    ) {
      ws.send(JSON.stringify({ error: "Invalid gigId, sellerId, or userId" }));
      ws.close(1008, "Invalid gigId, sellerId, or userId");
      return;
    }

    console.log("✅ WebSocket connected:", { gigId, sellerId, userId });

    // Store query parameters on ws
    ws.query = { gigId, sellerId, userId };

    // Manage active connections
    if (!activeConnections.has(userId)) {
      activeConnections.set(userId, new Set());
    }
    const userConnections = activeConnections.get(userId);
    userConnections.add(ws);

    // Close older connections for the same userId and gigId
    if (userConnections.size > 1) {
      userConnections.forEach((client) => {
        if (client !== ws && client.query.gigId === gigId) {
          client.close(1008, "Duplicate connection");
          userConnections.delete(client);
          console.log("🔌 Closed duplicate connection for userId:", userId, "gigId:", gigId);
        }
      });
    }

    ws.on("message", async (data) => {
      try {
        const message = JSON.parse(data);
        console.log("Received WebSocket message:", message);

        // Validate message format
        if (!message.gigId || !message.senderId || !message.text) {
          console.log("❌ Invalid message format:", message);
          ws.send(JSON.stringify({ error: "Invalid message format: Missing gigId, senderId, or text" }));
          return;
        }

        // Validate message ObjectIds
        if (
          !mongoose.Types.ObjectId.isValid(message.gigId) ||
          !mongoose.Types.ObjectId.isValid(message.senderId) ||
          (message.recipientId && !mongoose.Types.ObjectId.isValid(message.recipientId))
        ) {
          console.log("❌ Invalid message IDs:", message);
          ws.send(JSON.stringify({ error: "Invalid message IDs" }));
          return;
        }

        // Create unique messageId
        const messageId = message.messageId || `${message.senderId}:${message.timestamp || Date.now()}`;
        const existingMessage = await Message.findOne({ messageId });
        if (existingMessage) {
          console.log("🔍 Duplicate message ignored:", { messageId, _id: existingMessage._id });
          return;
        }

        await connectDB();

        const savedMessage = await Message.create({
          gigId: mongoose.Types.ObjectId.createFromHexString(message.gigId),
          userId: mongoose.Types.ObjectId.createFromHexString(message.senderId),
          recipientId: message.recipientId
            ? mongoose.Types.ObjectId.createFromHexString(message.recipientId)
            : null,
          text: message.text,
          timestamp: new Date(message.timestamp || Date.now()),
          read: false,
          messageId,
        });

        const populatedMessage = await Message.findById(savedMessage._id)
          .populate("userId", "name avatar")
          .lean();

        if (!populatedMessage) {
          console.error("❌ Failed to populate message:", savedMessage._id);
          ws.send(JSON.stringify({ error: "Failed to retrieve message details" }));
          return;
        }

        console.log("✅ Message saved:", populatedMessage);

        // Broadcast to relevant clients
        wss.clients.forEach((client) => {
          if (
            client.readyState === WebSocket.OPEN &&
            client.query &&
            client.query.gigId === gigId &&
            (client.query.userId === sellerId || client.query.userId === userId)
          ) {
            client.send(JSON.stringify(populatedMessage));
          } else {
            console.log("🔍 Skipping client:", {
              readyState: client.readyState,
              query: client.query,
              matchesGig: client.query?.gigId === gigId,
              matchesUser: client.query?.userId === sellerId || client.query?.userId === userId,
            });
          }
        });
      } catch (err) {
        if (err.code === 11000) {
          console.log("🔍 Duplicate messageId ignored:", messageId);
          return;
        }
        console.error("❌ Error processing message:", {
          message: err.message,
          name: err.name,
          stack: err.stack,
        });
        ws.send(JSON.stringify({ error: "Server error" }));
      }
    });

    ws.on("close", () => {
      userConnections.delete(ws);
      if (userConnections.size === 0) {
        activeConnections.delete(userId);
      }
      console.log("🔌 WebSocket disconnected:", { gigId, sellerId, userId });
    });
  });

  return wss;
}

// Start everything
async function start() {
  try {
    console.log("🟡 Connecting to MongoDB...");
    await connectDB();

    startWebSocketServer();

    server.listen(port, () => {
      console.log(`✅ Server running on http://localhost:${port} (local) or Render-assigned port`);
    });
  } catch (err) {
    console.error("❌ Server failed to start:", {
      message: err.message,
      name: err.name,
      stack: err.stack,
    });
    process.exit(1);
  }
}

start();

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("🔻 Shutting down...");
  if (wss) {
    wss.close(() => {
      mongoose.connection.close(() => {
        console.log("✅ Clean shutdown");
        process.exit(0);
      });
    });
  } else {
    mongoose.connection.close(() => {
      console.log("✅ MongoDB connection closed");
      process.exit(0);
    });
  }
});