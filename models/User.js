// models/User.js
// ✅ Correct
const mongoose = require("mongoose");


const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  avatar: { type: String, default: "/default-avatar.png" },
  level: { type: String, default: "New Seller" },
  rating: { type: Number, default: 0 },
  responseTime: { type: String, default: "1 hour" },
  location: { type: String, default: "Unknown" },
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.models.User || mongoose.model("User", userSchema);