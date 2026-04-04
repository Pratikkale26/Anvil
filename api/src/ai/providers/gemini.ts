import type { LLMProvider, StructuredGenerationParams } from "../provider.js";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export class GeminiProvider implements LLMProvider {
  readonly name = "gemini" as const;

  constructor(
    private readonly apiKey: string,
  ) {}

  async generateStructured<T>({ schema, prompt, model, onProgress }: StructuredGenerationParams): Promise<T> {
    const timeoutMs = parseInt(process.env.AI_PROVIDER_TIMEOUT_MS ?? "180000", 10);
    const maxRetries = parseInt(process.env.AI_PROVIDER_RETRIES ?? "1", 10);
    const promptSizeKB = (Buffer.byteLength(prompt, "utf-8") / 1024).toFixed(1);

    onProgress?.("provider_request", `Sending ${promptSizeKB}KB prompt to Gemini '${model}'.`);

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const backoffMs = Math.min(2000 * Math.pow(2, attempt - 1), 10000);
        onProgress?.("provider_retry", `Retry ${attempt}/${maxRetries} after ${backoffMs}ms backoff.`);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort("gemini-timeout"), timeoutMs);

      try {
        const response = await fetch(`${GEMINI_API_BASE}/${model}:generateContent?key=${this.apiKey}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          signal: controller.signal,
          body: JSON.stringify({
            contents: [
              {
                role: "user",
                parts: [{ text: prompt }],
              },
            ],
            generationConfig: {
              responseMimeType: "application/json",
              responseJsonSchema: schema,
              temperature: 0.15,
            },
          }),
        });

        clearTimeout(timeout);

        if (!response.ok) {
          const text = await response.text().catch(() => "");
          lastError = new Error(`Gemini request failed (${response.status}): ${text || response.statusText}`);
          // Retry on 5xx / 429 (rate limit)
          if (response.status >= 500 || response.status === 429) {
            continue;
          }
          throw lastError;
        }

        onProgress?.("provider_response", "Gemini returned a response. Parsing structured output.");
        const json = await response.json() as {
          candidates?: Array<{
            content?: { parts?: Array<{ text?: string }> };
          }>;
        };

        const text = json.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
        if (!text) {
          lastError = new Error("Gemini returned an empty response");
          continue;
        }

        try {
          onProgress?.("provider_parse", "Decoded Gemini JSON response.");
          return JSON.parse(text) as T;
        } catch (parseError) {
          lastError = new Error(`Gemini returned invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
          continue;
        }
      } catch (error) {
        clearTimeout(timeout);
        if (error === "gemini-timeout" || (error instanceof Error && error.name === "AbortError")) {
          lastError = new Error(`Gemini request timed out after ${timeoutMs / 1000}s`);
          continue;
        }
        if (error instanceof Error && error.message.startsWith("Gemini request failed")) {
          throw error;
        }
        lastError = error instanceof Error ? error : new Error(String(error));
        continue;
      }
    }

    throw lastError ?? new Error("Gemini request failed after retries");
  }
}
