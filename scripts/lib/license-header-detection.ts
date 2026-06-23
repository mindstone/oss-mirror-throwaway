export type LicenseId =
  | 'BUSL-1.1'
  | 'MSL-1.0'
  | 'MSL'
  | 'MIT'
  | 'Apache-2.0'
  | 'BSD'
  | 'BSD-2-Clause'
  | 'BSD-3-Clause'
  | 'ISC'
  | 'MPL-2.0'
  | 'GPL'
  | 'LGPL'
  | 'PolyForm'
  | 'FSL';

const MAX_HEADER_SCAN_CHARS = 24 * 1024;
// The repo's own (canonical) license SPDX identifier, used to activate header injection.
const EXPECTED_OWN_SPDX_RE = /\bspdx-license-identifier\s*:\s*busl-1\.1\b/iu;

const LICENSE_PATTERNS: readonly { id: LicenseId; patterns: readonly RegExp[] }[] = [
  {
    id: 'BUSL-1.1',
    patterns: [
      /\bspdx-license-identifier:\s*busl-1\.1\b/u,
      /\bbusiness\s+source\s+license\s+1\.1\b/u,
      /\bbusl-1\.1\s+license\b/u,
    ],
  },
  {
    id: 'MSL-1.0',
    patterns: [
      /\bspdx-license-identifier:\s*msl-1\.0\b/u,
      /\bmindstone\s+source\s+license\s+1\.0\b/u,
      /\bmsl-1\.0\s+license\b/u,
    ],
  },
  {
    id: 'MSL',
    patterns: [
      /\bspdx-license-identifier:\s*msl\b/u,
      /\bmindstone\s+source\s+license\b/u,
      /\bmsl\s+license\b/u,
    ],
  },
  {
    id: 'MIT',
    patterns: [
      /\bspdx-license-identifier:\s*mit\b/u,
      /\bmit\s+license\b/u,
      /\bpermission\s+is\s+hereby\s+granted,\s+free\s+of\s+charge\b/u,
    ],
  },
  {
    id: 'Apache-2.0',
    patterns: [
      /\bspdx-license-identifier:\s*apache-2\.0\b/u,
      /\bapache\s+license,\s+version\s+2\.0\b/u,
      /\blicensed\s+under\s+the\s+apache\s+license,\s+version\s+2\.0\b/u,
    ],
  },
  {
    id: 'BSD-3-Clause',
    patterns: [
      /\bspdx-license-identifier:\s*bsd-3-clause\b/u,
      /\bredistribution\s+and\s+use\s+in\s+source\s+and\s+binary\s+forms,\s+with\s+or\s+without\s+modification\b[\s\S]{0,160}\bneither\s+the\s+name\b/u,
      /\bbsd\s+3-clause\s+license\b/u,
    ],
  },
  {
    id: 'BSD-2-Clause',
    patterns: [
      /\bspdx-license-identifier:\s*bsd-2-clause\b/u,
      /\bredistribution\s+and\s+use\s+in\s+source\s+and\s+binary\s+forms,\s+with\s+or\s+without\s+modification\b[\s\S]{0,160}\bthis\s+software\s+is\s+provided\s+by\s+the\s+copyright\s+holders\b/u,
      /\bbsd\s+2-clause\s+license\b/u,
    ],
  },
  {
    id: 'ISC',
    patterns: [
      /\bspdx-license-identifier:\s*isc\b/u,
      /\bisc\s+license\b/u,
      /\bpermission\s+to\s+use,\s+copy,\s+modify,\s+and\/or\s+distribute\s+this\s+software\b/u,
    ],
  },
  {
    id: 'MPL-2.0',
    patterns: [
      /\bspdx-license-identifier:\s*mpl-2\.0\b/u,
      /\bmozilla\s+public\s+license\s+version\s+2\.0\b/u,
      /\bthis\s+source\s+code\s+form\s+is\s+subject\s+to\s+the\s+terms\s+of\s+the\s+mozilla\s+public\s+license\b/u,
    ],
  },
  {
    id: 'GPL',
    patterns: [
      /\bspdx-license-identifier:\s*gpl-(?:2\.0|3\.0)(?:-only|-or-later)?\b/u,
      /\bgnu\s+general\s+public\s+license\b/u,
      /\beither\s+version\s+\d+\s+of\s+the\s+license,\s+or\s+\(at\s+your\s+option\)\s+any\s+later\s+version\b/u,
    ],
  },
  {
    id: 'LGPL',
    patterns: [
      /\bspdx-license-identifier:\s*lgpl-(?:2\.1|3\.0)(?:-only|-or-later)?\b/u,
      /\bgnu\s+lesser\s+general\s+public\s+license\b/u,
      /\bgnu\s+library\s+general\s+public\s+license\b/u,
    ],
  },
  {
    id: 'PolyForm',
    patterns: [
      /\bspdx-license-identifier:\s*polyform-[a-z0-9.-]+\b/u,
      /\bpolyform\s+(?:noncommercial|shield|strict|free\s+trial)\s+license\b/u,
      /\bpolyform\s+project\b[\s\S]{0,120}\blicense\b/u,
    ],
  },
  {
    id: 'FSL',
    patterns: [
      /\bspdx-license-identifier:\s*fsl-1\.\d+-[a-z0-9.-]+\b/u,
      /\bfunctional\s+source\s+license\b/u,
      /\bfsl-1\.\d+\s+license\b/u,
    ],
  },
];

