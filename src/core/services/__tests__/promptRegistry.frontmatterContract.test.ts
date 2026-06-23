/**
 * Boundary contract test (Stage 2).
 *
 * Catches the submodule-boundary `documented_but_not_wired` / `cross_module_assumption`
 * class where `rebel-system/prompts/**` frontmatter (producer of truth) drifts from
 * the host `PROMPT_REGISTRY` consumer (e.g. the 260529_public_broadcast_prompt_contract_drift
 * bug: prompt renamed + new required variables added without updating the registry).
 *
 * Intent & design rationale (incl. why contract tests over branded types, and the
 * deliberately-bidirectional + scoped-consumer-substitution design):
 * see docs/plans/260530_boundary_contract_test_reliability.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetForTesting,
  configurePromptFileService,
  getRawPrompt,
  parsePromptFile,
  PROMPT_IDS,
  PROMPT_REGISTRY,
  type PromptFrontmatter,
} from '../promptFileService';

const REPO_ROOT = path.resolve(__dirname, '../../../../');
const PROMPTS_ROOT = path.join(REPO_ROOT, 'rebel-system', 'prompts');
const CANONICAL_PROMPTS_ROOT = 'rebel-system/prompts';
const PROMPT_DOC_ALLOWLIST = new Set(['README.md']);

interface OnDiskPromptEntry {
  id: string;
  absolutePath: string;
  canonicalPath: string;
  frontmatter: PromptFrontmatter;
  body: string;
}

interface PromptFixtureState {
  available: boolean;
  reason?: string;
  byId: Map<string, OnDiskPromptEntry>;
  onDiskIds: Set<string>;
  parsedPromptCount: number;
}

let fixtureState: PromptFixtureState;

function listMarkdownFilesRecursively(directory: string): string[] {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listMarkdownFilesRecursively(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

function toPosixRelativePath(absolutePath: string): string {
  return path.relative(PROMPTS_ROOT, absolutePath).split(path.sep).join('/');
}

function canonicalPathForPromptId(promptId: string): string {
  return `${CANONICAL_PROMPTS_ROOT}/${promptId}.md`;
}

function loadPromptFixtures(): PromptFixtureState {
  if (!fs.existsSync(PROMPTS_ROOT)) {
    return {
      available: false,
      reason: `missing prompts directory "${CANONICAL_PROMPTS_ROOT}"`,
      byId: new Map(),
      onDiskIds: new Set(),
      parsedPromptCount: 0,
    };
  }

  const markdownFiles = listMarkdownFilesRecursively(PROMPTS_ROOT);
  if (markdownFiles.length === 0) {
    return {
      available: false,
      reason: `no markdown files found under "${CANONICAL_PROMPTS_ROOT}"`,
      byId: new Map(),
      onDiskIds: new Set(),
      parsedPromptCount: 0,
    };
  }

  const byId = new Map<string, OnDiskPromptEntry>();
  const onDiskIds = new Set<string>();

  for (const absolutePath of markdownFiles) {
    const relativePath = toPosixRelativePath(absolutePath);
    // Match on basename so nested docs (e.g. `safety/README.md`) are also
    // excluded — otherwise a future non-prompt markdown file would be parsed
    // as a prompt and crash the suite in beforeAll for an unrelated reason.
    if (PROMPT_DOC_ALLOWLIST.has(path.basename(relativePath))) {
      continue;
    }

    const raw = fs.readFileSync(absolutePath, 'utf-8');
    const parsed = parsePromptFile(raw);
    const id = relativePath.slice(0, -'.md'.length);
    const canonicalPath = `${CANONICAL_PROMPTS_ROOT}/${relativePath}`;

    byId.set(id, {
      id,
      absolutePath,
      canonicalPath,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
    });
    onDiskIds.add(id);
  }

  if (byId.size === 0) {
    return {
      available: false,
      reason: `only allowlisted docs were found under "${CANONICAL_PROMPTS_ROOT}"`,
      byId,
      onDiskIds,
      parsedPromptCount: 0,
    };
  }

  return {
    available: true,
    byId,
    onDiskIds,
    parsedPromptCount: byId.size,
  };
}

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

beforeAll(() => {
  fixtureState = loadPromptFixtures();

  if (!fixtureState.available) {
    console.warn(
      `::warning::Skipping prompt registry/frontmatter contract tests: ${fixtureState.reason}. ` +
        `This usually means the rebel-system submodule is absent/uninitialized for this lane.`,
    );
  }
});

beforeEach(() => {
  _resetForTesting();
  if (fixtureState.available) {
    configurePromptFileService(PROMPTS_ROOT);
  }
});

afterAll(() => {
  // Hygiene: leave the global prompt-file service in a clean state so this
  // suite cannot leak its real-prompts configuration into other tests if the
  // Vitest isolation mode ever changes.
  _resetForTesting();
});

describe('prompt registry ↔ frontmatter contract (Stage 2)', () => {
  it('loads the real prompts directory in Vitest context (Spike A2)', () => {
    if (!fixtureState.available) {
      return;
    }

    expect(fixtureState.parsedPromptCount).toBeGreaterThan(0);
    expect(() => getRawPrompt(PROMPT_IDS.SAFETY_PUBLIC_BROADCAST)).not.toThrow();
  });

  it('ensures each PROMPT_REGISTRY id resolves to an on-disk prompt file (forward parity)', () => {
    if (!fixtureState.available) {
      return;
    }

    for (const [registryId] of PROMPT_REGISTRY) {
      const expectedPath = canonicalPathForPromptId(registryId);
      expect(
        fixtureState.byId.has(registryId),
        `Missing producer file "${expectedPath}" for registry id "${registryId}". ` +
          `Update "${expectedPath}" or PROMPT_REGISTRY in src/core/services/promptFileService.ts.`,
      ).toBe(true);
    }
  });

  it('enforces reverse parity from on-disk prompts back to PROMPT_REGISTRY (all entries + critical minimum)', () => {
    if (!fixtureState.available) {
      return;
    }

    const registryIds = new Set(PROMPT_REGISTRY.keys());
    const onDiskIds = Array.from(fixtureState.onDiskIds).sort();
    const unregisteredOnDisk = onDiskIds.filter((id) => !registryIds.has(id));
    const registryWithoutFile = Array.from(registryIds)
      .filter((id) => !fixtureState.onDiskIds.has(id))
      .sort();

    const missingCritical = unregisteredOnDisk.filter((id) => fixtureState.byId.get(id)?.frontmatter.critical);

    expect(
      missingCritical,
      `Critical on-disk prompts must always be registered. Missing critical ids: ` +
        `${missingCritical.map((id) => fixtureState.byId.get(id)?.canonicalPath ?? canonicalPathForPromptId(id)).join(', ')}`,
    ).toEqual([]);

    expect(
      unregisteredOnDisk,
      `Unregistered on-disk prompts detected under "${CANONICAL_PROMPTS_ROOT}":\n` +
        `${unregisteredOnDisk.map((id) => `- ${fixtureState.byId.get(id)?.canonicalPath ?? canonicalPathForPromptId(id)}`).join('\n')}\n` +
        `Add these ids to PROMPT_REGISTRY or explicitly allowlist them as docs.`,
    ).toEqual([]);

    expect(
      registryWithoutFile,
      `PROMPT_REGISTRY entries without producer files under "${CANONICAL_PROMPTS_ROOT}":\n` +
        `${registryWithoutFile.map((id) => `- ${canonicalPathForPromptId(id)}`).join('\n')}`,
    ).toEqual([]);
  });

  it('keeps registry metadata in parity with prompt frontmatter (variables/service/critical)', () => {
    if (!fixtureState.available) {
      return;
    }

    for (const [registryId, registryMeta] of PROMPT_REGISTRY) {
      const entry = fixtureState.byId.get(registryId);
      const canonicalPath = canonicalPathForPromptId(registryId);
      expect(
        entry,
        `No producer file "${canonicalPath}" for PROMPT_REGISTRY entry "${registryId}".`,
      ).toBeDefined();
      if (!entry) continue;

      expect(
        registryMeta.id,
        `PROMPT_REGISTRY metadata id mismatch for "${entry.canonicalPath}".`,
      ).toBe(registryId);

      const registryVariables = sortedUnique(registryMeta.variables);
      const frontmatterVariables = sortedUnique(entry.frontmatter.variables);
      expect(
        registryVariables,
        `Variable parity drift at "${entry.canonicalPath}" (id "${registryId}").`,
      ).toEqual(frontmatterVariables);

      expect(
        registryMeta.service,
        `Service parity drift at "${entry.canonicalPath}" (id "${registryId}").`,
      ).toBe(entry.frontmatter.service);

      expect(
        registryMeta.critical,
        `Criticality parity drift at "${entry.canonicalPath}" (id "${registryId}").`,
      ).toBe(entry.frontmatter.critical);
    }
  });

  it('ensures every critical on-disk prompt parses and has a non-empty body', () => {
    if (!fixtureState.available) {
      return;
    }

    const criticalEntries = Array.from(fixtureState.byId.values())
      .filter((entry) => entry.frontmatter.critical)
      .sort((a, b) => a.id.localeCompare(b.id));

    for (const entry of criticalEntries) {
      expect(
        entry.body.trim().length,
        `Critical prompt body must be non-empty: "${entry.canonicalPath}".`,
      ).toBeGreaterThan(0);
    }
  });

  // SCOPE / FIDELITY NOTE: this assertion HAND-MIRRORS the `.replace(...)` chain
  // in `src/main/services/inboundTriggers/publicBroadcastSafetyHook.ts` rather than
  // invoking the real hook (the hook is entangled with the model call). It therefore
  // verifies that every declared frontmatter variable has a matching `{VAR}`
  // placeholder in the prompt BODY (frontmatter↔body consistency) and that
  // substitution leaves no unresolved token — NOT that production's substitution
  // logic itself is correct. If the hook's replace chain drifts, this test will not
  // catch it; invoking the real consumer (via an extracted pure
  // `buildPublicBroadcastSafetyPrompt(...)` helper) is follow-up I7. Keep this chain
  // in lockstep with the hook when production changes.
  it('ensures SAFETY_PUBLIC_BROADCAST declared variables are substitutable (frontmatter↔body, hook-mirrored)', () => {
    if (!fixtureState.available) {
      return;
    }

    const promptId = PROMPT_IDS.SAFETY_PUBLIC_BROADCAST;
    const entry = fixtureState.byId.get(promptId);
    const canonicalPath = canonicalPathForPromptId(promptId);

    expect(entry, `Missing scoped contract producer file "${canonicalPath}".`).toBeDefined();
    if (!entry) return;

    const sentinels = Object.fromEntries(
      entry.frontmatter.variables.map((variable) => [variable, `__SENTINEL_${variable}__`]),
    ) as Record<string, string>;

    const rendered = getRawPrompt(promptId)
      .replace(/\{SURFACE_KIND\}/g, sentinels.SURFACE_KIND)
      .replace(/\{INBOUND_TRIGGER_DESCRIPTION\}/g, sentinels.INBOUND_TRIGGER_DESCRIPTION)
      .replace(/\{AUDIENCE_VISIBILITY_STATEMENT\}/g, sentinels.AUDIENCE_VISIBILITY_STATEMENT)
      .replace('{REPLY_CONTENT}', sentinels.REPLY_CONTENT);

    for (const variable of entry.frontmatter.variables) {
      const sentinel = sentinels[variable];
      expect(
        rendered.includes(sentinel),
        `Consumer substitution missing variable "${variable}" for "${entry.canonicalPath}".`,
      ).toBe(true);

      const unresolvedPattern = new RegExp(`\\{\\{?\\s*${escapeRegExp(variable)}\\s*\\}?\\}`, 'g');
      const unresolvedTokens = rendered.match(unresolvedPattern) ?? [];
      expect(
        unresolvedTokens.length,
        `Unresolved placeholder token(s) for "${variable}" remained in "${entry.canonicalPath}": ${unresolvedTokens.join(', ')}`,
      ).toBe(0);
    }
  });
});
