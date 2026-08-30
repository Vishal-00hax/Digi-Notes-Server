import express from "express";
import { userAuth } from "../middelware/authMiddelware.js";
import {
  userSignUp,
  userLogIn,
  userLogout,
  userProfile,
  refreshAccessToken,
  logoutAllSessions,
} from "../controllers/authController.js";

const authRouter = express.Router();

authRouter.post("/signup", userSignUp);
authRouter.post("/login", userLogIn);
authRouter.post("/refresh", refreshAccessToken);
authRouter.post("/logout", userAuth, userLogout);
authRouter.get("/profile", userAuth, userProfile);
authRouter.post("/all-session-logout", userAuth, logoutAllSessions);

export default authRouter;
