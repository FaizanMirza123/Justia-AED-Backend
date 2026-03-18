import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import statesRoutes from "./routes/states.js";
import lawsRouter from "./routes/laws.js";
import chatRouter from "./routes/chat.js";
import authRouter from "./routes/auth.js";
import threadsRouter from "./routes/threads.js";
import { createTables } from "./db/createTables.js";
import { startCleanupScheduler } from "./db/cleanup.js";

dotenv.config();
const app = express();

const corsOptions = {
  origin: [process.env.FRONTEND_URL, "http://localhost:5173"],
  credentials: true,
};

app.use(cors(corsOptions));
app.use(express.json());

const startServer = async () => {
  await createTables();

  app.use("/api/states", statesRoutes);
  app.use("/api/laws", lawsRouter);
  app.use("/api/chat", chatRouter);
  app.use("/api/auth", authRouter);
  app.use("/api/threads", threadsRouter);

  app.get("/", (req, res) => res.send("Backend running..."));

  // Start cleanup for expired anonymous chats
  startCleanupScheduler();

  app.listen(process.env.PORT, () => {
    console.log(`Server running on port ${process.env.PORT}`);
  });
};

startServer();
