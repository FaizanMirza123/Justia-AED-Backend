import express from "express";
import { optionalAuth } from "../middleware/auth.js";
import {
  listThreads,
  createThread,
  getThreadMessages,
  deleteThread,
  updateThread,
} from "../controllers/threadController.js";

const router = express.Router();

// All thread routes use optional auth (works for both anonymous + authenticated)
router.use(optionalAuth);

router.get("/", listThreads);
router.post("/", createThread);
router.get("/:id/messages", getThreadMessages);
router.patch("/:id", updateThread);
router.delete("/:id", deleteThread);

export default router;
