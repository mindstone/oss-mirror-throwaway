import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  SUPER_MCP_APP_EXPECTATION_MANIFEST,
  SUPER_MCP_DIAGNOSTIC_TRANSITION_REASONS,
  SUPER_MCP_META_TOOLS,
  SUPER_MCP_OUTER_META_ALLOWED_NAMESPACES,
  SUPER_MCP_READ_ONLY_META_TOOLS,
  SUPER_MCP_RESTART_REASONS,
  SUPER_MCP_REST_ENDPOINTS,
  SuperMcpHttpManagerConfigureSchema,
  SuperMcpInternalConfigureShapeSchema,
  SuperMcpOuterMetaProducerSchema,
  SuperMcpRuntimeHttpConfigSchema,
  SuperMcpSkippedServersResponseProducerSchema,
  SuperMcpToolCatalogResponseProducerSchema,
  SuperMcpToolConfigHashResponseSchema,
  SuperMcpToolManifestResponseSchema,
  UseToolJsonTextContinuationEnvelopeSchema,
  UseToolJsonTextDryRunEnvelopeSchema,
  UseToolJsonTextParserObjectSchema,
  UseToolJsonTextStandardEnvelopeSchema,
  UseToolOuterBlockBuildOuterSchema,
  UseToolOuterBlockProducerSchema,
  UseToolOuterBlockSchema,
  UseToolStagedBypassInputSchema,
} from '../superMcpContract';
import { parseUseToolEnvelopeJson } from '../superMcpEnvelope';

const managerSource = readFileSync('src/core/services/superMcpHttpManager.ts', 'utf8');
const diagnosticsManifestSource = readFileSync('src/core/services/diagnostics/manifest.ts', 'utf8');
const mcpServiceSource = readFileSync('src/main/services/mcpService.ts', 'utf8');

function telemetry(overrides: Record<string, unknown> = {}) {
  return {
    packageId: 'google-workspace',
    toolId: 'compose_workspace_email',
    durationMs: 42,
    outputChars: 120,
    ...overrides,
  };
}

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

describe('Super-MCP use_tool producer contract', () => {
  it('accepts current buildOuter fixtures for success, error, staged, materialized, ui, and structuredContent results', () => {
    const success = {
      content: [{ type: 'text', text: prettyJson({ ok: true }) }],
      isError: false,
      _meta: { superMcp: telemetry() },
    };

    const downstreamError = {
      content: [{ type: 'text', text: prettyJson({ error: 'downstream failed' }) }],
      isError: true,
      _meta: { superMcp: telemetry({ outputChars: 36 }) },
    };

    const staged = {
      content: [{ type: 'text', text: 'Tool call staged for approval.' }],
      isError: false,
      _meta: { superMcp: telemetry({ durationMs: 0, staged: true }) },
    };

    const materialized = {
      content: [{ type: 'text', text: prettyJson({ result: { status: 'materialized' } }) }],
      isError: false,
      _meta: {
        superMcp: telemetry(),
        materialization: {
          status: 'materialized',
          originalChars: 25000,
          filePath: '/tmp/.rebel/tool-outputs/result.json',
          imageFiles: ['/tmp/.rebel/tool-outputs/image.png'],
        },
      },
    };

    const oversized = {
      content: [{ type: 'text', text: prettyJson({ result: { status: 'oversized_output' } }) }],
      isError: false,
      _meta: {
        superMcp: telemetry({ truncated: true }),
        materialization: {
          status: 'oversized_output',
          originalChars: 1500000,
        },
      },
    };

    const uiAndStructuredContent = {
      content: [{ type: 'text', text: 'Draft ready' }],
      isError: false,
      structuredContent: { draftId: 'draft-1' },
      _meta: {
        superMcp: telemetry(),
        ui: {
          resourceUri: 'ui://google-workspace/compose-email',
          protocolUrl: 'mcp://google-workspace/resources/compose-email',
        },
      },
    };

    for (const block of [success, downstreamError, staged, materialized, oversized, uiAndStructuredContent]) {
      expect(UseToolOuterBlockBuildOuterSchema.safeParse(block).success).toBe(true);
      expect(UseToolOuterBlockProducerSchema.safeParse(block).success).toBe(true);
    }
  });

  it('accepts the early-error outer block (no _meta) and rejects a leaked top-level resultId', () => {
    // The ONLY non-buildOuter outer block: result_id given without output_offset
    // (super-mcp/src/handlers/useTool.ts:790) -> { content, isError }, no _meta,
    // no top-level resultId.
    const earlyError = {
      content: [{ type: 'text', text: 'Error: output_offset is required when using result_id.' }],
      isError: true,
    };
    expect(UseToolOuterBlockProducerSchema.safeParse(earlyError).success).toBe(true);
    expect(UseToolOuterBlockBuildOuterSchema.safeParse(earlyError).success).toBe(false);

    // A top-level `resultId` never appears on the real outer block (continuation
    // resultId lives in _meta.superMcp.resultId). A leak must FAIL conformance.
    expect(
      UseToolOuterBlockProducerSchema.safeParse({ ...earlyError, resultId: 'result-123' }).success,
    ).toBe(false);

    // The real continuation outer block goes through buildOuter: resultId is
    // inside _meta.superMcp, with continuation: true.
    const continuationOuter = {
      content: [{ type: 'text', text: prettyJson({ continuation: true, content: 'chunk' }) }],
      isError: false,
      _meta: { superMcp: telemetry({ durationMs: 0, resultId: 'result-123', continuation: true }) },
    };
    expect(UseToolOuterBlockBuildOuterSchema.safeParse(continuationOuter).success).toBe(true);
  });

  it('rejects missing isError and unknown _meta namespaces in producer output', () => {
    const missingIsError = {
      content: [{ type: 'text', text: 'ok' }],
      _meta: { superMcp: telemetry() },
    };
    const leakedMetaNamespace = {
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
      _meta: {
        superMcp: telemetry(),
        foo: { leaked: true },
      },
    };

    expect(UseToolOuterBlockProducerSchema.safeParse(missingIsError).success).toBe(false);
    expect(SuperMcpOuterMetaProducerSchema.safeParse(leakedMetaNamespace._meta).success).toBe(false);
    expect(UseToolOuterBlockProducerSchema.safeParse(leakedMetaNamespace).success).toBe(false);
  });

  it('keeps the consumer-tolerant schema loose for replay and older-version shapes', () => {
    const olderShape = {
      content: [{ type: 'text', text: 'ok' }],
      _meta: {
        foo: { olderProducerNamespace: true },
      },
      extraTopLevel: true,
    };

    expect(UseToolOuterBlockSchema.safeParse(olderShape).success).toBe(true);
  });
});

