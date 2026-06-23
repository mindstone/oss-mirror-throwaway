/**
 * SafetyEvaluationService — platform-agnostic interface for LLM safety calls.
 *
 * Core logic constructs prompts and parses decisions. Main/cloud implementations
 * provide the actual LLM call wiring.
 */

export interface LlmEvalRequest {
  system: string;
  userMessage: string;
  maxTokens: number;
  /** Optional model override used for bounded fallback attempts. */
  modelOverride?: string;
  /** Optional transport hint for observability; routing still resolves from model + settings. */
  transportHint?: string;
  /**
   * Optional dispatch control for explicit fallback hops. When true, BTS must
   * execute only the resolved target (no configured operational reroute).
   */
  disableOperationalFallback?: boolean;
  /** JSON schema for structured output */
  outputSchema: Record<string, unknown>;
  /**
   * Sampling temperature. `0` for low-variance primary evals; higher values
   * for independent confirmation draws. Omit to use provider default.
   * Some reasoning models reject non-default temperature values; the BTS
   * adapter degrades gracefully for those models.
   */
  temperature?: number;
  /** Timeout in milliseconds */
  timeout: number;
  /**
   * Optional abort signal. When provided, the underlying LLM call is cancelled
   * if the signal aborts before the response arrives. Callers should NOT forward
   * this signal into shared promise factories (e.g. `pendingEvals`) because one
   * caller's abort must not cascade to another caller awaiting the same promise.
   */
  signal?: AbortSignal;
}

export interface LlmEvalResponse {
  /** Raw text response from the model */
  text: string;
}

export interface SafetyEvaluationService {
  callLlm(request: LlmEvalRequest): Promise<LlmEvalResponse>;
}

let _service: SafetyEvaluationService | undefined;

export function setSafetyEvaluationService(service: SafetyEvaluationService): void {
  _service = service;
}

export function getSafetyEvaluationService(): SafetyEvaluationService {
  if (!_service) {
    throw new Error(
      'SafetyEvaluationService not initialized. Call setSafetyEvaluationService() at bootstrap.',
    );
  }

  return _service;
}

/** Reset for test isolation — clears the service singleton */
export function resetSafetyEvaluationServiceForTesting(): void {
  _service = undefined;
}
