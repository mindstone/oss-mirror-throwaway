import type { z } from 'zod';
import { AccountIdentityEnum } from './connectorCatalogSchema';

export type IdentityKind = z.infer<typeof AccountIdentityEnum>;

export interface IdentityFieldDisplay {
  label: string;
  placeholder: string;
  inputType: 'email' | 'text';
}

/**
 * Identity-kind display defaults consumed via {@link getIdentityFieldDisplay}.
 *
 * **Active today:** `email` and `workspace` entries drive the parent setup form's
 * identity input via `ExpandedConnectionCard.tsx` (the only production callsite).
 *
 * **Latent today:** `subdomain` / `domain` / `tenant` entries are documented latent defaults.
 * Every connector currently using one of these kinds also has a `setupFields[]` entry
 * whose `id` matches the kind, and that setupField owns rendering per the orthogonality
 * convention codified in `docs/project/MCP_ARCHITECTURE.md § Orthogonality`. The registry
 * defaults here apply only when a future connector adopts one of these kinds WITHOUT a
 * matching setupFields entry — in which case the placeholder copy must remain plausibly
 * useful, hence the generic `yourcompany`-style values.
 *
 * `none` is the terminal kind for connectors without an identity input at all.
 */
const IDENTITY_FIELDS = {
  email: { label: 'Account Email', placeholder: 'you@example.com', inputType: 'email' },
  workspace: { label: 'Workspace Name', placeholder: 'My Workspace', inputType: 'text' },
  subdomain: { label: 'Account URL', placeholder: 'yourcompany', inputType: 'text' },
  domain: { label: 'Account URL', placeholder: 'yourcompany', inputType: 'text' },
  tenant: { label: 'Account URL', placeholder: 'yourcompany', inputType: 'text' },
  none: { label: 'Account', placeholder: '', inputType: 'text' },
} as const satisfies Record<IdentityKind, IdentityFieldDisplay>;

/**
 * Single canonical lookup for identity field display. Consumers MUST use this rather than indexing
 * IDENTITY_FIELDS directly so the `undefined` legacy default applies consistently.
 *
 * @see src/shared/connectorCatalogSchema.ts AccountIdentityEnum (source of truth).
 */
export function getIdentityFieldDisplay(
  kind: IdentityKind | undefined,
): IdentityFieldDisplay {
  const resolved: IdentityKind = kind ?? 'email';
  return IDENTITY_FIELDS[resolved];
}

/**
 * Returns the user-facing parameter-name word for the inbox bridge missing-identity warning copy.
 * Returns `'email'` for `undefined` (legacy default per mcp.ts accountIdentity doc);
 * returns `null` only for `'none'`. Consumers must distinguish these cases.
 *
 * @see src/core/services/inbox/inboxBridgeStateMachine.ts (Stage 3 consumer).
 */
export function getIdentityParamName(
  kind: IdentityKind | undefined,
): 'email' | 'workspace name' | 'account URL' | null {
  const resolved: IdentityKind = kind ?? 'email';
  switch (resolved) {
    case 'email':
      return 'email';
    case 'workspace':
      return 'workspace name';
    case 'subdomain':
    case 'domain':
    case 'tenant':
      return 'account URL';
    case 'none':
      return null;
  }
}
