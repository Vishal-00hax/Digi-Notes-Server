import { json } from "express";
import User from "../models/user.js";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import RefreshToken from "../models/refreshToken.js";
import { getIO } from "../utils/socket-io.js";

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
};

const REFRESH_TOKEN_TTL_DAYS = 7; // 7 days
const refreshToken_Expires = () =>
  new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

export const userSignUp = async (req, res) => {
  try {
    const { full_name, email, password } = req.body;
    const userIP = req.ip;

    if (!full_name || !email || !password) {
      return res.status(400).json({ message: "Invalid crediancials" });
    }

    const exsistingUser = await User.findOne({ email: email });

    if (exsistingUser) {
      return res.status(400).json({ message: "User already exsist" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = new User({
      full_name: full_name,
      email: email,
      password: hashedPassword,
    });

    const accessToken = user.getAccessToken();
    const refreshToken = user.getRefreshToken();

    const newUser = await user.save();

    await RefreshToken.findOneAndUpdate(
      { userId: newUser._id },
      {
        $push: { token: refreshToken },
        $set: { ip: userIP, expiresAt: refreshToken_Expires() },
      },
      { upsert: true, new: true },
    );

    res.cookie("accessToken", accessToken, {
      ...COOKIE_OPTIONS,
      maxAge: 15 * 60 * 1000,
    }); // 15 min

    res.cookie("refreshToken", refreshToken, {
      ...COOKIE_OPTIONS,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    }); // 7 days

    newUser.password = undefined;

    res.status(201).json({ user: newUser });
  } catch (err) {
    res.status(400).json({ message: "User Creating failed " + err.message });
  }
};

export const userLogIn = async (req, res) => {
  try {
    const { email, password } = req.body;
    const userIP = req.ip;
    const user = await User.findOne({ email: email }).select("-__v");
    if (!user) {
      return res.status(404).json({ message: "User not found !" });
    }
    const isMatch = await user.verifyPassword(password);
    if (!isMatch) {
      return res.status(400).json({ message: "Invalid Inputs" });
    }

    const accessToken = user.getAccessToken();
    const refreshToken = user.getRefreshToken();

    await user.save();

    await RefreshToken.findOneAndUpdate(
      { userId: user._id },
      {
        $push: { token: refreshToken },
        $set: { ip: userIP, expiresAt: refreshToken_Expires() },
      },
      { upsert: true, new: true }, // upsert is a database operation that inserts a new row if a record does not exist or updates the existing row if it already matches a unique key or index.
    );

    res.cookie("accessToken", accessToken, {
      ...COOKIE_OPTIONS,
      maxAge: 15 * 60 * 1000,
    }); // 15 min

    res.cookie("refreshToken", refreshToken, {
      ...COOKIE_OPTIONS,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    }); // 7 days

    user.password = undefined;
    user.__v = undefined;
    res.status(200).json({ user: user });
  } catch (err) {
    res.status(500).json({ message: "Internal server error" });
  }
};

export const userLogout = async (req, res) => {
  try {
    const userId = req.user?._id;
    const incomingRefreshToken = req.cookies?.refreshToken;

    if (userId && incomingRefreshToken) {
      await RefreshToken.updateOne(
        { userId: userId },
        { $pull: { token: incomingRefreshToken } },
      );
    }

    res.clearCookie("accessToken", COOKIE_OPTIONS);
    res.clearCookie("refreshToken", COOKIE_OPTIONS);

    res.json({ message: "Logout Successfull" });
  } catch (err) {
    res.status(500).json({ message: "Internal server error" });
  }
};

export const userProfile = async (req, res) => {
  try {
    const user = req.user;
    const userId = req.user._id;

    user.password = undefined;
    user.__v = undefined;

    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    const sessionDoc = await RefreshToken.findOne({ userId: userId });
    const total_session = sessionDoc ? sessionDoc.token.length : 0;

    res.status(200).json({ user: user, total_sessions: total_session });
  } catch (err) {
    res.status(500).json({ message: "Internal server error" });
  }
};

export const refreshAccessToken = async (req, res) => {
  try {
    const incomingRefreshToken = req.cookies?.refreshToken;
    if (!incomingRefreshToken) {
      return res
        .status(401)
        .json({ message: "Refresh token missing, please login again" });
    }

    let decoded;
    try {
      decoded = jwt.verify(incomingRefreshToken, process.env.JWT_SECRET);
    } catch (err) {
      console.error("JWT verify error:", err.message);
      return res
        .status(401)
        .json({ message: "Invalid or expired refresh token" });
    }

    const userId = decoded._id;
    if (!userId) {
      return res.status(401).json({ message: "Invalid token payload" });
    }

    // Find the doc ONLY if it actually contains this exact token
    const refreshTokenDoc = await RefreshToken.findOne({
      userId,
      token: incomingRefreshToken,
    });

    if (!refreshTokenDoc) {
      return res
        .status(401)
        .json({ message: "Refresh token not found or already used" });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(401).json({ message: "User not found" });
    }

    const newAccessToken = user.getAccessToken();
    const newRefreshToken = user.getRefreshToken();

    // Rotate: remove old token, add new one
    refreshTokenDoc.token = refreshTokenDoc.token.filter(
      (t) => t !== incomingRefreshToken,
    );
    refreshTokenDoc.token.push(newRefreshToken);
    refreshTokenDoc.expiresAt = refreshToken_Expires(); // refresh sliding expiry
    await refreshTokenDoc.save();

    res.cookie("accessToken", newAccessToken, {
      ...COOKIE_OPTIONS,
      maxAge: 15 * 60 * 1000, // 15 min — fix the 1-min bug too
    });

    res.cookie("refreshToken", newRefreshToken, {
      ...COOKIE_OPTIONS,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return res.status(200).json({ message: "Access token refreshed" });
  } catch (err) {
    console.error("Refresh error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

export const logoutAllSessions = async (req, res) => {
  try {
    const userId = req.user?._id;

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const deleteToken = await RefreshToken.deleteOne({
      userId: userId,
    });
    if (deleteToken.deletedCount === 0) {
      return res.status(404).json({ message: "Tokens not found !" });
    }

    await User.findByIdAndUpdate(userId, {
      tokenValidAfter: new Date(),
    });

    res.clearCookie("accessToken", COOKIE_OPTIONS);
    res.clearCookie("refreshToken", COOKIE_OPTIONS);

    try {
      const io = getIO();
      io.to(userId.toString()).emit("force-logout"); // room name = userId.toString() (aapke socket file ke hisaab se)
    } catch (socketErr) {
      console.error("Socket emit failed:", socketErr.message);
      // socket fail hone par bhi logout API fail nahi honi chahiye
    }

    return res
      .status(200)
      .json({ message: "Logout successfull from all sessions" });
  } catch (err) {
    console.error("logoutAllSessions error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};
