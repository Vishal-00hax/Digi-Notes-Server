import { ChatOpenAI } from "@langchain/openai";
import OpenAI from "openai";

export const llm = new ChatOpenAI({
  apiKey: process.env.GEMINI_API_KEY,
  configuration: {
    baseURL: process.env.GEMINI_BASE_URL,
  },
  modelName: process.env.GEMINI_AI_MODEL,
  temperature: 0,
});

export const ai = new OpenAI({
  apiKey: process.env.GEMINI_API_KEY,
  baseURL: process.env.GEMINI_BASE_URL,
});
