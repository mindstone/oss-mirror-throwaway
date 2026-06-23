/**
 * API Key Validation Service
 *
 * Extracted from settingsHandlers.ts to allow reuse by both IPC handlers
 * and the MCP bridge (bundledInboxBridge.ts). Pure validation logic — no
 * settings mutation, no IPC registration.
 *
 * Each validator makes HTTP calls to the respective provider API to verify
 * that a key is valid and (optionally) that a specific model is accessible.
 */

import axios from 'axios';
import { createScopedLogger } from '@core/logger';
import type { ApiKeyValidationResult } from '@shared/ipc/schemas/settings';

export type { ApiKeyValidationResult } from '@shared/ipc/schemas/settings';

const log = createScopedLogger({ service: 'apiKeyValidation' });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Network error codes that indicate the provider API is unreachable. */
export const NETWORK_ERROR_CODES = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
]);

/**
 * Timeout for validation HTTP requests.
 * Increased from 5 s to 15 s for Windows compatibility
 * (antivirus, DNS, firewall delays).
 */
export const VALIDATION_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type AxiosErrorLike = {
  code?: string;
  message?: string;
  response?: {
    status?: number;
    data?: unknown;
    headers?: Record<string, unknown>;
  };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Classify an HTTP error response into a structured reason code.
 */
export function classifyError(
  provider: 'openai' | 'anthropic' | 'elevenlabs',
  status?: number | null,
  payload?: Record<string, unknown>,
): { reason: ApiKeyValidationResult['reason']; code?: string | null } {
  if (!status) return { reason: 'unreachable' };

  // Narrow payload.error from unknown to Record so sub-properties are accessible
  const errorObj = payload?.error as Record<string, unknown> | undefined;

  if (status === 401) {
    const code =
      provider === 'openai'
        ? errorObj?.code ?? null
        : provider === 'anthropic'
          ? errorObj?.type ?? null
          : null;
    return { reason: 'invalid', code: typeof code === 'string' ? code : null };
  }

  if (status === 403) {
    const code =
      provider === 'openai'
        ? errorObj?.code ?? null
        : provider === 'anthropic'
          ? errorObj?.type ?? null
          : null;
    return { reason: 'forbidden', code: typeof code === 'string' ? code : null };
  }

  if (status === 429) {
    const code =
      provider === 'openai'
        ? errorObj?.code ?? null
        : provider === 'anthropic'
          ? errorObj?.type ?? null
          : null;
    if (code === 'insufficient_quota') {
      return { reason: 'quota_exceeded', code };
    }
    return { reason: 'rate_limited', code: typeof code === 'string' ? code : null };
  }

  return { reason: 'unknown', code: undefined };
}

/**
 * Build a user-friendly error message that distinguishes network failures
 * from API-level errors.
 */
export function buildNetworkAwareMessage(
  operation: string,
  providerLabel: string,
  timeoutMs: number,
  error: AxiosErrorLike,
): string {
  const code = error.code;
  const status = error.response?.status;
  const data = error.response?.data as Record<string, unknown> | string | undefined;
  const isTimeout = code === 'ECONNABORTED';
  const isNetwork = !status && (isTimeout || (code && NETWORK_ERROR_CODES.has(code)));

  if (isNetwork) {
    const suffix = isTimeout ? ` [request timed out after ${timeoutMs}ms]` : code ? ` (${code})` : '';
    return `Unable to reach ${providerLabel} – check your internet connection${suffix}.`;
  }

  let detail: string | undefined;
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    if (typeof d.error === 'string') {
      detail = d.error;
    } else if (typeof d.message === 'string') {
      detail = d.message;
    } else if (typeof d.detail === 'string') {
      detail = d.detail;
    } else if (
      typeof d.error === 'object' &&
      d.error !== null &&
      typeof (d.error as Record<string, unknown>).message === 'string'
    ) {
      detail = (d.error as Record<string, unknown>).message as string;
    }
  } else if (typeof data === 'string') {
    detail = data;
  }
  if (!detail && error.message) {
    detail = error.message;
  }

  const base = `${providerLabel} ${operation} failed`;
  if (status) {
    return detail ? `${base} (HTTP ${status}): ${detail}` : `${base} (HTTP ${status})`;
  }
  return detail ? `${base}: ${detail}` : base;
}

