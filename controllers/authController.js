import { json } from "express";
import User from "../models/user.js";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
};

export const userSignUp = async (req, res) => {
  try {
    const { full_name, email, password } = req.body;

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
    user.refreshToken.push(refreshToken);

    const newUser = await user.save();

    res.cookie("accessToken", accessToken, {
      ...COOKIE_OPTIONS,
      maxAge: 15 * 60 * 1000,
    }); // 15 min

    res.cookie("refreshToken", refreshToken, {
      ...COOKIE_OPTIONS,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    }); // 7 days

    newUser.password = undefined;
    newUser.refreshToken = undefined;

    res.status(201).json({ user: newUser });
  } catch (err) {
    res.status(400).json({ message: "User Creating failed " + err.message });
  }
};

export const userLogIn = async (req, res) => {
  try {
    const { email, password } = req.body;
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

    user.refreshToken.push(refreshToken);
    await user.save();

    res.cookie("accessToken", accessToken, {
      ...COOKIE_OPTIONS,
      maxAge: 15 * 60 * 1000,
    }); // 15 min

    res.cookie("refreshToken", refreshToken, {
      ...COOKIE_OPTIONS,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    }); // 7 days

    user.password = undefined;
    user.refreshToken = undefined;
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
      const user = await User.findByIdAndUpdate(userId, {
        $pull: { refreshToken: incomingRefreshToken },
      });
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
    user.password = undefined;
    user.__v = undefined;
    user.refreshToken = undefined;
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }
    res.status(200).json({ user: user });
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

    const decoded = jwt.verify(incomingRefreshToken, process.env.JWT_SECRATE);

    const user = await User.findById(decoded._id);
    if (!user || !user.refreshToken.includes(incomingRefreshToken)) {
      return res
        .status(401)
        .json({ message: "Invalid refresh token, please login again" });
    }

    const newAccessToken = user.getAccessToken();
    const newRefreshToken = user.getRefreshToken();

    user.refreshToken = user.refreshToken.filter(
      (token) => token !== incomingRefreshToken,
    );
    user.refreshToken.push(newRefreshToken);
    await user.save();

    res.cookie("accessToken", newAccessToken, {
      ...COOKIE_OPTIONS,
      maxAge: 15 * 60 * 1000,
    }); // 15 min

    res.cookie("refreshToken", newRefreshToken, {
      ...COOKIE_OPTIONS,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    }); // 7 days

    return res.status(200).json({ message: "Access token refreshed" });
  } catch (err) {
    return res.status(401).json({
      message: "Invalid or expired refresh token, please login again",
    });
  }
};
