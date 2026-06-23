/**
 * Local Inference Types & Constants
 *
 * Shared types and constants for the bundled Ollama local inference feature.
 * Pure TypeScript — no Electron dependencies.
 */

/** Non-default port to avoid conflicts with user-installed Ollama (11434). */
export const OLLAMA_PORT = 11435;
export const OLLAMA_BASE_URL = `http://127.0.0.1:${OLLAMA_PORT}`;
export const OLLAMA_API_URL = `${OLLAMA_BASE_URL}/api`;
export const OLLAMA_OPENAI_URL = `${OLLAMA_BASE_URL}/v1`;

export type OllamaRuntimeStatus = 'not_installed' | 'downloading' | 'installed' | 'running' | 'error';

export interface InferenceStrategy {
  id: string;
  label: string;
  kvCacheType: string;
  contextMultiplier: number;
  minOllamaVersion?: string;
  ollamaEnv: Record<string, string>;
}

export interface LocalModelCatalogEntry {
  id: string;
  ollamaTag: string;
  displayName: string;
  description: string;
  downloadSizeGB: number;
  minRAMGB: number;
  recommendedRAMGB: number;
  toolCallingScore?: number;
  contextWindowDefault: number;
  contextWindowMax: number;
  badge?: 'recommended' | 'lightweight' | 'reasoning';
}

export interface OllamaCapabilities {
  version: string;
  turboQuantSupported: boolean;
  kvCacheTypes: string[];
}

export interface LocalInferenceStatus {
  runtimeStatus: OllamaRuntimeStatus;
  runtimeVersion?: string;
  capabilities?: OllamaCapabilities;
  installedModels: Array<{ name: string; sizeBytes: number; modifiedAt: string }>;
  systemRAMGB: number;
  arch: string;
  error?: string;
}