/**
 * Create a success validation result.
 */
export function okResult(message: string, modelAccessible?: boolean | null): ApiKeyValidationResult {
  return {
    ok: true,
    status: 200,
    code: null,
    reason: 'ok',
    message,
    modelAccessible: typeof modelAccessible === 'boolean' ? modelAccessible : null,
  };
}

/**
 * Create a failure validation result.
 */
export function errorResult(
  reason: NonNullable<ApiKeyValidationResult['reason']>,
  message: string,
  status?: number | null,
  code?: string | null,
): ApiKeyValidationResult {
  return {
    ok: false,
    status: status ?? null,
    code: code ?? null,
    reason,
    message,
    modelAccessible: null,
  };
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

export interface ValidateOpenAiKeyOptions {
  organizationId?: string | null;
  modelId?: string | null;
  deepValidate?: boolean;
}

/**
 * Validate an OpenAI API key by listing models and (optionally) making a
 * minimal chat completion to verify credits.
 */
export async function validateOpenAiKey(
  apiKey: string,
  options?: ValidateOpenAiKeyOptions,
): Promise<ApiKeyValidationResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
  };
  if (options?.organizationId) {
    headers['OpenAI-Organization'] = options.organizationId;
  }

  try {
    const response = await axios.get('https://api.openai.com/v1/models', {
      headers,
      timeout: VALIDATION_TIMEOUT_MS,
    });
    const models: Record<string, unknown>[] = Array.isArray(response.data?.data) ? response.data.data : [];
    let modelAccessible: boolean | null = null;
    if (options?.modelId) {
      modelAccessible = models.some((m) => m?.id === options.modelId);
    }

    // Deep validation: make a minimal API call to verify credits are available
    if (options?.deepValidate) {
      try {
        // CHAT_COMPLETIONS_CHOKEPOINT_ALLOWLIST: fixed OpenAI validation body has no provider-unsupported params.
        await axios.post(
          'https://api.openai.com/v1/chat/completions',
          {
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: 'hi' }],
            max_completion_tokens: 1,
          },
          { headers, timeout: VALIDATION_TIMEOUT_MS },
        );
        log.debug({ provider: 'openai' }, 'OpenAI deep validation succeeded - credits available');
      } catch (deepErr: unknown) {
        const deepAxios = deepErr as AxiosErrorLike;
        const deepStatus = deepAxios?.response?.status;
        const deepData = deepAxios?.response?.data as Record<string, unknown> | undefined;
        const deepCode = (deepData?.error as Record<string, unknown> | undefined)?.code;

        if (deepStatus === 429 && deepCode === 'insufficient_quota') {
          log.warn({ provider: 'openai', deepStatus, deepCode }, 'OpenAI key valid but no credits');
          // Key is valid (authentication succeeded) but has no credits.
          // Return ok:true so the user can save the key, but carry quota_exceeded
          // reason so the UI can show a warning.
          return {
            ok: true,
            status: 429,
            code: 'insufficient_quota',
            reason: 'quota_exceeded' as const,
            message:
              "Key is valid but has no credits. Voice won't work until you add billing at platform.openai.com",
            modelAccessible,
          };
        }
        // 404/403 = model access issue, not credit issue - key is still valid
        // Other errors = network issue during deep check - don't fail validation
        log.debug(
          { provider: 'openai', deepStatus, deepCode },
          'OpenAI deep validation inconclusive, proceeding with basic validation result',
        );
      }
    }

    const baseMsg = `OpenAI key is valid${typeof modelAccessible === 'boolean' ? (modelAccessible ? '' : ` (no access to model "${options?.modelId}")`) : ''}.`;
    log.debug({ provider: 'openai' }, 'OpenAI key validation succeeded');
    return okResult(baseMsg, modelAccessible);
  } catch (err: unknown) {
    const axiosErr = err as AxiosErrorLike;
    const status = axiosErr?.response?.status ?? null;
    const data = axiosErr?.response?.data as Record<string, unknown> | undefined;
    const { reason, code } = classifyError('openai', status, data);
    const message =
      status || axiosErr.code
        ? buildNetworkAwareMessage('validation', 'OpenAI', VALIDATION_TIMEOUT_MS, axiosErr)
        : 'OpenAI validation failed.';
    log.warn({ provider: 'openai', status, reason, code }, 'OpenAI key validation failed');
    return errorResult(reason ?? 'unknown', message, status, typeof code === 'string' ? code : null);
  }
}

