import express from "express";
import { getAllStates, getStateDetails } from "../models/statesModel.js";

const router = express.Router();

// GET all states
router.get("/", async (req, res) => {
  try {
    const states = await getAllStates();
    res.json(states);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET state details by slug
router.get("/:slug", async (req, res) => {
  try {
    const slug = req.params.slug.toLowerCase();
    const state = await getStateDetails(slug);
    if (!state) return res.status(404).json({ message: "State not found" });
    res.json(state);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