describe('Super-MCP JSON-in-text envelope contract', () => {
  it('parses standard, suffixed, dry-run, and continuation variants into known schemas', () => {
    const standard = {
      package_id: 'filesystem',
      tool_id: 'read_file',
      args_used: { path: '/tmp/a.txt' },
      result: { content: [{ type: 'text', text: 'hello' }] },
      telemetry: { duration_ms: 12, status: 'ok', output_chars: 200 },
      annotations: { readOnlyHint: true },
    };
    const suffixed = `${prettyJson(standard)}\n\n[To retrieve the full untruncated result: use_tool({ result_id: "abc" })]`;
    const dryRun = {
      ...standard,
      result: { dry_run: true },
      telemetry: { duration_ms: 0, status: 'ok' },
    };
    const continuation = {
      continuation: true,
      result_id: 'result-123',
      offset: 0,
      length: 5,
      total_chars: 10,
      has_more: true,
      content: 'hello',
    };

    expect(UseToolJsonTextStandardEnvelopeSchema.safeParse(parseUseToolEnvelopeJson(prettyJson(standard))).success).toBe(true);
    expect(UseToolJsonTextStandardEnvelopeSchema.safeParse(parseUseToolEnvelopeJson(suffixed)).success).toBe(true);
    expect(UseToolJsonTextDryRunEnvelopeSchema.safeParse(parseUseToolEnvelopeJson(prettyJson(dryRun))).success).toBe(true);
    expect(UseToolJsonTextContinuationEnvelopeSchema.safeParse(parseUseToolEnvelopeJson(prettyJson(continuation))).success).toBe(true);
    expect(UseToolJsonTextParserObjectSchema.safeParse(parseUseToolEnvelopeJson(suffixed)).success).toBe(true);
  });

  it('models staged calls as input flags and plain-text buildOuter output, not JSON-in-text output', () => {
    expect(UseToolStagedBypassInputSchema.safeParse({
      _rebel_staged: true,
      _rebel_staged_message: 'Waiting for approval.',
    }).success).toBe(true);

    expect(parseUseToolEnvelopeJson('Waiting for approval.')).toBeNull();
    expect(UseToolOuterBlockBuildOuterSchema.safeParse({
      content: [{ type: 'text', text: 'Waiting for approval.' }],
      isError: false,
      _meta: { superMcp: telemetry({ durationMs: 0, staged: true }) },
    }).success).toBe(true);
  });
});

