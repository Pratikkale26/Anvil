/**
 * Categorized AI provider errors so the route layer can return a stable code
 * and the UI can show actionable messages instead of "something went wrong".
 *
 * Categories:
 *  - missing_key      → user has not configured the provider key
 *  - invalid_key      → key is wrong / revoked / out of credit at the auth layer
 *  - rate_limited     → 429 from provider
 *  - server           → 5xx from provider (upstream outage)
 *  - timeout          → exceeded AI_PROVIDER_TIMEOUT_MS
 *  - malformed_response → 200 with non-JSON / schema-invalid body
 *  - unknown          → everything else
 */
export type AIErrorCategory =
  | "missing_key"
  | "invalid_key"
  | "rate_limited"
  | "server"
  | "timeout"
  | "malformed_response"
  | "unknown";

export class AIError extends Error {
  constructor(
    message: string,
    readonly category: AIErrorCategory,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = "AIError";
  }
}

/** Map an AIError to a stable HTTP status for the API layer. */
export function aiErrorToHttpStatus(category: AIErrorCategory): number {
  switch (category) {
    case "missing_key":
    case "invalid_key":
      return 503; // Service not configured / not authorized
    case "rate_limited":
      return 429;
    case "server":
      return 502;
    case "timeout":
      return 504;
    case "malformed_response":
    case "unknown":
      return 502;
  }
}
