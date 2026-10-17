import mongoose from "mongoose";
import "dotenv/config";

const connectDB = async () => {
  try {
    const connect = await mongoose.connect(process.env.MONGODB_URI, {
      // Fail a request instead of hanging forever if the cluster is unreachable.
      serverSelectionTimeoutMS: 10000,
      // Bounded pool: enough concurrency for the load test without exhausting
      // the Atlas connection limit on the free/shared tier.
      maxPoolSize: 10,
      minPoolSize: 1,
      socketTimeoutMS: 45000,
      heartbeatFrequencyMS: 10000,
    });
    console.log("MongoDB Connected Successfully");
    return connect;
  } catch (err) {
    console.error(`Database Connection Error: ${err.message}`);
    // Do not crash: /health/ready reports the state and the process stays up so
    // the platform can keep the instance alive while the driver retries.
  }
};

export default connectDB;
