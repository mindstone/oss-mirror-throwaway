/**
 * Codex voice config — injected by desktop bootstrap when Codex OAuth is
 * available for voice transcription. Routes STT requests through the ChatGPT
 * backend using the user's ChatGPT subscription instead of a dedicated API key.
 *
 * Mirrors the CodexModeConfig pattern from src/core/rebelCore/codexModeTypes.ts
 * so src/core/ can depend on callback injection rather than Electron-bound auth
 * services from src/main/.
 */
export interface CodexVoiceConfig {
  /** ChatGPT transcription endpoint URL */
  transcribeEndpointUrl: string;
  /** Check if Codex OAuth is currently connected (has tokens) */
  isConnected: () => boolean;
  /** Get a valid access token (auto-refreshes if expiring) */
  getAccessToken: () => Promise<string | null>;
  /** Get the ChatGPT account ID for the account header */
  getAccountId: () => string | null;
  /** Force-refresh the access token (e.g., after a 401) */
  forceRefreshToken: () => Promise<string | null>;
}
