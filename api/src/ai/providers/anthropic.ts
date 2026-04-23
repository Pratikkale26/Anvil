import type { LLMProvider, StructuredGenerationParams, ProviderResult } from "../provider.js";
import { AIError } from "../errors.js";
import { REFINE_SYSTEM_RULES } from "../prompts/refine.js";

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

  constructor(private readonly apiKey: string) {}

  async generateStructured<T>({
    schema,
    prompt,
    model,
    onProgress,
  }: StructuredGenerationParams): Promise<ProviderResult<T>> {
    const timeoutMs = parseInt(process.env.AI_PROVIDER_TIMEOUT_MS ?? "180000", 10);
    // One JSON-repair retry maximum — anything more risks burning $$ on a flaky
    // key/network combo. Distinct from the 5xx/429 backoff retries.
    const maxJsonRepairs = 1;
    const maxTokens = parseInt(process.env.AI_PROVIDER_MAX_TOKENS ?? "12000", 10);
    const promptSizeKB = (Buffer.byteLength(prompt, "utf-8") / 1024).toFixed(1);

    onProgress?.("provider_request", `Sending ${promptSizeKB}KB prompt to Anthropic '${model}'.`);

    // The system block is identical across every refine call; mark it cacheable
    // so repeat calls within the 5-minute TTL only pay the 0.1× cache-read input
    // rate. We co-locate the static rules + schema here (above the 1024-token
    // minimum Anthropic enforces for prompt caching). The dynamic prompt body
    // stays in the user message.
    const systemPrompt =
      `${REFINE_SYSTEM_RULES}\n\nResponse schema (canonical): ${JSON.stringify(schema)}`;

    const baseBody = (userPrompt: string) => ({
      model,
      max_tokens: maxTokens,
      temperature: 0.1,
      system: [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: userPrompt }],
    });

    let lastError: AIError | null = null;
    let jsonRepairs = 0;
    let currentPrompt = prompt;

    while (true) {
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
          body: JSON.stringify(baseBody(currentPrompt)),
        });

        clearTimeout(timeout);

        if (!response.ok) {
          const text = await response.text().catch(() => "");
          const message = `Anthropic request failed (${response.status}): ${text || response.statusText}`;
          if (response.status === 401 || response.status === 403) {
            throw new AIError(message, "invalid_key", response.status);
          }
          if (response.status === 429) {
            throw new AIError(message, "rate_limited", response.status);
          }
          if (response.status >= 500) {
            throw new AIError(message, "server", response.status);
          }
          throw new AIError(message, "unknown", response.status);
        }

        onProgress?.("provider_response", "Anthropic returned a response. Parsing structured output.");
        const json = (await response.json()) as {
          content?: Array<{ type?: string; text?: string }>;
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_creation_input_tokens?: number;
            cache_read_input_tokens?: number;
          };
        };

        const text = json.content
          ?.filter((part) => part.type === "text")
          .map((part) => part.text ?? "")
          .join("")
          .trim();

        if (!text) {
          throw new AIError("Anthropic returned an empty response", "malformed_response");
        }

        try {
          onProgress?.("provider_parse", "Decoded Anthropic JSON response.");
          const parsed = JSON.parse(extractJsonPayload(text)) as T;
          return {
            value: parsed,
            usage: {
              inputTokens: json.usage?.input_tokens ?? 0,
              outputTokens: json.usage?.output_tokens ?? 0,
              cacheCreationTokens: json.usage?.cache_creation_input_tokens ?? 0,
              cacheReadTokens: json.usage?.cache_read_input_tokens ?? 0,
            },
          };
        } catch (parseError) {
          const message = `Anthropic returned invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`;
          if (jsonRepairs < maxJsonRepairs) {
            // One stricter retry only — append an explicit reminder. We never
            // loop on this past once: malformed output is usually a model
            // capability issue, not a transient one.
            jsonRepairs++;
            onProgress?.("provider_retry", `Retrying once with stricter JSON guidance (${jsonRepairs}/${maxJsonRepairs}).`);
            currentPrompt =
              prompt +
              "\n\nIMPORTANT: Your previous response was not valid JSON. Return ONLY a JSON object matching the schema. No prose, no markdown, no commentary.";
            continue;
          }
          throw new AIError(message, "malformed_response");
        }
      } catch (error) {
        clearTimeout(timeout);
        if (error instanceof AIError) {
          // Do NOT loop on auth/key errors — those will fail identically next time.
          if (error.category === "invalid_key" || error.category === "missing_key") {
            throw error;
          }
          lastError = error;
          throw lastError;
        }
        if (error === "anthropic-timeout" || (error instanceof Error && error.name === "AbortError")) {
          throw new AIError(`Anthropic request timed out after ${timeoutMs / 1000}s`, "timeout");
        }
        throw new AIError(error instanceof Error ? error.message : String(error), "unknown");
      }
    }
  }
}
