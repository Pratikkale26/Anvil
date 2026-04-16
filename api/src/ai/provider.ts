export type StructuredGenerationParams = {
  schema: Record<string, unknown>;
  prompt: string;
  model: string;
  onProgress?: AIProgressReporter;
};

export type AIProgressReporter = (step: string, message: string) => void;

export interface LLMProvider {
  readonly name: "anthropic" | "gemini";
  generateStructured<T>(params: StructuredGenerationParams): Promise<T>;
}
