import type { LLMProvider, StructuredGenerationParams } from "../provider.js";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export class GeminiProvider implements LLMProvider {
  readonly name = "gemini" as const;

  constructor(
    private readonly apiKey: string,
  ) {}

  async generateStructured<T>({ schema, prompt, model }: StructuredGenerationParams): Promise<T> {
    const response = await fetch(`${GEMINI_API_BASE}/${model}:generateContent?key=${this.apiKey}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
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
          temperature: 0.2,
        },
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Gemini request failed (${response.status}): ${text || response.statusText}`);
    }

    const json = await response.json() as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
    };

    const text = json.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
    if (!text) {
      throw new Error("Gemini returned an empty response");
    }

    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new Error(`Gemini returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

