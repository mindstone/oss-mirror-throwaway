import fs from 'node:fs/promises';
import path from 'node:path';

import type { AnyAttachmentPayload } from '@shared/types';
import { CHIEF_DESIGNER_COMMAND } from '@shared/ourComponents';

const COMMAND_PATTERN = /(^|[\s(])@CHIEF_DESIGNER(?=$|[\s),.!?:;])/g;

const DESIGN_DOMAIN_PATTERNS: RegExp[] = [
  /\b(ui|interface|layout|component|components|design system|storybook|pattern|patterns)\b/i,
  /\b(button|icon button|hero input|dialog|modal|card|toggle|select|tabs|settings rows?|chip|chips|composer)\b/i,
  /\b(settings(?:\s*>\s*[a-z][\w -]+)?|settings page|homepage|home page|current screen|current page|current view|this screen|this page|this view|visible ui|library page|composer view)\b/i,
];

const DESIGN_ACTION_PATTERNS: RegExp[] = [
  /\b(design|redesign|review|improve|harmonis|consistent|polish|amend|build|create|implement|judge|validate|iterate|tweak)\b/i,
  /\b(what do you think|does (?:this|that|the) .+ work)\b/i,
  /\b(take a look|look at|how does (?:this|that|the) .+ feel)\b/i,
];

const NON_UI_TECHNICAL_PATTERNS: RegExp[] = [
  /\b(TypeScript|service|parser|capture service|schema|ipc|backend|database|store|test|spec)\b/i,
];

const UI_ATTACHMENT_HINT_PATTERNS: RegExp[] = [
  /src\/renderer\/components\/ui\//i,
  /src\/renderer\/features\/.+\/components\//i,
  /\.stories\.(?:t|j)sx?$/i,
  /storybookManifest\.ts$/i,
  /storybook_component_manifest\.json$/i,
  /components\/ui\/README\.md$/i,
];

const README_SECTION_BY_FAMILY: Partial<Record<string, string[]>> = {
  buttons: ['Button'],
  inputs: ['Input / Textarea / Label', 'Select'],
  'select-family': ['Select', 'RichSelect'],
  'dialogs-feedback': ['Dialog', 'Tooltip'],
  toggles: ['Toggle'],
  'icon-button': ['IconButton'],
};

const DEFAULT_FAMILY_IDS = [
  'hero-input',
  'buttons',
  'inputs',
  'dialogs-feedback',
  'icon-button',
  'settings-rows',
];

type ReadmeCacheEntry = {
  raw: string;
  sectionSummaries: Map<string, string>;
};

interface StorybookFamilyEntry {
  id: string;
  title: string;
  storyTitle: string;
  status: 'shared' | 'app-pattern' | 'missing';
  atomicLevel: 'atom' | 'molecule' | 'organism' | 'mixed';
  summary: string;
  sourceFiles: string[];
  appUsageFiles: string[];
  notes?: string[];
}

interface StorybookManifestFile {
  families?: StorybookFamilyEntry[];
}

const readmeCache = new Map<string, Promise<ReadmeCacheEntry>>();
const manifestCache = new Map<string, Promise<StorybookFamilyEntry[]>>();

/**
 * Thrown when the our-components grounding files (UI README and Storybook
 * manifest) are not present at the configured `coreDirectory`. In production
 * `coreDirectory` is the user's workspace, not the Rebel git repo, so these
 * files are absent — that's expected, not an error worth warning about every
 * turn. Callers should detect this class and downgrade their logging.
 */
export class OurComponentsContextUnavailableError extends Error {
  readonly code = 'OUR_COMPONENTS_UNAVAILABLE' as const;
  readonly coreDirectory: string;
  readonly missingPath: string;

  constructor(coreDirectory: string, missingPath: string) {
    super(`Our-components context unavailable: missing ${missingPath}`);
    this.name = 'OurComponentsContextUnavailableError';
    this.coreDirectory = coreDirectory;
    this.missingPath = missingPath;
  }
}

