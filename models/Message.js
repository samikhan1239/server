const mongoose = require("mongoose");

   const MessageSchema = new mongoose.Schema({
     gigId: { type: mongoose.Schema.Types.ObjectId, ref: "Gig", required: true },
     userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
     recipientId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
     text: { type: String, required: true },
     timestamp: { type: Date, default: Date.now },
   });

   module.exports = mongoose.models.Message || mongoose.model("Message", MessageSchema);