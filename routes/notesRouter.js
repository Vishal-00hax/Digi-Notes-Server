import express from "express";
import {
  createNotes,
  updateNotes,
  deleteNotes,
} from "../controllers/notesController.js";
import { userAuth } from "../middelware/authMiddelware.js";

const notesRouter = express.Router();

notesRouter.post("/create", userAuth, createNotes);
notesRouter.patch("/update", userAuth, updateNotes);
notesRouter.delete("/delete/:notesId", userAuth, deleteNotes);

export default notesRouter;
