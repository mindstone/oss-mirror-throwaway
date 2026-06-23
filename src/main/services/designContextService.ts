import fs from 'node:fs/promises';
import path from 'node:path';

import type { AnyAttachmentPayload } from '@shared/types';
import { DESIGN_CONTEXT_COMMAND } from '@shared/designContext';
import { safeWalkDirectory } from '@core/utils/safeWalkDirectory';

const COMMAND_PATTERN = /(^|[\s(])@designContext(?=$|[\s),.!?:;])/gi;

const DESIGN_DOMAIN_PATTERNS: RegExp[] = [
  /\b(design|redesign|ui|ux|interface|screen|layout|component|components|onboarding|flow|journey|hierarchy)\b/i,
  /\b(persona|personas|research|insight|insights|trust|mental model|cognitive load|naming|information architecture)\b/i,
  /\b(settings|homepage|composer|conversation|approval|first[- ]time|first time|experience)\b/i,
];

const DESIGN_ACTION_PATTERNS: RegExp[] = [
  /\b(review|improve|amend|shape|create|build|design|redesign|refine|plan|recommend|critique)\b/i,
];

const DESIGN_ATTACHMENT_HINT_PATTERNS: RegExp[] = [
  /docs\/project\/ux_testing\//i,
  /\.rebel\/screenshots\//i,
  /docs\/research\//i,
  /personas?\//i,
  /journeys?\//i,
  /research\//i,
];

const CANDIDATE_ROOTS = [
  'personas',
  'user-journeys',
  'research',
  'docs/personas',
  'docs/user-journeys',
  'docs/journeys',
  'docs/research',
  'docs/project/ux_testing/personas',
  'docs/project/ux_testing',
] as const;

type DesignDocKind = 'persona' | 'journey' | 'research';

interface DesignDocEntry {
  relativePath: string;
  absolutePath: string;
  kind: DesignDocKind;
  title: string;
  summary: string;
  scoreText: string;
}

type DesignDocCache = {
  entries: DesignDocEntry[];
};

const cache = new Map<string, Promise<DesignDocCache>>();

export interface DesignContextPromptParseResult {
  explicitRequested: boolean;
  sanitizedPrompt: string;
}

export interface DesignContextOptions {
  prompt: string;
  coreDirectory: string;
  attachments?: AnyAttachmentPayload[];
  explicitRequested?: boolean;
}

function collapseWhitespace(value: string): string {
  return value.replace(/[ \t]{2,}/g, ' ').trim();
}

export function stripDesignContextCommand(prompt: string): DesignContextPromptParseResult {
  const explicitRequested = COMMAND_PATTERN.test(prompt);
  COMMAND_PATTERN.lastIndex = 0;

  if (!explicitRequested) {
    return { explicitRequested: false, sanitizedPrompt: prompt };
  }

  return {
    explicitRequested: true,
    sanitizedPrompt: collapseWhitespace(prompt.replace(COMMAND_PATTERN, '$1 ')),
  };
}

