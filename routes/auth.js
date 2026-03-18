import express from "express";
import { register, login, getMe, migrateSessionThreads } from "../controllers/authController.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

router.post("/register", register);
router.post("/login", login);
router.get("/me", requireAuth, getMe);
router.post("/migrate-threads", requireAuth, migrateSessionThreads);

export default router;
