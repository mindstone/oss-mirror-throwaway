/**
 * API Key Health Checks
 */

import type { AppSettings } from '@shared/types';
import { getActiveVoiceProfile, getWorkingModelProfile } from '@shared/types';
import type { CheckResult } from '../types';
import { hasValidAuth, getAuthMethodDescription, isUsingOpenRouter } from '../../../utils/authEnvUtils';
import { isCodexConnected } from '@core/services/codexAuthCore';
import { getProviderKey } from '@shared/utils/providerKeys';
import { isLocalProvider } from '@shared/utils/voiceProviderUtils';
import { getApiKey } from '@core/rebelCore/settingsAccessors';

export function checkClaudeApiKeyValid(settings: AppSettings): CheckResult {
  const id = 'claudeApiKeyValid';
  const name = 'Claude Authentication';

  // Skip check when the active provider is not Anthropic — the user explicitly
  // chose a different provider so Anthropic API key checks are irrelevant.
  // Uses activeProvider (the user's intent) rather than isUsingOpenRouter()
  // (which requires fully-valid credentials) to avoid false positives during
  // startup, token refresh, or partial config states.
  if (settings.activeProvider === 'openrouter' || settings.activeProvider === 'mindstone') {
    return {
      id,
      name,
      status: 'pass',
      message: settings.activeProvider === 'mindstone'
        ? 'Using Mindstone subscription — Claude auth not required'
        : 'Using OpenRouter — Claude auth not required',
      details: { method: settings.activeProvider },
    };
  }

  if (settings.activeProvider === 'codex') {
    return {
      id,
      name,
      status: 'pass',
      message: 'Using ChatGPT Pro — Claude auth not required',
      details: { method: 'codex' },
    };
  }

  // Skip check when actively using a non-Anthropic model profile
  const workingProfile = getWorkingModelProfile(settings);
  if (workingProfile && workingProfile.providerType) {
    return {
      id,
      name,
      status: 'pass',
      message: `Using ${workingProfile.name ?? workingProfile.providerType} model — Claude auth not required`,
    };
  }

  // OpenRouter users don't need Claude-specific credentials (legacy path —
  // activeProvider check above handles most cases, but this covers edge cases
  // where activeProvider is not set but OpenRouter credentials are present).
  // Must run before hasValidAuth() because validateProviderCredentials's
  // default branch only inspects Anthropic credentials and would otherwise
  // fail-close before this fallback fires.
  if (isUsingOpenRouter(settings)) {
    return {
      id,
      name,
      status: 'pass',
      message: `Using ${getAuthMethodDescription(settings)}`,
      details: { method: 'openrouter' },
    };
  }

  if (!hasValidAuth(settings)) {
    return {
      id,
      name,
      status: 'fail',
      message: 'No authentication configured',
      remediation: 'Add your Anthropic API key or Claude Max token in Settings.',
    };
  }

  // API key check
  const apiKey = getApiKey(settings);

  if (!apiKey || apiKey.trim().length === 0) {
    return {
      id,
      name,
      status: 'fail',
      message: 'API key not configured',
      remediation: 'Add your Anthropic API key in Settings. Get one at console.anthropic.com',
    };
  }

  const trimmedKey = apiKey.trim();
  const validPrefixes = ['sk-ant-api', 'sk-ant-'];
  const hasValidPrefix = validPrefixes.some(prefix => trimmedKey.startsWith(prefix));

  if (!hasValidPrefix) {
    return {
      id,
      name,
      status: 'warn',
      message: 'API key format looks unusual',
      details: { prefix: trimmedKey.substring(0, 10) + '...' },
      remediation: 'Verify your API key is correct. Anthropic keys start with sk-ant-',
    };
  }

  if (trimmedKey.length < 40) {
    return {
      id,
      name,
      status: 'warn',
      message: 'API key seems too short',
      remediation: 'Check that the full API key was copied',
    };
  }

  const placeholders = ['YOUR_API_KEY', 'xxx', 'PLACEHOLDER', 'INSERT'];
  if (placeholders.some(p => trimmedKey.toUpperCase().includes(p))) {
    return {
      id,
      name,
      status: 'fail',
      message: 'API key appears to be a placeholder',
      remediation: 'Replace with your actual Anthropic API key',
    };
  }

  return {
    id,
    name,
    status: 'pass',
    message: `Using ${getAuthMethodDescription(settings)}`,
    details: { prefix: trimmedKey.substring(0, 12) + '...' },
  };
}

const VOICE_KEY_VALIDATION_TIMEOUT_MS = 8000;

/**
 * Attempt a lightweight API call to verify the voice API key is actually accepted
 * by the provider. Returns null on success, or an error message on auth failure.
 * Network errors are treated as inconclusive (key format may still be fine).
 */
