import { AnthropicProvider } from "./providers/anthropic.js";
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

export function getAIProvider(): { provider: LLMProvider; repairModel: string } {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new AIError(
      "AI refine is not configured. Set ANTHROPIC_API_KEY in the API environment.",
      "missing_key",
    );
  }
  const apiKey = requiredEnv("ANTHROPIC_API_KEY");
  return {
    provider: new AnthropicProvider(apiKey),
    repairModel: process.env.AI_REPAIR_MODEL ?? "claude-sonnet-4-6",
  };
}
