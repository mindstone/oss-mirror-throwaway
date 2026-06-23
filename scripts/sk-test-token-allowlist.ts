/**
 * Allowlist for `scripts/check-sk-test-token-drift.ts` (260419 D1).
 *
 * **Purpose:** This is the source-of-truth list of test files / fixture
 * directories whose `sk-*` literal hits are legitimate (the `sk-` prefix
 * is the contract under test, or the fixture intentionally embeds
 * realistic-shape credentials for a safety/memory/route-plan judge).
 *
 * **Scope:** The drift-check scans **test surfaces only** — every file
 * under any `__tests__/` directory plus `evals/fixtures/`. Production
 * redaction code, UI placeholder text, and eval runners are NOT scanned;
 * they were dropped from the allowlist when the scope was narrowed (Stage 5
 * Phase-6 finding). If you need to allowlist a production file, the right
 * answer is almost always "use a neutral fake token" — the prefix is only
 * a contract in tests / fixtures.
 *
 * **Inclusion criterion:** A path belongs here iff:
 *   - It is a **prefix-shape test** where the `sk-` literal is the
 *     contract under test (redaction, secret-detection, masked-UI
 *     assertions, prefix-validation), OR
 *   - It is an **eval fixture directory** whose JSON files carry
 *     realistic provider-prefix credentials for routing / safety / memory
 *     judges to score against, OR
 *   - It is the **drift-check's own test fixture battery** (which embeds
 *     `sk-*` literals to exercise both ALLOWED and DRIFT code paths).
 *
 * **Be conservative — over-allowlist rather than under.** The goal of the
 * drift check is to catch sweep MISSES (real test files using `sk-test-*`
 * tokens that should have been replaced with neutral `fake-*` tokens), not
 * to litigate every legitimate prefix-shape use.
 *
 * **Path match semantics** (see `entryMatches` in the drift-check script):
 *   - `file` entries match by **exact equality** against the
 *     repo-relative POSIX path.
 *   - `directory` entries match by **prefix** (`relPath.startsWith(dir + '/')`).
 *   No `endsWith` / `.includes` fallback — preventing the directory-suffix
 *   bypass that the Phase-6 tester proof-fixture demonstrated.
 *
 * @see scripts/check-sk-test-token-drift.ts
 * @see docs/plans/260419_prepush_followups_roadmap.md (D1)
 * @see docs/project/TESTING_AUTOMATION_OVERVIEW.md (A6 sk-* test-token convention)
 */

export type AllowlistEntry =
  | { type: 'file'; path: string; rationale: string }
  | { type: 'directory'; path: string; rationale: string };