async function validateVoiceKeyLive(
  provider: string,
  apiKey: string,
  baseUrl?: string,
): Promise<{ valid: boolean; message?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VOICE_KEY_VALIDATION_TIMEOUT_MS);

  try {
    let url: string;
    const headers: Record<string, string> = {};

    if (provider === 'elevenlabs-scribe') {
      url = 'https://api.elevenlabs.io/v1/user';
      headers['xi-api-key'] = apiKey;
    } else {
      // OpenAI-compatible (openai-whisper, custom-openai)
      const base = (baseUrl ?? 'https://api.openai.com').replace(/\/+$/, '');
      url = `${base}/v1/models`;
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });

    if (response.ok) {
      return { valid: true };
    }

    if (response.status === 401 || response.status === 403) {
      return { valid: false, message: `API key rejected by provider (HTTP ${response.status})` };
    }

    // Other HTTP errors (429, 500, etc.) are inconclusive — key might be fine
    return { valid: true, message: `Provider returned HTTP ${response.status} (key format OK)` };
  } catch {
    // Network error or timeout — inconclusive, don't fail the check
    return { valid: true, message: 'Could not verify online (key format OK)' };
  } finally {
    clearTimeout(timeout);
  }
}

export async function checkVoiceApiKeyValid(settings: AppSettings): Promise<CheckResult> {
  const id = 'voiceApiKeyValid';
  const name = 'Voice API Key';

  const provider = settings.voice?.provider;
  
  if (!provider) {
    return {
      id,
      name,
      status: 'skip',
      message: 'No voice provider configured',
    };
  }

  // Local providers don't need an API key
  if (isLocalProvider(provider)) {
    return {
      id,
      name,
      status: 'skip',
      message: 'Local provider — no API key needed',
    };
  }

  if (provider === 'openai-whisper') {
    const key = getProviderKey(settings, 'openai');
    if (!key) {
      if (isCodexConnected()) {
        return {
          id,
          name,
          status: 'pass',
          message: 'Using ChatGPT subscription for voice (no API key needed)',
        };
      }
      return {
        id,
        name,
        status: 'warn',
        message: 'OpenAI voice provider selected but no API key configured',
        remediation: 'Add your OpenAI API key in Settings → Agents → Provider API Keys, or connect your ChatGPT account.',
      };
    }
    if (!key.startsWith('sk-')) {
      return {
        id,
        name,
        status: 'warn',
        message: 'OpenAI API key format may be invalid',
        details: { prefix: key.substring(0, 3) },
        remediation: 'OpenAI keys typically start with "sk-"',
      };
    }
    const live = await validateVoiceKeyLive('openai-whisper', key);
    if (!live.valid) {
      return {
        id,
        name,
        status: 'fail',
        message: live.message ?? 'OpenAI API key is not accepted by the provider',
        remediation: 'Check that your OpenAI API key is valid and has not expired',
      };
    }
    return {
      id,
      name,
      status: 'pass',
      message: live.message ? `OpenAI — ${live.message}` : 'OpenAI API key verified',
    };
  }

  if (provider === 'custom-openai') {
    const activeProfile = getActiveVoiceProfile(settings.voice);
    if (!activeProfile) {
      return {
        id,
        name,
        status: 'warn',
        message: 'Custom voice provider selected but no active profile is configured',
        remediation: 'Select an active custom voice profile in Settings → Voice',
      };
    }

    const key = activeProfile.apiKey?.trim() || getProviderKey(settings, 'openai');
    if (!key) {
      return {
        id,
        name,
        status: 'warn',
        message: 'Custom voice profile selected but no API key is configured',
        remediation: 'Add an API key to the active custom voice profile or set a shared OpenAI key in Settings → Agents → Provider API Keys',
      };
    }

    const baseUrl = activeProfile.sttBaseUrl?.trim();
    const live = await validateVoiceKeyLive('custom-openai', key, baseUrl);
    if (!live.valid) {
      return {
        id,
        name,
        status: 'fail',
        message: live.message ?? 'API key is not accepted by the voice provider',
        remediation: 'Check that your API key is valid for the configured voice endpoint',
      };
    }
    return {
      id,
      name,
      status: 'pass',
      message: live.message
        ? `Custom profile "${activeProfile.name}" — ${live.message}`
        : `Custom voice profile "${activeProfile.name}" verified`,
    };
  }

  if (provider === 'elevenlabs-scribe') {
    const key = settings.voice.elevenlabsApiKey;
    if (!key || !key.trim()) {
      return {
        id,
        name,
        status: 'warn',
        message: 'ElevenLabs voice provider selected but no API key configured',
        remediation: 'Add your ElevenLabs API key in Settings → Voice',
      };
    }
    const live = await validateVoiceKeyLive('elevenlabs-scribe', key.trim());
    if (!live.valid) {
      return {
        id,
        name,
        status: 'fail',
        message: live.message ?? 'ElevenLabs API key is not accepted by the provider',
        remediation: 'Check that your ElevenLabs API key is valid and has not expired',
      };
    }
    return {
      id,
      name,
      status: 'pass',
      message: live.message ? `ElevenLabs — ${live.message}` : 'ElevenLabs API key verified',
    };
  }

  return {
    id,
    name,
    status: 'skip',
    message: `Unknown voice provider: ${provider}`,
  };
}
