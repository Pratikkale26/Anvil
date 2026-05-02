export type StructuredGenerationParams = {
  schema: Record<string, unknown>;
  prompt: string;
  model: string;
  onProgress?: AIProgressReporter;
};

export type AIProgressReporter = (step: string, message: string) => void;

/**
 * Per-call usage breakdown surfaced for cost transparency.
 * cacheRead/cacheCreation are populated when prompt caching is in play.
 */
export type ProviderUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
};

export type ProviderResult<T> = {
  value: T;
  usage: ProviderUsage;
};

export interface LLMProvider {
  readonly name: "anthropic";
  generateStructured<T>(params: StructuredGenerationParams): Promise<ProviderResult<T>>;
}
