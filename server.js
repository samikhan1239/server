require("dotenv").config({ path: "./.env.local" });

const { WebSocketServer } = require("ws");
const mongoose = require("mongoose");
const { parse } = require("url");
const http = require("http");

// MongoDB Models
const Message = require("./models/Message");
const User = require("./models/User");

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
  if (wss) return wss;

  wss = new WebSocketServer({ server });

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

    ws.on("message", async (data) => {
      try {
        const message = JSON.parse(data);

        // Validate message format
        if (!message.gigId || !message.senderId || !message.text) {
          ws.send(JSON.stringify({ error: "Invalid message format" }));
          return;
        }

        // Validate message ObjectIds
        if (
          !mongoose.Types.ObjectId.isValid(message.gigId) ||
          !mongoose.Types.ObjectId.isValid(message.senderId) ||
          (message.recipientId && !mongoose.Types.ObjectId.isValid(message.recipientId))
        ) {
          ws.send(JSON.stringify({ error: "Invalid message IDs" }));
          return;
        }

        await connectDB();

        // Relaxed duplicate message check (increased window to 5 seconds)
        const existingMessage = await Message.findOne({
          gigId: message.gigId,
          userId: message.senderId,
          text: message.text,
          timestamp: { $gte: new Date(message.timestamp - 5000) },
        });
        if (existingMessage) {
          console.log("🔍 Duplicate message detected:", {
            gigId: message.gigId,
            senderId: message.senderId,
            text: message.text,
            timestamp: message.timestamp,
            existing: existingMessage,
          });
          ws.send(JSON.stringify({ error: "Duplicate message detected" }));
          return;
        }

        const savedMessage = await Message.create({
          gigId: mongoose.Types.ObjectId.createFromHexString(message.gigId),
          userId: mongoose.Types.ObjectId.createFromHexString(message.senderId),
          recipientId: message.recipientId
            ? mongoose.Types.ObjectId.createFromHexString(message.recipientId)
            : null,
          text: message.text,
          timestamp: new Date(message.timestamp),
          read: false,
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
        console.error("❌ Error processing message:", {
          message: err.message,
          name: err.name,
          stack: err.stack,
        });
        ws.send(JSON.stringify({ error: "Server error" }));
      }
    });

    ws.on("close", () => {
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