export interface ValidateClaudeKeyOptions {
  modelId?: string | null;
}

/**
 * Validate a Claude (Anthropic) API key by listing models.
 */
export async function validateClaudeKey(
  apiKey: string,
  options?: ValidateClaudeKeyOptions,
): Promise<ApiKeyValidationResult> {
  const headers: Record<string, string> = {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };

  try {
    const response = await axios.get('https://api.anthropic.com/v1/models', {
      headers,
      timeout: VALIDATION_TIMEOUT_MS,
    });
    const models: Record<string, unknown>[] = Array.isArray(response.data?.data) ? response.data.data : [];
    let modelAccessible: boolean | null = null;
    if (options?.modelId) {
      modelAccessible = models.some((m) => m?.id === options.modelId);
    }
    const baseMsg = `Claude key is valid${typeof modelAccessible === 'boolean' ? (modelAccessible ? '' : ` (no access to model "${options?.modelId}")`) : ''}.`;
    log.debug({ provider: 'anthropic' }, 'Claude key validation succeeded');
    return okResult(baseMsg, modelAccessible);
  } catch (err: unknown) {
    const axiosErr = err as AxiosErrorLike;
    const status = axiosErr?.response?.status ?? null;
    const data = axiosErr?.response?.data as Record<string, unknown> | undefined;
    const { reason, code } = classifyError('anthropic', status, data);
    const message =
      status || axiosErr.code
        ? buildNetworkAwareMessage('validation', 'Anthropic (Claude)', VALIDATION_TIMEOUT_MS, axiosErr)
        : 'Anthropic validation failed.';
    log.warn({ provider: 'anthropic', status, reason, code }, 'Claude key validation failed');
    return errorResult(reason ?? 'unknown', message, status, typeof code === 'string' ? code : null);
  }
}

/**
 * Validate a Claude OAuth token (Claude Max, standard API keys, or bearer tokens).
 *
 * Routing logic:
 * - `sk-ant-oat*` → format-only (Claude Max tokens can't be validated via API)
 * - `sk-ant-*`    → API key validation via api.anthropic.com
 * - other         → OAuth bearer validation via platform.claude.com
 */
/**
 * Validate an ElevenLabs API key by listing voices.
 */
export async function validateElevenLabsKey(apiKey: string): Promise<ApiKeyValidationResult> {
  const headers: Record<string, string> = {
    'xi-api-key': apiKey,
  };

  try {
    // Use /v1/voices endpoint which is accessible to all API keys.
    // The /v1/user endpoint can return 401 for some key types.
    await axios.get('https://api.elevenlabs.io/v1/voices', {
      headers,
      timeout: VALIDATION_TIMEOUT_MS,
    });
    const baseMsg = 'ElevenLabs key is valid.';
    log.debug({ provider: 'elevenlabs' }, 'ElevenLabs key validation succeeded');
    return okResult(baseMsg, null);
  } catch (err: unknown) {
    const axiosErr = err as AxiosErrorLike;
    const status = axiosErr?.response?.status ?? null;
    const data = axiosErr?.response?.data as Record<string, unknown> | undefined;
    const { reason, code } = classifyError('elevenlabs', status, data);
    const message =
      status || axiosErr.code
        ? buildNetworkAwareMessage('validation', 'ElevenLabs', VALIDATION_TIMEOUT_MS, axiosErr)
        : 'ElevenLabs validation failed.';
    log.warn({ provider: 'elevenlabs', status, reason, code }, 'ElevenLabs key validation failed');
    return errorResult(reason ?? 'unknown', message, status, typeof code === 'string' ? code : null);
  }
}
