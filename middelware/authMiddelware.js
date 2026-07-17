import jwt from "jsonwebtoken";
import User from "../models/user.js";

export const userAuth = async (req, res, next) => {
  try {
    const { token } = req.cookies;
    if (!token) {
      return res.status(401).json({ message: "Invalid token" });
    }
    const decoded = await jwt.verify(token, process.env.JWT_SECRATE);
    const user = await User.findById({ _id: decoded._id });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    req.user = user;
    next();
  } catch (err) {
    res.status(500).json({ message: "Something went wrong ", error: err });
  }
};