describe('Super-MCP REST producer contract', () => {
  const catalogTool = {
    package_id: 'google-workspace',
    package_name: 'Google Workspace',
    tool_id: 'compose_workspace_email',
    name: 'compose_workspace_email',
    description: 'Compose an email draft',
    summary: 'Compose an email draft',
    input_schema: { type: 'object', properties: { to: { type: 'string' } } },
    annotations: { readOnlyHint: false },
  };

  it('accepts current /api/tools and /api/tools?packages= producer responses with hashes and counts', () => {
    const response = {
      tools: [catalogTool],
      etag: '"catalog-etag-uduser-adadmin"',
      tool_count: 1,
      package_count: 1,
      package_hashes: { 'google-workspace': 'hash-google' },
      user_disabled_count: 0,
      admin_disabled_count: 0,
      generated_at: '2026-05-31T00:00:00.000Z',
    };

    expect(SuperMcpToolCatalogResponseProducerSchema.safeParse(response).success).toBe(true);
    expect(SuperMcpToolCatalogResponseProducerSchema.safeParse({
      ...response,
      package_hashes: undefined,
    }).success).toBe(false);
  });

  it('accepts current config-hash, manifest, and skipped-server responses', () => {
    expect(SuperMcpToolConfigHashResponseSchema.safeParse({
      config_hash: 'config',
      security_hash: 'user-admin',
      package_ids: ['google-workspace'],
      package_count: 1,
    }).success).toBe(true);

    expect(SuperMcpToolManifestResponseSchema.safeParse({
      packages: [{
        package_id: 'google-workspace',
        package_name: 'Google Workspace',
        tool_count: 1,
        embedding_hash: 'hash-google',
        status: 'loaded',
      }],
      security_hash: 'user-admin',
      package_count: 1,
      generated_at: '2026-05-31T00:00:00.000Z',
    }).success).toBe(true);

    expect(SuperMcpSkippedServersResponseProducerSchema.safeParse({
      packages: [{ id: 'bad-package', reason: 'Invalid config' }],
    }).success).toBe(true);
    expect(SuperMcpSkippedServersResponseProducerSchema.safeParse({}).success).toBe(false);
  });
});

describe('Super-MCP contract manifest invariants', () => {
  it('keeps manifest endpoint and meta-tool subsets tied to the literal authorities', () => {
    const allEndpoints = new Set(SUPER_MCP_APP_EXPECTATION_MANIFEST.rest.endpoints);
    expect(SUPER_MCP_APP_EXPECTATION_MANIFEST.rest.toolIndexEndpoints.every((endpoint) => allEndpoints.has(endpoint))).toBe(true);
    expect(new Set(SUPER_MCP_APP_EXPECTATION_MANIFEST.rest.endpoints)).toEqual(new Set(Object.values(SUPER_MCP_REST_ENDPOINTS)));

    const allMetaTools = new Set(SUPER_MCP_APP_EXPECTATION_MANIFEST.metaTools.all);
    expect(SUPER_MCP_APP_EXPECTATION_MANIFEST.metaTools.readOnlyRetryable.every((tool) => allMetaTools.has(tool))).toBe(true);
    expect(new Set(SUPER_MCP_APP_EXPECTATION_MANIFEST.metaTools.all)).toEqual(new Set(Object.values(SUPER_MCP_META_TOOLS)));
    expect(SUPER_MCP_APP_EXPECTATION_MANIFEST.metaTools.readOnlyRetryable).toEqual(SUPER_MCP_READ_ONLY_META_TOOLS);

    expect(SUPER_MCP_APP_EXPECTATION_MANIFEST.useToolEnvelope.outerMetaAllowlist).toEqual(SUPER_MCP_OUTER_META_ALLOWED_NAMESPACES);
    expect(SUPER_MCP_APP_EXPECTATION_MANIFEST.runtime.restartReasons).toEqual(SUPER_MCP_RESTART_REASONS);
    expect(SUPER_MCP_APP_EXPECTATION_MANIFEST.runtime.diagnosticTransitionReasons).toEqual(SUPER_MCP_DIAGNOSTIC_TRANSITION_REASONS);
  });

  it('keeps restart and diagnostic reason literals sourced from the contract', () => {
    expect(managerSource).toContain("type SuperMcpRestartReason");
    expect(managerSource).toContain("from '@core/rebelCore/superMcpContract'");
    expect(managerSource).not.toMatch(/export type SuperMcpRestartReason\s*=\s*\|/);
    expect(diagnosticsManifestSource).toContain('SuperMcpDiagnosticTransitionReason');
    expect(diagnosticsManifestSource).toContain("from '@core/rebelCore/superMcpContract'");
    expect(diagnosticsManifestSource).not.toMatch(/export type McpTransitionReason\s*=\s*\|/);
    expect([...SUPER_MCP_RESTART_REASONS]).toEqual([
      'debounced-workspace-change',
      'idle-restart',
      'reconfigure',
      'post-resume',
      'circuit-breaker-reset',
    ]);
    expect([...SUPER_MCP_DIAGNOSTIC_TRANSITION_REASONS]).toEqual([
      ...SUPER_MCP_RESTART_REASONS,
      'spawn-error',
      'health-check-timeout',
      'process-exit',
      'circuit-breaker-active',
    ]);
  });

  it('keeps runtime config schemas aligned with public and internal manager shapes', () => {
    expect(SuperMcpRuntimeHttpConfigSchema.safeParse({
      type: 'http',
      url: 'http://127.0.0.1:3200/mcp',
    }).success).toBe(true);
    expect(SuperMcpRuntimeHttpConfigSchema.safeParse({
      type: 'http',
      url: 'http://127.0.0.1:3200/mcp',
      token: 'not-part-of-this-contract',
    }).success).toBe(true);

    expect(SuperMcpHttpManagerConfigureSchema.safeParse({
      enabled: true,
      port: 3200,
      configPath: '/tmp/mcp.json',
      startupTimeoutMs: 5000,
      healthCheckIntervalMs: 1000,
    }).success).toBe(true);
    expect(SuperMcpInternalConfigureShapeSchema.safeParse({
      port: 3200,
      configPath: '/tmp/mcp.json',
      startupTimeoutMs: 5000,
    }).success).toBe(true);
  });
});

