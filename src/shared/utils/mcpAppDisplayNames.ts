export interface ResolvedSourceDisplayName {
  /** User-visible connector/source name. Never a full package instance ID. */
  displayName: string;
  /** Internal Rebel sources use different trust-strip copy (no "From" prefix). */
  sourceKind: 'internal-rebel' | 'known-external' | 'fallback';
  /** True when a defensive fallback heuristic was used. */
  isFallback: boolean;
}

type KnownSourceEntry = {
  displayName: string;
  patterns: RegExp[];
};

const EMPTY_SOURCE_DISPLAY_NAME = 'connected tool';
const INTERNAL_REBEL_DISPLAY_NAME = 'Built into Rebel';

const INTERNAL_REBEL_PACKAGE_IDS = new Set<string>([
  // V1 has no Rebel-owned MCP App source package IDs. Add explicit lowercase
  // package IDs here as internal interactive tools are built; never grant this
  // trust label by prefix (for example, a third-party `rebel-shady` is external).
]);

const KNOWN_SOURCE_CATALOG: KnownSourceEntry[] = [
  {
    displayName: 'Google Workspace',
    patterns: [
      /^GoogleWorkspace(?:[-_]|$)/u,
      /^google[-_]workspace(?:[-_]|$)/iu,
    ],
  },
];

const COMMON_EMAIL_SLUG_TLDS = new Set([
  'ai',
  'app',
  'co',
  'com',
  'dev',
  'edu',
  'gov',
  'io',
  'me',
  'net',
  'org',
  'uk',
]);

function isInternalRebelPackage(packageId: string): boolean {
  return INTERNAL_REBEL_PACKAGE_IDS.has(packageId.toLowerCase());
}

function stripNpmScope(packageId: string): string {
  return packageId.replace(/^@[^/]+\//u, '');
}

function splitPackageTokens(packageFamily: string): string[] {
  return packageFamily.split(/[-_.]+/u).filter(Boolean);
}

function getEmailSlugSuffixLength(tokens: string[]): number | null {
  const lowerTokens = tokens.map((token) => token.toLowerCase());
  const lastToken = lowerTokens.at(-1);
  if (!lastToken) {
    return null;
  }

  const suffixLength = lastToken === 'uk' && lowerTokens.at(-2) === 'co' ? 4 : 3;
  if (tokens.length <= suffixLength || !COMMON_EMAIL_SLUG_TLDS.has(lastToken)) {
    return null;
  }

  const suffix = tokens.slice(-suffixLength);
  return suffix.every((token) => /^[a-z0-9]+$/iu.test(token)) &&
    suffix.some((token) => /[a-z]/iu.test(token))
    ? suffixLength
    : null;
}

function stripCommonInstanceSuffixes(packageFamily: string): { family: string; stripped: boolean } {
  const tokens = splitPackageTokens(packageFamily);
  if (tokens.length <= 2) {
    return { family: packageFamily, stripped: false };
  }

  const lowerTokens = tokens.map((token) => token.toLowerCase());
  const lastToken = lowerTokens.at(-1) ?? '';
  const penultimateToken = lowerTokens.at(-2) ?? '';
  const uuidTail = lowerTokens.slice(-5);

  const stripTokenCount = (count: number): { family: string; stripped: boolean } => ({
    family: tokens.slice(0, -count).join('-'),
    stripped: true,
  });

  if (
    uuidTail.length === 5 &&
    /^[0-9a-f]{8}$/iu.test(uuidTail[0] ?? '') &&
    /^[0-9a-f]{4}$/iu.test(uuidTail[1] ?? '') &&
    /^[1-5][0-9a-f]{3}$/iu.test(uuidTail[2] ?? '') &&
    /^[89ab][0-9a-f]{3}$/iu.test(uuidTail[3] ?? '') &&
    /^[0-9a-f]{12}$/iu.test(uuidTail[4] ?? '')
  ) {
    return stripTokenCount(5);
  }

  const emailSuffixLength = getEmailSlugSuffixLength(tokens);
  if (emailSuffixLength !== null) {
    return stripTokenCount(emailSuffixLength);
  }

  if (
    ['userid', 'uid', 'user'].includes(penultimateToken) &&
    /^[a-z0-9]{3,}$/iu.test(lastToken)
  ) {
    return stripTokenCount(2);
  }

  if (/^\d+$/u.test(penultimateToken) && /^\d+$/u.test(lastToken)) {
    return stripTokenCount(2);
  }

  if (/^\d{4,}$/u.test(lastToken)) {
    return stripTokenCount(1);
  }

  if (/^[0-9a-f]{12,}$/iu.test(lastToken)) {
    return stripTokenCount(1);
  }

  return { family: packageFamily, stripped: false };
}

function toDisplayTitle(rawPackageFamily: string): string {
  const withCamelBoundaries = rawPackageFamily
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1 $2');
  const words = withCamelBoundaries
    .replace(/[^a-z0-9]+/giu, ' ')
    .trim()
    .split(/\s+/u)
    .filter(Boolean);

  if (words.length === 0) {
    return EMPTY_SOURCE_DISPLAY_NAME;
  }

  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

export function resolveSourceDisplayName(
  packageId: string | undefined | null,
): ResolvedSourceDisplayName {
  const trimmedPackageId = packageId?.trim();
  if (!trimmedPackageId) {
    return { displayName: EMPTY_SOURCE_DISPLAY_NAME, sourceKind: 'fallback', isFallback: true };
  }

  const packageFamily = stripNpmScope(trimmedPackageId);
  const lowerPackageFamily = packageFamily.toLowerCase();

  if (isInternalRebelPackage(lowerPackageFamily)) {
    return {
      displayName: INTERNAL_REBEL_DISPLAY_NAME,
      sourceKind: 'internal-rebel',
      isFallback: false,
    };
  }

  for (const entry of KNOWN_SOURCE_CATALOG) {
    if (entry.patterns.some((pattern) => pattern.test(packageFamily))) {
      return { displayName: entry.displayName, sourceKind: 'known-external', isFallback: false };
    }
  }

  const withoutInstanceSuffix = stripCommonInstanceSuffixes(packageFamily);
  const displayFamily = withoutInstanceSuffix.stripped
    ? withoutInstanceSuffix.family
    : splitPackageTokens(withoutInstanceSuffix.family).slice(0, 2).join('-');
  const displayName = toDisplayTitle(displayFamily);
  return { displayName, sourceKind: 'fallback', isFallback: true };
}