export const SK_TEST_TOKEN_ALLOWLIST: readonly AllowlistEntry[] = [
  // ---------------------------------------------------------------------
  // Eval fixture directories (realistic-shape credentials are the contract)
  // ---------------------------------------------------------------------
  {
    type: 'directory',
    path: 'src/core/rebelCore/__tests__/fixtures/providerRoutePlan',
    rationale:
      '52 JSON fixtures use realistic provider key prefixes (sk-ant-*, sk-or-*, ' +
      'sk-proj-*) for routing-logic realism — the prefix shape is what the route ' +
      'plan resolver discriminates on.',
  },
  {
    type: 'directory',
    path: 'evals/fixtures/safety-prompt',
    rationale:
      'Safety-prompt eval fixtures embed realistic-shape credentials so the ' +
      'safety judge correctly recognises them as exfiltration risks.',
  },
  {
    type: 'directory',
    path: 'evals/fixtures/memory-update-quality',
    rationale:
      'Memory-update-quality eval fixtures embed realistic-shape credentials so ' +
      'the memory-write quality judge can detect credential leakage in proposed ' +
      'memory writes.',
  },
  {
    type: 'directory',
    path: 'evals/fixtures/public-channel-safety',
    rationale:
      'Public-channel-safety eval fixtures include redacted/realistic credentials ' +
      'so the safety judge can score reply-channel exfiltration risk.',
  },
  {
    type: 'directory',
    path: 'evals/fixtures/approval-pipeline',
    rationale:
      'Approval-pipeline eval fixtures embed realistic credential strings so ' +
      'the approval judge can score consent-required cases.',
  },

  // ---------------------------------------------------------------------
  // Prefix-shape tests (sk-* is the contract under test)
  // ---------------------------------------------------------------------
  {
    type: 'file',
    path: 'src/core/utils/__tests__/redactRawError.test.ts',
    rationale: 'Prefix-shape redaction test — exercises the sk-… redactor against fake tokens.',
  },
  {
    type: 'file',
    path: 'src/core/utils/__tests__/secretDetection.test.ts',
    rationale: 'Prefix-shape secret-detection test — exercises sk-ant- detection regex.',
  },
  {
    type: 'file',
    path: 'src/core/rebelCore/__tests__/proxyAuthContract.test.ts',
    rationale:
      'Defensive test — asserts no sentinel collides with the sk-ant-* prefix shape.',
  },
  {
    type: 'file',
    path: 'src/main/services/__tests__/logExportService.test.ts',
    rationale:
      'Prefix-shape redaction test — asserts log-export masks sk-ant-/sk- prefixes.',
  },
  {
    type: 'file',
    path: 'src/main/services/__tests__/bundledInboxBridge.test.ts',
    rationale:
      'Bridge /settings/set-api-key tests must use an sk-* OpenAI token because ' +
      'the endpoint enforces the sk- prefix format gate before routing to ' +
      'settings:update lifecycle hooks.',
  },
  {
    type: 'directory',
    path: 'src/core/services/diagnostics/__tests__',
    rationale:
      'Diagnostic-bundle assembly tests (origin/dev 09b896f23 centralization). ' +
      'Fixtures embed realistic sk-ant-* shapes to verify the diagnostic-bundle ' +
      'redaction layer catches them — prefix shape IS the contract under test ' +
      'for redaction.test.ts, redactionParity.test.ts, logSummary.test.ts, ' +
      'sessionIndexTypes.test.ts, and diagnosticBundleService.test.ts.',
  },
  {
    type: 'file',
    path: 'src/main/services/__tests__/localModelProxyServer.anthropicPassthrough.test.ts',
    rationale: 'Test comment references sk-ant- prefix shape; no real key embedded.',
  },
  {
    type: 'file',
    path: 'src/main/services/health/checks/__tests__/apiKeys.test.ts',
    rationale:
      'Test fixtures use sk-or-* prefix to exercise the OpenRouter health check ' +
      'discriminator.',
  },
  {
    type: 'file',
    path: 'src/main/utils/__tests__/logRedaction.test.ts',
    rationale:
      'Prefix-shape redaction test — builds fake sk-* keys to exercise the ' +
      'redaction regexes; the prefix is the contract.',
  },
  {
    type: 'file',
    path: 'src/main/services/safety/__tests__/memoryWriteHook.test.ts',
    rationale:
      'Memory-write safety hook tests — fixture content embeds sk-ant- example ' +
      'tokens to exercise the credential-detection paths.',
  },
  {
    type: 'file',
    path: 'cloud-client/src/utils/__tests__/toolLabels.test.ts',
    rationale: 'Redaction-test fixtures — exercises sk-ant- masking of CLI/curl commands.',
  },
  {
    type: 'file',
    path: 'evals/__tests__/connector-build-loader.test.ts',
    rationale:
      'Forbidden-pattern array — uses sk-test-[A-Za-z0-9]+ to assert that ' +
      'generated connector code never embeds test-token strings.',
  },
  {
    type: 'file',
    path: 'src/core/rebelCore/__tests__/providerRouting.invariants.test.ts',
    rationale:
      'I5c invariant test — sk-ant-linger as apiKey to verify the route ' +
      'planner correctly routes stale Anthropic-prefixed keys via OpenRouter. ' +
      'Prefix shape is the routing discriminator.',
  },
  {
    type: 'file',
    path: 'src/core/rebelCore/clients/__tests__/openaiClient.test.ts',
    rationale:
      'OpenAIClient unit tests — sk-test placeholder apiKey for instantiating ' +
      'the client to exercise non-chat-model rejection and request shape. ' +
      'Realistic-shape token; not the contract under test, but legitimate ' +
      'placeholder until a coordinated fake-* migration lands.',
  },
  {
    type: 'file',
    path: 'src/core/rebelCore/__tests__/openaiClient.nonChatModels.test.ts',
    rationale:
      'OpenAIClient non-chat-model rejection tests — sk-test placeholder ' +
      'apiKey for client instantiation. Realistic-shape token; not the ' +
      'contract under test.',
  },
  {
    type: 'file',
    path: 'src/core/rebelCore/clients/__tests__/openaiClient.providerCapture.test.ts',
    rationale:
      'OpenAIClient provider-capture tests — sk-test placeholder apiKey for ' +
      'client instantiation while exercising fulfillmentProvider header/body ' +
      'capture across OpenAI-direct and Codex transports. Realistic-shape ' +
      'token; not the contract under test (matches sibling entries above).',
  },
  {
    type: 'file',
    path: 'src/renderer/features/settings/components/models/__tests__/useProfileWizard.test.ts',
    rationale:
      'Profile-wizard hook tests — sk-saved literal exercises edit-mode flow ' +
      'where the wizard preserves an existing saved provider key. Realistic-' +
      'shape token in providerKeys map; not the contract under test.',
  },

  // ---------------------------------------------------------------------
  // Mindstone managed OpenRouter key relay/route tests (Layer 3,
  // 260622 mobile-record-recreated-session). The `sk-or-managed-*` shape
  // is the contract under test: these fixtures verify the managed key
  // round-trips through the cloud route/relay and is never echoed in
  // responses or logs.
  // ---------------------------------------------------------------------
  {
    type: 'file',
    path: 'cloud-service/src/__tests__/managedKeyRouting.cloud.test.ts',
    rationale:
      'Managed-key cloud routing test — sk-or-managed-relayed / ' +
      'sk-or-managed-relay-body fixtures verify the saved managed OpenRouter ' +
      'key is relayed through the cloud surface. Realistic sk-or- shape IS the ' +
      'routing contract under test.',
  },
  {
    type: 'file',
    path: 'cloud-service/src/__tests__/openRouterManagedKeyRoute.test.ts',
    rationale:
      'Managed-key route handler test — sk-or-managed-abc123 / sk-or-managed-xyz ' +
      'fixtures verify save/load round-trip AND the no-leak assertion ' +
      '(response body must NOT contain the key). The sk-or- literal is the ' +
      'contract for the no-key-leak assertion.',
  },
  {
    type: 'file',
    path: 'cloud-service/src/__tests__/openRouterManagedKeyServerAuth.test.ts',
    rationale:
      'Managed-key server-auth test — sk-or-managed-server-auth-secret fixture ' +
      'verifies server-side auth gating of the managed-key route. Realistic ' +
      'sk-or- shape is the credential under test.',
  },
  {
    type: 'file',
    path: 'src/main/services/cloud/__tests__/cloudRouter.managedKeyRelay.test.ts',
    rationale:
      'Desktop cloud-router managed-key relay test — sk-or-managed-secret-do-not-log ' +
      'fixture proves the relayed managed key is never emitted to logs. The ' +
      'sk-or- literal IS the no-leak contract under test.',
  },

  // ---------------------------------------------------------------------
  // The drift-check's own test fixture battery
  // ---------------------------------------------------------------------
  {
    type: 'file',
    path: 'scripts/__tests__/check-sk-test-token-drift.test.ts',
    rationale:
      'Unit tests for the drift-check itself — fixtures intentionally embed ' +
      'sk-* literals (allowed and DRIFT) to exercise both code paths. The ' +
      'test file is the contract under test; sk-* literals are a feature.',
  },
];
