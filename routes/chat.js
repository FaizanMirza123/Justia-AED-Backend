import express from "express";
import { handleChat } from "../controllers/chatController.js";
import { optionalAuth } from "../middleware/auth.js";

const router = express.Router();

// POST /api/chat - Send a message to the AED law assistant
// Uses optional auth: authenticated users get persistent threads,
// anonymous users get session-based threads with max-age expiry
router.post("/", optionalAuth, handleChat);

export default router;
