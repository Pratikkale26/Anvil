/**
 * Categorized AI provider errors so the route layer can return a stable code
 * and the UI can show actionable messages instead of "something went wrong".
 *
 * Categories:
 *  - missing_key        → user has not configured the provider key
 *  - invalid_key        → key is wrong / revoked / out of credit at the auth layer
 *  - rate_limited       → 429 from provider
 *  - server             → 5xx from provider (upstream outage)
 *  - timeout            → exceeded AI_PROVIDER_TIMEOUT_MS
 *  - malformed_response → 200 with non-JSON / completely broken body
 *  - zod_parse_failed   → 200 with JSON that doesn't match our RefineModelResponseSchema
 *                         (usually: missing required fields, wrong types). Distinct from
 *                         malformed_response because it's retryable without config changes.
 *  - unknown            → everything else
 */
export type AIErrorCategory =
  | "missing_key"
  | "invalid_key"
  | "rate_limited"
  | "server"
  | "timeout"
  | "malformed_response"
  | "zod_parse_failed"
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
    case "zod_parse_failed":
    case "unknown":
      return 502;
  }
}
