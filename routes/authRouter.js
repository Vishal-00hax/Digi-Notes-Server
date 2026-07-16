import express from "express";
import { userSignUp } from "../controllers/authController.js";

const authRouter = express.Router();

authRouter.post("/signup", userSignUp);

export default authRouter;