function isEnoent(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

export interface OurComponentsPromptParseResult {
  explicitRequested: boolean;
  sanitizedPrompt: string;
}

export interface OurComponentsContextOptions {
  prompt: string;
  coreDirectory: string;
  attachments?: AnyAttachmentPayload[];
  explicitRequested?: boolean;
}

function collapseWhitespace(value: string): string {
  return value.replace(/[ \t]{2,}/g, ' ').trim();
}

export function stripOurComponentsCommand(prompt: string): OurComponentsPromptParseResult {
  const explicitRequested = COMMAND_PATTERN.test(prompt);
  COMMAND_PATTERN.lastIndex = 0;

  if (!explicitRequested) {
    return { explicitRequested: false, sanitizedPrompt: prompt };
  }

  const sanitizedPrompt = collapseWhitespace(prompt.replace(COMMAND_PATTERN, '$1 '));
  return { explicitRequested: true, sanitizedPrompt };
}

function tokenizePrompt(prompt: string): string[] {
  return Array.from(
    new Set(
      prompt
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3),
    ),
  );
}

function matchesAttachmentHint(attachments: AnyAttachmentPayload[] = []): boolean {
  return attachments.some((attachment) => {
    const candidates = getAttachmentPathCandidates(attachment);
    return candidates.some((candidate) =>
      UI_ATTACHMENT_HINT_PATTERNS.some((pattern) => pattern.test(candidate)),
    );
  });
}

function getAttachmentPathCandidates(attachment: AnyAttachmentPayload): string[] {
  if ('relativePath' in attachment && 'path' in attachment) {
    return [attachment.relativePath, attachment.path, attachment.name].filter(Boolean);
  }

  if ('originalPath' in attachment) {
    return [attachment.originalPath, attachment.name].filter(
      (candidate): candidate is string => Boolean(candidate),
    );
  }

  return [attachment.name].filter(Boolean);
}

export function shouldInjectOurComponentsContext(
  prompt: string,
  attachments: AnyAttachmentPayload[] = [],
  explicitRequested: boolean = false,
): boolean {
  if (explicitRequested) {
    return true;
  }

  const hasAttachmentHints = matchesAttachmentHint(attachments);
  const hasDomainIntent = DESIGN_DOMAIN_PATTERNS.some((pattern) => pattern.test(prompt));
  const hasActionIntent = DESIGN_ACTION_PATTERNS.some((pattern) => pattern.test(prompt));
  const looksLikeNonUiTechnicalWork = NON_UI_TECHNICAL_PATTERNS.some((pattern) => pattern.test(prompt));

  if (looksLikeNonUiTechnicalWork && !hasAttachmentHints) {
    return false;
  }

  if (hasAttachmentHints) {
    return hasDomainIntent;
  }

  return hasDomainIntent && hasActionIntent;
}

function scoreFamilyAgainstPrompt(family: StorybookFamilyEntry, promptTokens: string[]): number {
  const haystack = [
    family.id,
    family.title,
    family.storyTitle,
    family.summary,
    family.atomicLevel,
    family.status,
    ...(family.notes ?? []),
    ...family.sourceFiles,
    ...family.appUsageFiles,
  ]
    .join(' ')
    .toLowerCase();

  let score = family.status === 'shared' ? 4 : family.status === 'app-pattern' ? 2 : 0.5;

  for (const token of promptTokens) {
    if (family.title.toLowerCase().includes(token)) score += 4;
    if (family.id.includes(token)) score += 4;
    if (family.summary.toLowerCase().includes(token)) score += 3;
    if ((family.notes ?? []).some((note) => note.toLowerCase().includes(token))) score += 2;
    if (haystack.includes(token)) score += 1;
  }

  return score;
}

function selectRelevantFamilies(
  prompt: string,
  storybookManifest: StorybookFamilyEntry[],
): StorybookFamilyEntry[] {
  const promptTokens = tokenizePrompt(prompt);
  const ranked = [...storybookManifest]
    .map((family) => ({ family, score: scoreFamilyAgainstPrompt(family, promptTokens) }))
    .sort((a, b) => b.score - a.score || a.family.title.localeCompare(b.family.title));

  const selected = ranked
    .filter(({ score }, index) => score > 4 || index < DEFAULT_FAMILY_IDS.length)
    .map(({ family }) => family);

  const deduped = new Map<string, StorybookFamilyEntry>();
  for (const family of selected) {
    deduped.set(family.id, family);
  }

  for (const defaultId of DEFAULT_FAMILY_IDS) {
    const fallback = storybookManifest.find((family) => family.id === defaultId);
    if (fallback) {
      deduped.set(fallback.id, fallback);
    }
  }

  return Array.from(deduped.values()).slice(0, 6);
}

