import type { LLMProvider, StructuredGenerationParams } from "../provider.js";

const ANTHROPIC_API_BASE = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

function extractJsonPayload(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1]?.trim();
  if (fenced && fenced.startsWith("{") && fenced.endsWith("}")) return fenced;

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return trimmed;
}

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic" as const;

  constructor(
    private readonly apiKey: string,
  ) {}

  async generateStructured<T>({ schema, prompt, model, onProgress }: StructuredGenerationParams): Promise<T> {
    const timeoutMs = parseInt(process.env.AI_PROVIDER_TIMEOUT_MS ?? "180000", 10);
    const maxRetries = parseInt(process.env.AI_PROVIDER_RETRIES ?? "0", 10);
    const maxTokens = parseInt(process.env.AI_PROVIDER_MAX_TOKENS ?? "12000", 10);
    const promptSizeKB = (Buffer.byteLength(prompt, "utf-8") / 1024).toFixed(1);

    onProgress?.("provider_request", `Sending ${promptSizeKB}KB prompt to Anthropic '${model}'.`);

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const backoffMs = Math.min(2000 * Math.pow(2, attempt - 1), 10000);
        onProgress?.("provider_retry", `Retry ${attempt}/${maxRetries} after ${backoffMs}ms backoff.`);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort("anthropic-timeout"), timeoutMs);

      try {
        const response = await fetch(ANTHROPIC_API_BASE, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": this.apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
          },
          signal: controller.signal,
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            temperature: 0.1,
            system: [
              "You are repairing generated Solana Rust code.",
              "Return valid JSON only with no markdown fences or commentary.",
              `Required response schema: ${JSON.stringify(schema)}`,
            ].join("\n"),
            messages: [
              {
                role: "user",
                content: prompt,
              },
            ],
          }),
        });

        clearTimeout(timeout);

        if (!response.ok) {
          const text = await response.text().catch(() => "");
          lastError = new Error(`Anthropic request failed (${response.status}): ${text || response.statusText}`);
          if (response.status >= 500 || response.status === 429) {
            continue;
          }
          throw lastError;
        }

        onProgress?.("provider_response", "Anthropic returned a response. Parsing structured output.");
        const json = await response.json() as {
          content?: Array<{ type?: string; text?: string }>;
        };

        const text = json.content
          ?.filter((part) => part.type === "text")
          .map((part) => part.text ?? "")
          .join("")
          .trim();

        if (!text) {
          lastError = new Error("Anthropic returned an empty response");
          continue;
        }

        try {
          onProgress?.("provider_parse", "Decoded Anthropic JSON response.");
          return JSON.parse(extractJsonPayload(text)) as T;
        } catch (parseError) {
          lastError = new Error(`Anthropic returned invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
          continue;
        }
      } catch (error) {
        clearTimeout(timeout);
        if (error === "anthropic-timeout" || (error instanceof Error && error.name === "AbortError")) {
          lastError = new Error(`Anthropic request timed out after ${timeoutMs / 1000}s`);
          continue;
        }
        if (error instanceof Error && error.message.startsWith("Anthropic request failed")) {
          throw error;
        }
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    throw lastError ?? new Error("Anthropic request failed after retries");
  }
}
