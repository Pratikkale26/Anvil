import { AnthropicProvider } from "./providers/anthropic.js";
import { GeminiProvider } from "./providers/gemini.js";
import type { LLMProvider } from "./provider.js";
import { AIError } from "./errors.js";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new AIError(
      `Missing required environment variable: ${name}`,
      "missing_key",
    );
  }
  return value;
}

function pickProviderName(): "anthropic" | "gemini" {
  const explicit = process.env.AI_PROVIDER?.trim().toLowerCase();
  if (explicit === "anthropic" || explicit === "gemini") {
    return explicit;
  }
  // Default to Anthropic; fall back to Gemini only when its key is present
  // and Anthropic's is not.
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.GEMINI_API_KEY) return "gemini";
  throw new AIError(
    "AI refine is not configured. Set ANTHROPIC_API_KEY (recommended) or GEMINI_API_KEY in the API environment.",
    "missing_key",
  );
}

export function getAIProvider(): { provider: LLMProvider; repairModel: string } {
  const providerName = pickProviderName();

  if (providerName === "anthropic") {
    const apiKey = requiredEnv("ANTHROPIC_API_KEY");
    return {
      provider: new AnthropicProvider(apiKey),
      repairModel: process.env.AI_REPAIR_MODEL ?? "claude-sonnet-4-6",
    };
  }

  const apiKey = requiredEnv("GEMINI_API_KEY");
  return {
    provider: new GeminiProvider(apiKey),
    repairModel: process.env.AI_REPAIR_MODEL ?? "gemini-2.5-flash",
  };
}
