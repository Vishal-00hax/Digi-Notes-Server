import express from "express";
import {
  createNotes,
  updateNotes,
  deleteNotes,
  getNotesById,
  getUserNotes,
} from "../controllers/notesController.js";
import { userAuth } from "../middelware/authMiddelware.js";
import { askNotes } from "../controllers/askController.js";

const notesRouter = express.Router();

notesRouter.post("/create", userAuth, createNotes);
notesRouter.post("/ask-ai", userAuth, askNotes);
notesRouter.get("/user", userAuth, getUserNotes);
notesRouter.get("/get/:notesId", userAuth, getNotesById);
notesRouter.patch("/update", userAuth, updateNotes);
notesRouter.delete("/delete/:notesId", userAuth, deleteNotes);

export default notesRouter;
