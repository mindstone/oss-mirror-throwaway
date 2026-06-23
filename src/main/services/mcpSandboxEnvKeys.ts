/**
 * Back-compat re-export shim. The local-file sandbox env-key SSOT moved to
 * `src/shared/mcpSandboxEnvKeys.ts` (260613) so non-Electron tooling under
 * `scripts/` can import the contract without pulling in Electron. Existing
 * main-process importers keep this import path unchanged.
 *
 * @see src/shared/mcpSandboxEnvKeys.ts — the canonical definitions.
 */
export {
  DEFAULT_ONLY_SANDBOX_ENV_PRIMARY_KEY,
  DEFAULT_ONLY_SANDBOX_ENV_PAIRED_KEYS,
  DEFAULT_ONLY_SANDBOX_ENV_KEYS,
  LOCAL_FILE_SANDBOX_ENV_PLACEHOLDERS,
} from '../../shared/mcpSandboxEnvKeys';
