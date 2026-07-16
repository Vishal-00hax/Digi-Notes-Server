import mongoose from "mongoose";
import { Schema } from "mongoose";
import jwt from "jsonwebtoken";

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
  },
  password: {
    type: String,
    required: true,
  },
});

UserSchema.methods.getJWT = async function () {
  const user = this;
  const token = await jwt.sign({ _id: user._id }, process.env.JWT_SECRATE, {
    expiresIn: "2d",
  });
};

const User = mongoose.model("User", UserSchema);

export default User;
