import type { AIProviderName } from "./schemas.js";
import { GeminiProvider } from "./providers/gemini.js";
import type { LLMProvider } from "./provider.js";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function getAIProvider(): { provider: LLMProvider; reviewModel: string; repairModel: string } {
  const providerName = (process.env.AI_PROVIDER ?? "gemini") as AIProviderName;
  if (providerName !== "gemini") {
    throw new Error(`Unsupported AI provider: ${providerName}`);
  }

  const apiKey = requiredEnv("GEMINI_API_KEY");
  const provider = new GeminiProvider(apiKey);
  return {
    provider,
    reviewModel: process.env.AI_MODEL_REVIEW ?? "gemini-2.5-flash",
    repairModel: process.env.AI_MODEL_REPAIR ?? "gemini-2.5-pro",
  };
}

export function isFallbackRewriteEnabled(): boolean {
  return (process.env.AI_ENABLE_FALLBACK_REWRITE ?? "true").toLowerCase() === "true";
}

