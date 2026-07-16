import User from "../models/user.js";
import bcrypt from "bcrypt";

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
    const newUser = await user.save();
    const token = user.getJWT();
    res.cookie("token", token, {
      expires: new Date(Date.now() + 48 * 3600000),
      httpOnly: true,
      secure: true,
      sameSite: "none",
    });
    res.status(201).json(newUser);
  } catch (err) {
    res.status(400).json({ message: "User Creating failed " + err.message });
  }
};
