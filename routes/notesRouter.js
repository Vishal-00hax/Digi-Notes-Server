import express from "express";
import {
  createNotes,
  updateNotes,
  deleteNotes,
  getNotesById,
  getUserNotes,
} from "../controllers/notesController.js";
import { userAuth } from "../middelware/authMiddelware.js";
import { askNotes, aiChats, deleteChat } from "../controllers/askController.js";

const notesRouter = express.Router();

notesRouter.post("/create", userAuth, createNotes);
notesRouter.post("/ask-ai", userAuth, askNotes);
notesRouter.get("/user", userAuth, getUserNotes);
notesRouter.get("/get/:notesId", userAuth, getNotesById);
notesRouter.get("/ai/chats", userAuth, aiChats);
notesRouter.patch("/update", userAuth, updateNotes);
notesRouter.delete("/delete/:notesId", userAuth, deleteNotes);
notesRouter.delete("/chat/delete/:chatId", userAuth, deleteChat);

export default notesRouter;
