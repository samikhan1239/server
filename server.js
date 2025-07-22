require("dotenv").config({ path: "./.env.local" });

const { WebSocketServer } = require("ws");
const mongoose = require("mongoose");
const { parse } = require("url");
const http = require("http");

// MongoDB Models
const Message = require("./models/Message");
const User = require("./models/User");

const port = process.env.PORT || 8080; // Use PORT for Render compatibility
let wss;

// Connect to MongoDB
async function connectDB() {
  if (mongoose.connection.readyState >= 1) return;
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is not defined in .env.local");
  }
  await mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });
  console.log("✅ MongoDB connected");
}

// Create HTTP server required for WebSocket server on Render
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("WebSocket server running...");
});

// Initialize WebSocket server
function startWebSocketServer() {
  if (wss) return wss;

  wss = new WebSocketServer({ server });

  wss.on("connection", async (ws, req) => {
    const { query } = parse(req.url, true);
    const { gigId, sellerId, userId } = query;

    if (!gigId || !sellerId || !userId) {
      ws.close(1008, "Missing required query parameters");
      return;
    }

    ws.url = req.url;

    ws.on("message", async (data) => {
      try {
        const message = JSON.parse(data);

        if (!message.gigId || !message.senderId || !message.text) {
          ws.send(JSON.stringify({ error: "Invalid message format" }));
          return;
        }

        await connectDB();

        const savedMessage = await Message.create({
          gigId: mongoose.Types.ObjectId(message.gigId),
          userId: mongoose.Types.ObjectId(message.senderId),
          recipientId: message.recipientId
            ? mongoose.Types.ObjectId(message.recipientId)
            : null,
          text: message.text,
          timestamp: new Date(message.timestamp),
        });

        const populatedMessage = await Message.findById(savedMessage._id)
          .populate("userId", "name avatar")
          .lean();

        // Broadcast to relevant clients
        wss.clients.forEach((client) => {
          if (
            client.readyState === ws.OPEN &&
            client.url &&
            client.url.includes(`gigId=${gigId}`) &&
            (client.url.includes(`userId=${sellerId}`) || client.url.includes(`userId=${userId}`))
          ) {
            client.send(JSON.stringify(populatedMessage));
          }
        });
      } catch (err) {
        console.error("Error processing message:", err);
        ws.send(JSON.stringify({ error: "Server error" }));
      }
    });

    ws.on("close", () => {
      console.log("WebSocket disconnected:", { gigId, sellerId, userId });
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
      console.log(`✅ Server running on http://localhost:${port}`);
    });
  } catch (err) {
    console.error("❌ Server failed to start:", err);
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
  }
});
