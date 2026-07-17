import express from "express";
import { userAuth } from "../middelware/authMiddelware.js";
import {
  userSignUp,
  userLogIn,
  userProfile,
} from "../controllers/authController.js";

const authRouter = express.Router();

authRouter.post("/signup", userSignUp);
authRouter.post("/login", userLogIn);
authRouter.get("/profile", userAuth, userProfile);

export default authRouter;