function stripCommentSyntax(line: string): string {
  return line
    .replace(/^\uFEFF/u, '')
    .replace(/^\s*(?:\/\*\*?|[*]+\/?|\/\/|#|<!--|-->|[*])\s?/u, '')
    .replace(/\s*(?:\*\/|-->)\s*$/u, '');
}

function normaliseHeaderText(content: string): string {
  const withoutBom = content.replace(/^\uFEFF/u, '');
  const lines = withoutBom.slice(0, MAX_HEADER_SCAN_CHARS).split(/\r?\n/u);
  const firstMeaningfulLine = lines.findIndex(line => line.trim().length > 0);
  const startIndex = firstMeaningfulLine === -1 ? 0 : firstMeaningfulLine;
  const withoutShebang = lines[startIndex]?.startsWith('#!')
    ? lines.slice(startIndex + 1)
    : lines.slice(startIndex);

  return withoutShebang
    .slice(0, 220)
    .map(stripCommentSyntax)
    .join('\n')
    .toLowerCase()
    .replace(/[ \t]+/gu, ' ');
}

function classifySpdxToken(token: string): LicenseId | null {
  const normalised = token.toLowerCase();
  if (normalised === 'busl-1.1') return 'BUSL-1.1';
  if (normalised === 'msl-1.0') return 'MSL-1.0';
  if (normalised === 'msl') return 'MSL';
  if (normalised === 'mit') return 'MIT';
  if (normalised === 'apache-2.0') return 'Apache-2.0';
  if (normalised === 'bsd-2-clause') return 'BSD-2-Clause';
  if (normalised === 'bsd-3-clause') return 'BSD-3-Clause';
  if (/^bsd-[a-z0-9.+-]+$/u.test(normalised)) return 'BSD';
  if (normalised === 'isc') return 'ISC';
  if (normalised === 'mpl-2.0') return 'MPL-2.0';
  if (/^gpl-(?:1\.0|2\.0|3\.0)(?:-only|-or-later|\+)?$/u.test(normalised)) return 'GPL';
  if (/^lgpl-(?:2\.0|2\.1|3\.0)(?:-only|-or-later|\+)?$/u.test(normalised)) return 'LGPL';
  if (/^polyform-[a-z0-9.-]+$/u.test(normalised)) return 'PolyForm';
  if (/^fsl-1\.\d+-[a-z0-9.-]+$/u.test(normalised)) return 'FSL';
  return null;
}

function detectSpdxLicenseExpression(headerText: string): LicenseId | null {
  const spdxMatch = headerText.match(/(?:^|\n)\s*spdx-license-identifier\s*:\s*([^\n]+)/iu);
  if (!spdxMatch) return null;

  const detectedLicenses = spdxMatch[1]
    .match(/[A-Za-z0-9][A-Za-z0-9.+-]*/gu)
    ?.map(classifySpdxToken)
    .filter((id): id is LicenseId => id !== null) ?? [];
  const foreignLicense = detectedLicenses.find(id => id !== 'BUSL-1.1');
  return foreignLicense ?? (detectedLicenses.includes('BUSL-1.1') ? 'BUSL-1.1' : null);
}

export function expectedLicenseHeaderIsPending(expectedHeader: string | null): expectedHeader is null {
  return expectedHeader === null;
}

export function expectedLicenseHeaderHasOwnSpdxIdentifier(expectedHeader: string): boolean {
  return EXPECTED_OWN_SPDX_RE.test(expectedHeader);
}

export function validateExpectedLicenseHeader(expectedHeader: string | null, context = 'expected_header'): void {
  if (expectedLicenseHeaderIsPending(expectedHeader)) return;
  if (expectedLicenseHeaderHasOwnSpdxIdentifier(expectedHeader)) return;
  throw new Error(`${context} must contain SPDX-License-Identifier: BUSL-1.1 to activate license-header injection.`);
}

export function detectLicenseHeader(content: string): LicenseId | null {
  const headerText = normaliseHeaderText(content);
  const spdxLicense = detectSpdxLicenseExpression(headerText);
  if (spdxLicense !== null) {
    return spdxLicense;
  }
  for (const license of LICENSE_PATTERNS) {
    if (license.patterns.some(pattern => pattern.test(headerText))) {
      return license.id;
    }
  }
  return null;
}
