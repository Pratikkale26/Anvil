import { GeminiProvider } from "./providers/gemini.js";
import type { LLMProvider } from "./provider.js";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function getAIProvider(): { provider: LLMProvider; repairModel: string } {
  const apiKey = requiredEnv("GEMINI_API_KEY");
  const provider = new GeminiProvider(apiKey);
  return {
    provider,
    repairModel: process.env.AI_MODEL_REPAIR ?? "gemini-2.5-flash",
  };
}
