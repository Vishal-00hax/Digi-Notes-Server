// middleware/userAuth.js
import jwt from "jsonwebtoken";
import User from "../models/user.js";

export const userAuth = async (req, res, next) => {
  try {
    const accessToken = req.cookies?.accessToken;

    if (!accessToken) {
      return res.status(401).json({ message: "Access token missing" });
    }

    const decoded = jwt.verify(accessToken, process.env.JWT_SECRET);

    const user = await User.findById(decoded._id);
    if (!user) {
      return res.status(401).json({ message: "User not found" });
    }

    if (user.tokenValidAfter) {
      // Convert DB date to seconds to match JWT iat format
      const validAfterSeconds = Math.floor(
        user.tokenValidAfter.getTime() / 1000,
      );

      if (decoded.iat < validAfterSeconds) {
        return res
          .status(401)
          .json({ message: "Session invalidated. Please log in again." });
      }
    }

    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ message: "Access token expired" });
  }
};