function hasAttachmentHint(attachments: AnyAttachmentPayload[] = []): boolean {
  return attachments.some((attachment) => {
    const candidates = getAttachmentPathCandidates(attachment);
    return candidates.some((candidate) =>
      DESIGN_ATTACHMENT_HINT_PATTERNS.some((pattern) => pattern.test(candidate)),
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

export function shouldInjectDesignContext(
  prompt: string,
  attachments: AnyAttachmentPayload[] = [],
  explicitRequested: boolean = false,
): boolean {
  if (explicitRequested) {
    return true;
  }

  const hasDomainIntent = DESIGN_DOMAIN_PATTERNS.some((pattern) => pattern.test(prompt));
  const hasActionIntent = DESIGN_ACTION_PATTERNS.some((pattern) => pattern.test(prompt));

  if (hasAttachmentHint(attachments)) {
    return hasDomainIntent || hasActionIntent;
  }

  return hasDomainIntent && hasActionIntent;
}

function inferDocKind(relativePath: string): DesignDocKind | undefined {
  const normalized = relativePath.toLowerCase();
  if (normalized.includes('/personas/') || normalized.startsWith('personas/')) {
    return 'persona';
  }
  if (normalized.includes('journey')) {
    return 'journey';
  }
  if (normalized.includes('/research/') || normalized.startsWith('research/')) {
    return 'research';
  }
  return undefined;
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function walkMarkdownFiles(rootPath: string): Promise<string[]> {
  const results: string[] = [];

  // Backed by safeWalkDirectory for cycle/depth/path-length protection
  // (see REBEL-506).
  await safeWalkDirectory(rootPath, {
    onDirectory: ({ name }) => {
      if (name.startsWith('.')) return false;
      return true;
    },
    onFile: ({ absolutePath, name }) => {
      if (!/\.(md|mdx|txt)$/i.test(name)) return;
      results.push(absolutePath);
    },
  });

  return results;
}

function extractHeading(content: string): string | undefined {
  const match = content.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim();
}

function extractSummary(content: string): string {
  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !line.startsWith('#') &&
        !line.startsWith('|') &&
        !line.startsWith('```') &&
        !line.startsWith('- ') &&
        !line.startsWith('* ') &&
        !line.startsWith('**Date:**') &&
        !line.startsWith('**Purpose:**') &&
        !line.startsWith('**Focus:**') &&
        !line.startsWith('**Target Personas:**'),
    );

  return lines.slice(0, 3).join(' ').slice(0, 380);
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

function scoreDoc(entry: DesignDocEntry, promptTokens: string[]): number {
  const haystack = `${entry.relativePath} ${entry.title} ${entry.summary} ${entry.scoreText}`.toLowerCase();
  let score = entry.kind === 'persona' ? 5 : entry.kind === 'journey' ? 4 : 3;

  for (const token of promptTokens) {
    if (entry.title.toLowerCase().includes(token)) score += 4;
    if (entry.relativePath.toLowerCase().includes(token)) score += 3;
    if (entry.summary.toLowerCase().includes(token)) score += 2;
    if (haystack.includes(token)) score += 1;
  }

  return score;
}

async function loadDesignDocCache(coreDirectory: string): Promise<DesignDocCache> {
  const cacheKey = path.resolve(coreDirectory);
  const existing = cache.get(cacheKey);
  if (existing) {
    return existing;
  }

  const pending = (async (): Promise<DesignDocCache> => {
    const candidateFiles = new Map<string, string>();

    for (const relativeRoot of CANDIDATE_ROOTS) {
      const absoluteRoot = path.join(cacheKey, relativeRoot);
      if (!(await fileExists(absoluteRoot))) continue;

      const files = await walkMarkdownFiles(absoluteRoot);
      for (const absolutePath of files) {
        const relativePath = path.relative(cacheKey, absolutePath).replace(/\\/g, '/');
        candidateFiles.set(relativePath, absolutePath);
      }
    }

    const entries: DesignDocEntry[] = [];
    for (const [relativePath, absolutePath] of candidateFiles.entries()) {
      const kind = inferDocKind(relativePath);
      if (!kind) continue;

      const raw = await fs.readFile(absolutePath, 'utf8');
      const title = extractHeading(raw) ?? path.basename(relativePath).replace(/\.(md|mdx|txt)$/i, '');
      const summary = extractSummary(raw);
      entries.push({
        relativePath,
        absolutePath,
        kind,
        title,
        summary,
        scoreText: raw.slice(0, 2000),
      });
    }

    return { entries };
  })();

  cache.set(cacheKey, pending);
  return pending;
}

function selectDocsByKind(
  entries: DesignDocEntry[],
  promptTokens: string[],
): { personas: DesignDocEntry[]; journeys: DesignDocEntry[]; research: DesignDocEntry[] } {
  const ranked = entries
    .map((entry) => ({ entry, score: scoreDoc(entry, promptTokens) }))
    .sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title));

  const personas = ranked
    .filter(({ entry }) => entry.kind === 'persona')
    .slice(0, 2)
    .map(({ entry }) => entry);

  const journeys = ranked
    .filter(({ entry }) => entry.kind === 'journey')
    .slice(0, 1)
    .map(({ entry }) => entry);

  const research = ranked
    .filter(({ entry }) => entry.kind === 'research')
    .slice(0, 3)
    .map(({ entry }) => entry);

  return { personas, journeys, research };
}

function formatDoc(doc: DesignDocEntry): string {
  return [
    `- \`${doc.relativePath}\``,
    `  - ${doc.title}`,
    `  - ${doc.summary || 'No short summary extracted. Read the file for full context.'}`,
  ].join('\n');
}

export async function buildDesignContext(options: DesignContextOptions): Promise<string> {
  const promptTokens = tokenizePrompt(options.prompt);
  const loaded = await loadDesignDocCache(options.coreDirectory);
  const { personas, journeys, research } = selectDocsByKind(loaded.entries, promptTokens);

  const triggerReason = options.explicitRequested
    ? `Explicit command \`${DESIGN_CONTEXT_COMMAND}\` requested product/design memory.`
    : 'This request looks like product or UI design work, so persona, journey, and research context is being injected proactively.';

  const sections: string[] = [
    '## Design Context',
    '',
    triggerReason,
    '',
    'Use this context in the following order:',
    '1. User problem and evidence',
    '2. Personas and user journeys',
    '3. Research findings and trust implications',
    '4. Component/system fit',
    '',
    'These are short previews, not the full files. Read the source files if a decision depends on nuance.',
  ];

  if (personas.length > 0) {
    sections.push('', '### Personas', personas.map(formatDoc).join('\n'));
  }
  if (journeys.length > 0) {
    sections.push('', '### User Journeys', journeys.map(formatDoc).join('\n'));
  }
  if (research.length > 0) {
    sections.push('', '### Research', research.map(formatDoc).join('\n'));
  }

  sections.push(
    '',
    'Do not jump straight to components or surface polish. Start with the user problem, trust risks, mental model, and where the journey currently breaks.'
  );

  return sections.join('\n');
}
