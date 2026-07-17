import mongoose from "mongoose";
import { Schema } from "mongoose";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";

const UserSchema = mongoose.Schema({
  full_name: {
    type: String,
    default: "",
    required: true,
  },
  email: {
    type: String,
    default: "",
    required: true,
    vaildate: {
      vaildator: function (v) {
        return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(v);
      },
      message: (prop) => `${prop.value} is not a valid email`,
    },
    required: [true, "Email is required"],
    unique: true,
  },
  password: {
    type: String,
    required: true,
  },
});

UserSchema.methods.getJWT = async function () {
  return await jwt.sign(
    { _id: this._id, email: this.email },
    process.env.JWT_SECRATE,
    {
      expiresIn: "2d",
    },
  );
};

UserSchema.methods.verifyPassword = async function (inputPassword) {
  return await bcrypt.compare(inputPassword, this.password);
};

const User = mongoose.model("User", UserSchema);

export default User;
