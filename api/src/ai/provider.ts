export type StructuredGenerationParams = {
  schema: Record<string, unknown>;
  prompt: string;
  model: string;
};

export interface LLMProvider {
  readonly name: "gemini";
  generateStructured<T>(params: StructuredGenerationParams): Promise<T>;
}