describe('Super-MCP meta-tool source contract', () => {
  it('keeps direct mcpService meta-tool names and timeout options visible in source', () => {
    for (const constantName of [
      'LIST_TOOL_PACKAGES',
      'LIST_TOOLS',
      'AUTHENTICATE',
      'RESTART_PACKAGE',
      'USE_TOOL',
      'HEALTH_CHECK',
    ]) {
      expect(mcpServiceSource).toContain(`name: SUPER_MCP_META_TOOLS.${constantName}`);
    }

    expect(mcpServiceSource).toContain('timeout: 10000');
    expect(mcpServiceSource).toContain('timeout: 30000');
    expect(mcpServiceSource).toContain('timeout: 370000');
    expect(mcpServiceSource).toContain('resetTimeoutOnProgress: true');
    expect(mcpServiceSource).toContain('timeout: 300000');
  });
});

// Kill-by-construction guard against the bulk_export regression class
// (docs/plans/260602_agent-data-export). bulk_export was silently dropped when
// the super-mcp submodule pin rolled back to a commit that never had it. This
// guard asserts the PINNED super-mcp source still registers + dispatches every
// meta-tool the app contract claims, so any future pointer bump that drops one
// fails pre-push instead of regressing silently. Reads the submodule working
// tree, which validate:super-mcp-gitsha-parity guarantees matches the recorded
// pin in CI/pre-push (so this effectively reads the pinned source). A plain file
// read avoids any dependency on the submodule's transient git HEAD state during
// a sync — an earlier `git show HEAD:…` variant flaked when the pre-push hook ran
// mid-`git submodule update`.
describe('Super-MCP meta-tool presence guard (submodule)', () => {
  const superMcpServerSource = readFileSync('super-mcp/src/server.ts', 'utf8');

  it('registers + dispatches every SUPER_MCP_META_TOOLS entry in the pinned super-mcp server', () => {
    for (const toolName of Object.values(SUPER_MCP_META_TOOLS)) {
      // ListTools descriptor (model-visible registration)
      expect(
        superMcpServerSource.includes(`name: "${toolName}"`) ||
          superMcpServerSource.includes(`name: '${toolName}'`),
        `super-mcp/src/server.ts is missing a ListTools descriptor for meta-tool "${toolName}". ` +
          `If the super-mcp submodule pin changed, it may have dropped this tool (the bulk_export regression class).`,
      ).toBe(true);
      // CallTool dispatch case
      expect(
        superMcpServerSource.includes(`case "${toolName}"`) ||
          superMcpServerSource.includes(`case '${toolName}'`),
        `super-mcp/src/server.ts is missing a CallTool dispatch case for meta-tool "${toolName}".`,
      ).toBe(true);
    }
  });

  it('specifically guards bulk_export (the tool that previously regressed)', () => {
    expect(Object.values(SUPER_MCP_META_TOOLS)).toContain('bulk_export');
    expect(superMcpServerSource).toContain('name: "bulk_export"');
    expect(superMcpServerSource).toContain('case "bulk_export"');
  });
});
