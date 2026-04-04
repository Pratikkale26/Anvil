export type StructuredGenerationParams = {
  schema: Record<string, unknown>;
  prompt: string;
  model: string;
  onProgress?: AIProgressReporter;
};

export type AIProgressReporter = (step: string, message: string) => void;

export interface LLMProvider {
  readonly name: "gemini";
  generateStructured<T>(params: StructuredGenerationParams): Promise<T>;
}