function extractMarkdownSection(markdown: string, heading: string): string | undefined {
  const lines = markdown.split('\n');
  const headingIndex = lines.findIndex((line) => line.trim() === `### ${heading}`);
  if (headingIndex === -1) {
    return undefined;
  }

  let endIndex = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (/^#{1,3}\s+/.test(lines[index])) {
      endIndex = index;
      break;
    }
  }

  return lines.slice(headingIndex + 1, endIndex).join('\n').trim();
}

function summarizeReadmeSection(section: string): string | undefined {
  const cleanLines = section
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !line.startsWith('```') &&
        !line.startsWith('<') &&
        !line.startsWith('//'),
    );

  if (cleanLines.length === 0) {
    return undefined;
  }

  const summaryLines: string[] = [];

  const descriptiveLine = cleanLines.find((line) => !line.startsWith('**') && !line.startsWith('<'));
  if (descriptiveLine) {
    summaryLines.push(descriptiveLine);
  }

  for (const line of cleanLines) {
    if (
      line.startsWith('Use ') ||
      line.startsWith('Do not ') ||
      line.startsWith('Variants:') ||
      line.startsWith('**Sizes:**')
    ) {
      summaryLines.push(line);
    }
  }

  return Array.from(new Set(summaryLines)).slice(0, 3).join(' ');
}

async function loadUiReadmeCache(coreDirectory: string): Promise<ReadmeCacheEntry> {
  const cacheKey = path.resolve(coreDirectory);
  const cached = readmeCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const pending = (async (): Promise<ReadmeCacheEntry> => {
    const readmePath = path.join(cacheKey, 'src', 'renderer', 'components', 'ui', 'README.md');
    let raw: string;
    try {
      raw = await fs.readFile(readmePath, 'utf8');
    } catch (error) {
      if (isEnoent(error)) {
        throw new OurComponentsContextUnavailableError(cacheKey, readmePath);
      }
      throw error;
    }
    const sectionSummaries = new Map<string, string>();

    for (const [familyId, headings = []] of Object.entries(README_SECTION_BY_FAMILY)) {
      const parts = headings
        .map((heading) => extractMarkdownSection(raw, heading))
        .filter((section): section is string => Boolean(section))
        .map((section) => summarizeReadmeSection(section))
        .filter((summary): summary is string => Boolean(summary));

      if (parts.length > 0) {
        sectionSummaries.set(familyId, parts.join(' '));
      }
    }

    return { raw, sectionSummaries };
  })();

  readmeCache.set(cacheKey, pending);
  return pending;
}

async function loadStorybookManifest(coreDirectory: string): Promise<StorybookFamilyEntry[]> {
  const cacheKey = path.resolve(coreDirectory);
  const cached = manifestCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const pending = (async (): Promise<StorybookFamilyEntry[]> => {
    const manifestPath = path.join(
      cacheKey,
      'src',
      'renderer',
      'components',
      'ui',
      'manifests',
      'storybook_component_manifest.json',
    );
    let raw: string;
    try {
      raw = await fs.readFile(manifestPath, 'utf8');
    } catch (error) {
      if (isEnoent(error)) {
        throw new OurComponentsContextUnavailableError(cacheKey, manifestPath);
      }
      throw error;
    }
    const parsed = JSON.parse(raw) as StorybookManifestFile;
    return parsed.families ?? [];
  })();

  manifestCache.set(cacheKey, pending);
  return pending;
}

