import { ChatOpenAI } from "@langchain/openai";
import OpenAI from "openai";
// import { tool } from "@langchain/core/tools";
// import { string, z } from "zod";

export const llm = new ChatOpenAI({
  apiKey: process.env.GEMINI_API_KEY,
  configuration: {
    baseURL: process.env.GEMINI_BASE_URL,
  },
  // Start by testing with a highly-available smaller model
  model: process.env.GEMINI_AI_MODEL,
  temperature: 0,
});

// const testResponse = await llm.invoke("Say hello");
// console.log(testResponse.content); nvidia/nemotron-3-super-120b-a12b:free

// const dummyTool = tool(async () => "ok", {
//   name: "dummy",
//   description: "A test tool",
//   schema: z.object({}),
// });
// const testLLM = llm.bindTools([dummyTool]);
// const res = await testLLM.invoke("Use the dummy tool");
// console.log(res.tool_calls);

export const ai = new OpenAI({
  apiKey: process.env.GEMINI_API_KEY,
  baseURL: process.env.GEMINI_BASE_URL,
});
