import type { InboundAuthorConnector } from '@rebel/shared';

const DISALLOWED_INBOUND_AUTHOR_CHARS = /[\u0000-\u001F\u007F\u200B-\u200D\uFEFF\u202A-\u202E\u2066-\u2069]/g;

function sanitizeInboundAuthorId(rawAuthorId: string): string {
  return rawAuthorId.replace(DISALLOWED_INBOUND_AUTHOR_CHARS, '');
}

function normalizeSlackAuthorId(rawAuthorId: string): string {
  return sanitizeInboundAuthorId(rawAuthorId).trim().toUpperCase();
}

function normalizeTeamsAuthorId(rawAuthorId: string): string {
  // Stage 0 stub:
  // Future semantics will canonicalize Teams/AAD identities (likely lowercase
  // IDs + tenant-aware formatting), but we keep the behavior no-op-safe here.
  return sanitizeInboundAuthorId(rawAuthorId).trim();
}

function normalizeWhatsappAuthorId(rawAuthorId: string): string {
  // Stage 0 stub:
  // Future semantics will normalize to canonical E.164-ish identifiers.
  return sanitizeInboundAuthorId(rawAuthorId).trim();
}

function normalizeEmailAuthorId(rawAuthorId: string): string {
  // Stage 0 stub:
  // Future semantics will include lowercasing, plus-address stripping, and
  // provider-specific canonicalization (for example gmail dot folding).
  return sanitizeInboundAuthorId(rawAuthorId).trim();
}

export function normalizeAuthorId(connector: InboundAuthorConnector, rawAuthorId: string): string {
  switch (connector) {
    case 'slack':
      return normalizeSlackAuthorId(rawAuthorId);
    case 'teams':
      return normalizeTeamsAuthorId(rawAuthorId);
    case 'whatsapp':
      return normalizeWhatsappAuthorId(rawAuthorId);
    case 'email':
      return normalizeEmailAuthorId(rawAuthorId);
    case 'discord':
      return sanitizeInboundAuthorId(rawAuthorId).trim();
    default: {
      const _exhaustive: never = connector;
      return _exhaustive;
    }
  }
}
