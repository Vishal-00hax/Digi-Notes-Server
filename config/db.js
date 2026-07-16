import mongoose from "mongoose";
import "dotenv/config";

const connectDB = async () => {
  try {
    const connect = await mongoose.connect(process.env.MONGODB_URI);
    console.log("MongoDB Connected Successfully");
  } catch (err) {
    console.error(`Database Connection Error: ${err.message}`);
  }
};

export default connectDB;
