/**
 * Construction guard for the deterministic-trust allowlist (FOX-3476).
 *
 * `SYSTEM_TRUSTABLE_TOOL_IDS` (src/core/services/safety/toolVerbs.ts) grants
 * deterministic read-only trust to tools whose names contain side-effect verbs
 * (e.g. "create_draft"). Matching is GLOBAL by bare tool id — it is NOT scoped
 * to a package/connector. So if a FUTURE connector ships a tool with the same
 * bare name (say another connector adds its own `create_draft` that actually
 * sends), it would silently inherit "Always allow" deterministic trust.
 *
 * This test pins ownership: every bare id in the allowlist must be defined in
 * the connector catalog by EXACTLY the expected connector(s) and no other. If a
 * new connector adds a same-named tool, or someone adds an allowlist entry
 * without recording its expected owner here, this test fails loudly.
 *
 * Robust to catalog growth: it only inspects the specific allowlisted ids; it
 * never asserts total tool/connector counts.
 */
import { describe, expect, it } from 'vitest';

import { SYSTEM_TRUSTABLE_TOOL_IDS } from '@core/services/safety/toolVerbs';
import catalog from '../../../../../resources/connector-catalog.json';
import type { ConnectorCatalog } from '@shared/types/mcp';

const typedCatalog = catalog as ConnectorCatalog;

/**
 * For each allowlisted bare id, the set of connector catalog ids that are
 * ALLOWED to define a tool with that name. Every entry in
 * SYSTEM_TRUSTABLE_TOOL_IDS must have an entry here (enforced below).
 */
const EXPECTED_OWNERS: Record<string, string[]> = {
  // Gmail / Google Workspace local-draft tools.
  create_workspace_draft: ['bundled-google'],
  update_workspace_draft: ['bundled-google'],
  // Microsoft 365 (Outlook) local-draft tools.
  create_draft: ['bundled-microsoft-mail'],
  create_reply_draft: ['bundled-microsoft-mail'],
};

/** connector id -> set of bare tool names it defines. */
function connectorsDefiningTool(toolName: string): string[] {
  const owners: string[] = [];
  for (const connector of typedCatalog.connectors) {
    const tools = connector.tools ?? [];
    if (tools.some((t) => t.name === toolName)) {
      owners.push(connector.id);
    }
  }
  return owners;
}

describe('SYSTEM_TRUSTABLE_TOOL_IDS connector ownership (FOX-3476 trust-drift guard)', () => {
  it('declares an expected owner for every allowlisted id', () => {
    // If a new id is added to the allowlist without recording its expected
    // owner here, fail loudly so the ownership guard cannot silently rot.
    const allowlist = [...SYSTEM_TRUSTABLE_TOOL_IDS];
    const undeclared = allowlist.filter((id) => !(id in EXPECTED_OWNERS));
    expect(undeclared).toEqual([]);
  });

  it('does not declare expected owners for ids that left the allowlist', () => {
    const stale = Object.keys(EXPECTED_OWNERS).filter(
      (id) => !SYSTEM_TRUSTABLE_TOOL_IDS.has(id),
    );
    expect(stale).toEqual([]);
  });

  for (const id of Object.keys(EXPECTED_OWNERS)) {
    it(`"${id}" is defined ONLY by ${EXPECTED_OWNERS[id].join(', ')}`, () => {
      const actualOwners = connectorsDefiningTool(id).sort();
      const expectedOwners = [...EXPECTED_OWNERS[id]].sort();

      // The tool must exist (catch a rename that would silently un-trust it).
      expect(actualOwners.length).toBeGreaterThan(0);

      // And it must be owned by exactly the expected connector(s) — no other
      // connector may define a tool with this name, or it would inherit trust.
      expect(actualOwners).toEqual(expectedOwners);
    });
  }
});