function formatFamilyContext(
  family: StorybookFamilyEntry,
  readmeSummary?: string,
): string {
  const sourceHints = [...family.sourceFiles, ...family.appUsageFiles].slice(0, 3);

  const parts = [
    `### ${family.title}`,
    `- Status: \`${family.status}\``,
    `- Level: \`${family.atomicLevel}\``,
    `- Summary: ${family.summary}`,
  ];

  if (readmeSummary) {
    parts.push(`- README guidance: ${readmeSummary}`);
  }

  if (sourceHints.length > 0) {
    parts.push(`- Source hints: ${sourceHints.map((source) => `\`${source}\``).join(', ')}`);
  }

  return parts.join('\n');
}

export async function buildOurComponentsContext(
  options: OurComponentsContextOptions,
): Promise<string> {
  const readmeCacheEntry = await loadUiReadmeCache(options.coreDirectory);
  const storybookManifest = await loadStorybookManifest(options.coreDirectory);
  const relevantFamilies = selectRelevantFamilies(options.prompt, storybookManifest);

  const familySections = relevantFamilies.map((family) =>
    formatFamilyContext(family, readmeCacheEntry.sectionSummaries.get(family.id)),
  );

  const triggerReason = options.explicitRequested
    ? `Explicit command \`${CHIEF_DESIGNER_COMMAND}\` requested this context.`
    : 'This request looks like UI/design work, so Chief Designer grounding is being injected proactively.';

  return [
    '## Chief Designer',
    '',
    triggerReason,
    '',
    'Act as Rebel\'s Chief Designer for this request, not as a generic UI helper. Make the product-design call when the relevant facts are known.',
    '',
    'Use Rebel\'s existing component system before inventing new UI.',
    '',
    'Decision ladder:',
    '1. Prefer existing `shared` families in `@renderer/components/ui` first.',
    '2. If no shared family fits, check whether an existing `app-pattern` already solves the problem.',
    '3. Only suggest a new component when current families clearly fail, and explain why reuse is insufficient.',
    '',
    'Visual evidence in the running Rebel app:',
    '',
    '- If the user is reviewing, improving, iterating, or validating a visible Rebel UI surface *in this app* (homepage, current screen, settings, composer, library, etc.), the first visual-evidence step is mandatory: call `rebel_navigate_app` first when they named a built-in surface that is not necessarily current, then call `rebel_get_app_screenshot` before any workspace screenshot search or external browser/dev-app capture route. For named Settings subpages, pass `settings_tab` (for example `{ "destination": "settings", "settings_tab": "meetings" }`). For long or visibly scrollable surfaces, pass `{ "capture_mode": "scroll" }` to capture multiple viewport screenshots.',
    '- Do not search recent screenshot files, saved browser captures, or repo screenshot assets as the primary view of the *current* Rebel window; those are reference or external-site material only unless the user pointed at a specific file.',
    '- Do not ask which source to review when the prompt clearly refers to what they see in Rebel.',
    '',
    'Design System Reviewer handoff:',
    '',
    '- If your recommendation lands on concrete components, variants, tokens, or Storybook coverage, include a compact DSR handoff in your answer: design intent, user conclusion to preserve, chosen component/tier, token or variant needs, Storybook surfaces, and any system gap.',
    '- If the tactical answer is already clear, include DSR picker-mode output directly instead of leaving the user with only a design direction.',
    '- Do not end with a vague "handoff to DSR" note when you can apply the picker-mode checklist yourself.',
    '',
    'Canonical sources:',
    '- `src/renderer/components/ui/README.md` — normative usage rules for shared UI components.',
    '- `src/renderer/components/ui/storybookManifest.ts` — family taxonomy, status, and notes.',
    '- `src/renderer/components/ui/manifests/storybook_component_manifest.json` — committed parity artifact for the manifest.',
    '- `rebel-system/skills/ux/chief-designer/SKILL.md` — design judgment partner for UI work (bundled).',
    '- `rebel-system/skills/ux/design-system-reviewer/SKILL.md` — tactical picker/reviewer for component, token, variant, and Storybook decisions.',
    '',
    'Storybook is a preview/support layer here, not the intelligence layer. Use the README and manifest as the primary grounding, then inspect stories or source files when needed.',
    '',
    'Relevant families for this request:',
    '',
    familySections.join('\n\n'),
    '',
    'When suggesting UI, name the family you are reusing. If you decide a new component is warranted, say which existing shared/app-pattern families you ruled out first.',
  ].join('\n');
}
