import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from '@core/utils/atomicFileWrite';
import { isPathInsideLexical } from '@core/utils/systemUtils';
import {
  createChiefOfStaffHygieneBackup,
  writeChiefOfStaffHygieneManifest,
  type ChiefOfStaffHygieneRunManifest,
} from './chiefOfStaffHygieneBackupService';
import {
  createReadmeHash,
  DEFAULT_CHIEF_OF_STAFF_HYGIENE_THRESHOLDS,
  type ChiefOfStaffHygieneThresholds,
} from './chiefOfStaffHygieneEligibilityService';
import {
  formatDistilledReadmeBullets,
  validateChiefOfStaffDistillationOutput,
  type ChiefOfStaffDistillationOutput,
  type ChiefOfStaffHygieneDistiller,
} from './chiefOfStaffHygieneDistillationService';

interface MarkdownSection {
  heading: string;
  level: number;
  rawHeading: string;
  body: string;
  startLine: number;
  endLineExclusive: number;
}

interface MoveCandidate {
  section: MarkdownSection;
  destination: 'topic' | 'archive';
  archiveReason?: 'stale' | 'expired';
  movedBody: string;
  replacementLines: string[];
}

interface ExpiredBlockCandidate {
  section: MarkdownSection;
  startLine: number;
  endLineExclusive: number;
  movedBody: string;
}

interface CompressedBlockCandidate {
  section: MarkdownSection;
  startLine: number;
  endLineExclusive: number;
  movedBody: string;
  summaryTitle: string;
  references: string[];
}

interface DistillationCandidate {
  section: MarkdownSection;
  startLine: number;
  endLineExclusive: number;
  movedBody: string;
  summaryTitle: string;
}

interface AcceptedDistillationCandidate extends DistillationCandidate {
  topicPath: string;
  relativeTopicPath: string;
  output: ChiefOfStaffDistillationOutput;
}

interface RewriteSpan {
  startLine: number;
  endLineExclusive: number;
  replacementLines: string[];
}

export interface ChiefOfStaffHygieneRewriteOptions {
  thresholds?: Partial<ChiefOfStaffHygieneThresholds>;
  runId?: string;
  now?: Date;
  distiller?: ChiefOfStaffHygieneDistiller;
  maxDistillationCandidates?: number;
}

export interface ChiefOfStaffHygieneRewriteResult {
  changed: boolean;
  runId: string | null;
  readmePath: string;
  backupPath: string | null;
  manifestPath: string | null;
  afterBytes: number | null;
  filesCreated: string[];
  sectionsMoved: ChiefOfStaffHygieneRunManifest['sectionsMoved'];
  sectionsDistilled: NonNullable<ChiefOfStaffHygieneRunManifest['sectionsDistilled']>;
  duplicateBlocksRemoved: number;
  skippedRiskyItems: ChiefOfStaffHygieneRunManifest['skippedRiskyItems'];
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const ISO_DATE_RE = /\b(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/;
const EXPIRES_MARKER_RE =
  /\bexpires:\s*((?:20\d{2})-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])|\d{6})\b/i;
const CURRENT_SECTION_HEADING_RE = /\b(current|now|today|priority|priorities|focus|active)\b/i;
const RISKY_HEADING_RE = /\b(identity|profile|bio|about me|personal context|preference|preferences|goal|goals|objective|objectives|principle|principles|shared|private|privacy|team|company|public|publish|sharing|permission|permissions|confidential|security|secret|secrets|credential|credentials|token|tokens|password|passwords|api[- ]keys?)\b/i;
const RISKY_BODY_RE = /\b(identity|profile|bio|about me|personal context|preference|preferences|goal|goals|objective|objectives|principle|principles|shared|privacy|public|publish|sharing|permission|permissions|confidential|secret|secrets|credential|credentials|token|tokens|password|passwords|api[- ]keys?)\b/i;
const INSTRUCTION_BLOCK_RE =
  /\b(rebel|agent|assistant|instruction|system|prompt|always|never|must|should|guideline|guidelines)\b/i;
const STRICT_INSTRUCTION_BLOCK_RE = /\b(rebel|agent|assistant|system prompt|prompt instruction|system instruction)\b/i;
const FIRST_PERSON_PROFILE_RE = /\b(i|me|my|mine)\b/i;
const WORK_CONTEXT_RE =
  /\b(product|project|topic|customer|research|release|launch|roadmap|feature|workstream|meeting|migration|operational|context|integration|workflow|team|client|pilot|deal|sales|support|documentation|design|engineering)\b/i;
const WORK_CONTEXT_HEADING_RE =
  /\b(current|active|operational|work|working|focus|priority|priorities)\b|\b(?:product|project)\s+context\b|\bcontext\s+(?:product|project)\b/i;
const TEMPLATE_CRUFT_HEADING_RE =
  /^(related spaces|setup\s*\(first run\)|company variables|mcps\s*\(integrations\)|auto-loaded memory \(in this agents\.md\)|approvals ux behavior|product ideation and recent source captures|source captures .+|variable placeholders|see also)$/i;
const HARD_PIN_BLOCK_RE =
  /\b(identity|profile|bio|about me|personal|personal context|preference|preferences|goal|goals|objective|objectives|principle|principles|privacy|confidential|secret|secrets|credential|credentials|token|tokens|password|passwords|api[- ]keys?|salary|equity|health|hr|visa|do not share|don't share|never share)\b/i;
const BOUNDARY_PIN_BLOCK_RE =
  /\b(shared|private|privacy|public|publish|sharing|permission|permissions|company-wide|restricted)\b/i;
const MEMORY_REFERENCE_RE = /(\[\[[^\]]+\]\]|\[[^\]]+\]\([^)]+\)|`(?:memory\/topics|topics|sources)\/[^`]+`)/g;
const MIN_TOPIC_BACKED_COMPRESSION_CHARACTERS = 250;
const MIN_STRUCTURED_DISTILLATION_CHARACTERS = 320;
const MIN_PARTIAL_EXTRACTION_CHARACTERS = 400;
const DEFAULT_MAX_DISTILLATION_CANDIDATES_PER_RUN = 4;
const PARTIAL_SIGNPOST_PLACEHOLDER = '__CHIEF_OF_STAFF_HYGIENE_SIGNPOST__';
const DISTILLATION_BLOCKED_HEADING_RE =
  /\b(identity|profile|bio|about me|personal context|preference|preferences|goal|goals|objective|objectives|principle|principles|shared|public|publish|sharing|permission|permissions|security|secret|secrets|credential|credentials|token|tokens|password|passwords|api[- ]keys?)\b/i;
const DISTILLATION_HARD_PIN_BLOCK_RE =
  /\b(identity|profile|bio|about me|personal|personal context|preference|preferences|goal|goals|objective|objectives|principle|principles|secret|secrets|credential|credentials|token|tokens|password|passwords|api[- ]keys?|salary|equity|health|hr|visa|do not share|don't share|never share)\b/i;

export async function rewriteChiefOfStaffReadmeSafeSections(
  coreDirectory: string,
  readmePath: string,
  options: ChiefOfStaffHygieneRewriteOptions = {},
): Promise<ChiefOfStaffHygieneRewriteResult> {
  assertRewriteTargetIsSafe(coreDirectory, readmePath);
  await assertNoSymlinkInPath(coreDirectory, readmePath);
  const thresholds = {
    ...DEFAULT_CHIEF_OF_STAFF_HYGIENE_THRESHOLDS,
    ...options.thresholds,
  };
  const readmeContent = await fsp.readFile(readmePath, 'utf8');
  // Anchor abort-on-concurrent-change detection to the in-memory snapshot
  // taken at the very start of the rewrite. Subsequent steps (distillation,
  // backup creation) re-read from disk; if we hashed THAT content instead,
  // any concurrent change that landed during distillation would silently
  // become the baseline and the post-rewrite abort check would miss it.
  const initialReadmeHash = createReadmeHash(readmeContent);
  const now = options.now ?? new Date();
  const lines = readmeContent.split(/\r?\n/);
  const sections = parseMarkdownSections(lines);
  const skippedRiskyItems: ChiefOfStaffHygieneRunManifest['skippedRiskyItems'] = [];
  const candidates: MoveCandidate[] = [];
  for (const section of sections) {
    const staleCurrentSection = isStaleCurrentSection(
      section,
      now,
      thresholds.staleCurrentSectionAgeDays,
    );
    const longSection = isSectionTooLong(section, thresholds);
    const expiredSection = isExpiredSection(section, now);
    const templateCruftSection = isTemplateCruftSection(section);
    if (!staleCurrentSection && !longSection && !expiredSection && !templateCruftSection) {
      continue;
    }
    if (templateCruftSection) {
      candidates.push({
        section,
        destination: 'topic',
        movedBody: section.body,
        replacementLines: [section.rawHeading],
      });
      continue;
    }
    if (RISKY_HEADING_RE.test(section.heading)) {
      skippedRiskyItems.push({
        reason: 'risky_section_not_rewritten',
        path: toWorkspaceRelative(coreDirectory, readmePath),
        heading: section.heading,
      });
      continue;
    }
    if (isReferenceBackedSection(section, thresholds)) {
      candidates.push({
        section,
        destination: 'topic',
        movedBody: section.body,
        replacementLines: [section.rawHeading],
      });
      continue;
    }
    if (expiredSection && requiresPartialExtraction(section.body)) {
      skippedRiskyItems.push({
        reason: 'risky_section_not_rewritten',
        path: toWorkspaceRelative(coreDirectory, readmePath),
        heading: section.heading,
      });
      continue;
    }
    if (requiresPartialExtraction(section.body)) {
      const partial = buildPartialExtraction(section);
      if (!partial) {
        skippedRiskyItems.push({
          reason: 'risky_section_not_rewritten',
          path: toWorkspaceRelative(coreDirectory, readmePath),
          heading: section.heading,
        });
        continue;
      }
      candidates.push({
        section,
        destination: staleCurrentSection || expiredSection ? 'archive' : 'topic',
        archiveReason: expiredSection ? 'expired' : staleCurrentSection ? 'stale' : undefined,
        movedBody: partial.movedBody,
        replacementLines: [
          section.rawHeading,
          '',
          ...partial.retainedLines,
          '',
          partial.signpostPlaceholder,
          '',
        ],
      });
      continue;
    }
    candidates.push({
      section,
      destination: staleCurrentSection || expiredSection ? 'archive' : 'topic',
      archiveReason: expiredSection ? 'expired' : staleCurrentSection ? 'stale' : undefined,
      movedBody: section.body,
      replacementLines: [section.rawHeading],
    });
  }
  const expiredBlocks = findExpiredBlockCandidates(sections, lines, now, coreDirectory, readmePath, skippedRiskyItems)
    .filter((block) => !candidates.some((candidate) => containsLine(candidate.section, block.startLine)));
  const compressedBlocks = findTopicBackedCompressionCandidates(sections, lines, thresholds)
    .filter((block) => (
      !expiredBlocks.some((expiredBlock) => containsLineRange(expiredBlock, block.startLine, block.endLineExclusive))
    ));
  const topicRoot = path.join(path.dirname(readmePath), 'memory', 'topics', 'auto-hygiene');
  assertPathInsideWorkspace(coreDirectory, topicRoot);
  const archiveRoot = path.join(topicRoot, 'archive');
  assertPathInsideWorkspace(coreDirectory, archiveRoot);
  const reservedTopicPaths = new Set<string>();
  const acceptedDistillations = await resolveDistillationCandidates(
    sections,
    lines,
    thresholds,
    coreDirectory,
    readmePath,
    topicRoot,
    reservedTopicPaths,
    now,
    options.distiller,
    options.maxDistillationCandidates ?? DEFAULT_MAX_DISTILLATION_CANDIDATES_PER_RUN,
    skippedRiskyItems,
    [...expiredBlocks, ...compressedBlocks],
  );
  const effectiveCandidates = candidates.filter((candidate) => {
    const candidateContainsAcceptedDistillation = acceptedDistillations.some((distillation) => (
      containsLineRange(candidate.section, distillation.startLine, distillation.endLineExclusive)
    ));
    const candidateContainsCompressedBlock = compressedBlocks.some((block) => (
      containsLineRange(candidate.section, block.startLine, block.endLineExclusive)
    ));
    return !candidateContainsAcceptedDistillation && !candidateContainsCompressedBlock;
  });
  const duplicateBlocks = findDuplicateInstructionBlocks(
    lines,
    thresholds.duplicateInstructionBlockMinCharacters,
  ).filter((block) => (
    !effectiveCandidates.some((candidate) => containsLine(candidate.section, block.startLine))
    && !expiredBlocks.some((expiredBlock) => containsLineRange(expiredBlock, block.startLine, block.endLineExclusive))
    && !compressedBlocks.some((compressedBlock) => containsLineRange(compressedBlock, block.startLine, block.endLineExclusive))
    && !acceptedDistillations.some((distillation) => containsLineRange(distillation, block.startLine, block.endLineExclusive))
  ));

  if (
    effectiveCandidates.length === 0
    && expiredBlocks.length === 0
    && compressedBlocks.length === 0
    && acceptedDistillations.length === 0
    && duplicateBlocks.length === 0
  ) {
    return {
      changed: false,
      runId: null,
      readmePath,
      backupPath: null,
      manifestPath: null,
      afterBytes: null,
      filesCreated: [],
      sectionsMoved: [],
      sectionsDistilled: [],
      duplicateBlocksRemoved: 0,
      skippedRiskyItems,
    };
  }

  const backup = await createChiefOfStaffHygieneBackup(coreDirectory, readmePath, {
    runId: options.runId,
    now: options.now,
    beforeHash: initialReadmeHash,
  });
  await assertNoSymlinkInPath(coreDirectory, topicRoot);
  await assertNoSymlinkInPath(coreDirectory, archiveRoot);
  await fsp.mkdir(topicRoot, { recursive: true, mode: 0o700 });
  await fsp.mkdir(archiveRoot, { recursive: true, mode: 0o700 });

  const rewriteSpans: RewriteSpan[] = [];
  const filesCreated: string[] = [];
  const sectionsMoved: ChiefOfStaffHygieneRunManifest['sectionsMoved'] = [];
  const sectionsDistilled: NonNullable<ChiefOfStaffHygieneRunManifest['sectionsDistilled']> = [];

  for (const candidate of effectiveCandidates) {
    const { section } = candidate;
    const destinationRoot = candidate.destination === 'archive' ? archiveRoot : topicRoot;
    const topicPath = await createUniqueTopicPath(destinationRoot, slugify(section.heading), reservedTopicPaths);
    assertPathInsideWorkspace(coreDirectory, topicPath);
    const topicContent = buildTopicContent(section, readmePath, now, candidate.destination, candidate.movedBody);
    await writeDurable(topicPath, topicContent);
    const relativeTopicPath = toWorkspaceRelative(path.dirname(readmePath), topicPath);
    const workspaceRelativeTopicPath = toWorkspaceRelative(coreDirectory, topicPath);
    const signpost = candidate.destination === 'archive'
      ? `Archived ${candidate.archiveReason ?? 'stale'} ${section.heading} notes in \`${relativeTopicPath}\`.`
      : `See \`${relativeTopicPath}\` for the detailed ${section.heading} notes.`;
    const replacementLines = candidate.replacementLines.length === 1
      ? [section.rawHeading, '', signpost, '']
      : candidate.replacementLines.map((line) => (
        line === PARTIAL_SIGNPOST_PLACEHOLDER ? signpost : line
      ));
    rewriteSpans.push({
      startLine: section.startLine,
      endLineExclusive: section.endLineExclusive,
      replacementLines,
    });
    filesCreated.push(workspaceRelativeTopicPath);
    sectionsMoved.push({
      heading: section.heading,
      topicPath: workspaceRelativeTopicPath,
      signpost,
    });
  }
  for (const expiredBlock of expiredBlocks) {
    const topicPath = await createUniqueTopicPath(
      archiveRoot,
      `${slugify(expiredBlock.section.heading)}-expired`,
      reservedTopicPaths,
    );
    assertPathInsideWorkspace(coreDirectory, topicPath);
    const topicContent = buildTopicContent(
      expiredBlock.section,
      readmePath,
      now,
      'archive',
      expiredBlock.movedBody,
    );
    await writeDurable(topicPath, topicContent);
    const workspaceRelativeTopicPath = toWorkspaceRelative(coreDirectory, topicPath);
    const relativeTopicPath = toWorkspaceRelative(path.dirname(readmePath), topicPath);
    const signpost = `Archived expired ${expiredBlock.section.heading} block in \`${relativeTopicPath}\`.`;
    rewriteSpans.push({
      startLine: expiredBlock.startLine,
      endLineExclusive: expiredBlock.endLineExclusive,
      replacementLines: [],
    });
    filesCreated.push(workspaceRelativeTopicPath);
    sectionsMoved.push({
      heading: `${expiredBlock.section.heading} expired block`,
      topicPath: workspaceRelativeTopicPath,
      signpost,
    });
  }
  for (const compressedBlock of compressedBlocks) {
    const topicPath = await createUniqueTopicPath(
      topicRoot,
      `${slugify(compressedBlock.section.heading)}-${slugify(compressedBlock.summaryTitle)}`,
      reservedTopicPaths,
    );
    assertPathInsideWorkspace(coreDirectory, topicPath);
    const topicContent = buildTopicContent(
      compressedBlock.section,
      readmePath,
      now,
      'topic',
      compressedBlock.movedBody,
    );
    await writeDurable(topicPath, topicContent);
    const workspaceRelativeTopicPath = toWorkspaceRelative(coreDirectory, topicPath);
    const relativeTopicPath = toWorkspaceRelative(path.dirname(readmePath), topicPath);
    const signpost = `Details moved to \`${relativeTopicPath}\`.`;
    rewriteSpans.push({
      startLine: compressedBlock.startLine,
      endLineExclusive: compressedBlock.endLineExclusive,
      replacementLines: [buildCompressedBlockSignpost(compressedBlock, relativeTopicPath), ''],
    });
    filesCreated.push(workspaceRelativeTopicPath);
    sectionsMoved.push({
      heading: `${compressedBlock.section.heading}: ${compressedBlock.summaryTitle}`,
      topicPath: workspaceRelativeTopicPath,
      signpost,
    });
  }
  for (const distillation of acceptedDistillations) {
    assertPathInsideWorkspace(coreDirectory, distillation.topicPath);
    const topicContent = buildTopicContent(
      distillation.section,
      readmePath,
      now,
      'topic',
      distillation.movedBody,
    );
    await writeDurable(distillation.topicPath, topicContent);
    const workspaceRelativeTopicPath = toWorkspaceRelative(coreDirectory, distillation.topicPath);
    const replacementLines = [
      ...formatDistilledReadmeBullets(distillation.output.bullets, distillation.relativeTopicPath),
      '',
    ];
    rewriteSpans.push({
      startLine: distillation.startLine,
      endLineExclusive: distillation.endLineExclusive,
      replacementLines,
    });
    filesCreated.push(workspaceRelativeTopicPath);
    const signpost = `Distilled ${distillation.summaryTitle} into linked Chief-of-Staff briefing bullets.`;
    sectionsMoved.push({
      heading: `${distillation.section.heading}: ${distillation.summaryTitle}`,
      topicPath: workspaceRelativeTopicPath,
      signpost,
    });
    sectionsDistilled.push({
      heading: `${distillation.section.heading}: ${distillation.summaryTitle}`,
      topicPath: workspaceRelativeTopicPath,
      promptVersion: distillation.output.promptVersion,
      bullets: distillation.output.bullets,
    });
  }
  for (const block of duplicateBlocks) {
    rewriteSpans.push({
      startLine: block.startLine,
      endLineExclusive: block.endLineExclusive,
      replacementLines: [],
    });
  }

  const rewrittenReadme = applyLineReplacements(lines, rewriteSpans);
  const afterBytes = Buffer.byteLength(rewrittenReadme, 'utf8');
  const currentReadme = await fsp.readFile(readmePath, 'utf8');
  const currentReadmeHash = createReadmeHash(currentReadme);
  if (currentReadmeHash !== backup.manifest.beforeHash) {
    await writeChiefOfStaffHygieneManifest(backup.manifestPath, {
      ...backup.manifest,
      filesCreated,
      sectionsMoved,
      sectionsDistilled,
      duplicateBlocksRemoved: duplicateBlocks.length,
      skippedRiskyItems,
      failures: ['README changed during Chief-of-Staff hygiene rewrite; aborted before overwriting.'],
    });
    throw new Error('Chief-of-Staff README changed during hygiene rewrite; aborted before overwriting.');
  }
  await writeDurable(readmePath, rewrittenReadme);

  const manifest: ChiefOfStaffHygieneRunManifest = {
    ...backup.manifest,
    afterHash: createReadmeHash(rewrittenReadme),
    afterBytes,
    filesCreated,
    filesRewritten: [{
      originalPath: toWorkspaceRelative(coreDirectory, readmePath),
      backupPath: toWorkspaceRelative(coreDirectory, backup.backupPath),
      beforeHash: backup.manifest.beforeHash,
      afterHash: createReadmeHash(rewrittenReadme),
    }],
    sectionsMoved,
    sectionsDistilled,
    duplicateBlocksRemoved: duplicateBlocks.length,
    skippedRiskyItems,
  };
  await writeChiefOfStaffHygieneManifest(backup.manifestPath, manifest);

  return {
    changed: true,
    runId: backup.runId,
    readmePath,
    backupPath: backup.backupPath,
    manifestPath: backup.manifestPath,
    afterBytes,
    filesCreated,
    sectionsMoved,
    sectionsDistilled,
    duplicateBlocksRemoved: duplicateBlocks.length,
    skippedRiskyItems,
  };
}

function parseMarkdownSections(lines: string[]): MarkdownSection[] {
  const sections: MarkdownSection[] = [];
  let current: Omit<MarkdownSection, 'body' | 'endLineExclusive'> | null = null;

  const flush = (endLineExclusive: number): void => {
    if (!current) return;
    const bodyLines = lines.slice(current.startLine + 1, endLineExclusive);
    sections.push({
      ...current,
      body: bodyLines.join('\n').trim(),
      endLineExclusive,
    });
  };

  lines.forEach((line, index) => {
    const match = line.match(HEADING_RE);
    if (!match) return;
    flush(index);
    current = {
      rawHeading: line,
      heading: match[2].trim(),
      level: match[1].length,
      startLine: index,
    };
  });
  flush(lines.length);

  return sections;
}

function isSectionTooLong(section: MarkdownSection, thresholds: ChiefOfStaffHygieneThresholds): boolean {
  const lineCount = section.body.length === 0 ? 0 : section.body.split(/\r?\n/).length;
  return section.body.length > thresholds.maxSectionCharacters || lineCount > thresholds.maxSectionLines;
}

function isTemplateCruftSection(section: MarkdownSection): boolean {
  return section.body.trim().length > 0
    && !/memory\/topics\/auto-hygiene\//i.test(section.body)
    && TEMPLATE_CRUFT_HEADING_RE.test(section.heading);
}

function isReferenceBackedSection(section: MarkdownSection, thresholds: ChiefOfStaffHygieneThresholds): boolean {
  return (isSectionTooLong(section, thresholds) || countListItems(section.body) >= 6)
    && hasMemoryReference(section.body)
    && !/memory\/topics\/auto-hygiene\//i.test(section.body)
    && !RISKY_HEADING_RE.test(section.heading)
    && !HARD_PIN_BLOCK_RE.test(section.body)
    && !BOUNDARY_PIN_BLOCK_RE.test(section.body);
}

function countListItems(value: string): number {
  return value.split(/\r?\n/).filter((line) => /^\s*(?:[-*]|\d+\.)\s+/.test(line)).length;
}

function isStaleCurrentSection(section: MarkdownSection, now: Date, staleCurrentSectionAgeDays: number): boolean {
  if (!CURRENT_SECTION_HEADING_RE.test(section.heading)) {
    return false;
  }
  const match = `${section.heading}\n${section.body}`.match(ISO_DATE_RE);
  if (!match) {
    return false;
  }
  const nowMs = now.getTime();
  const datedAt = new Date(`${match[0]}T00:00:00.000Z`).getTime();
  if (!Number.isFinite(nowMs) || !Number.isFinite(datedAt)) {
    return false;
  }
  const ageDays = Math.floor((nowMs - datedAt) / (24 * 60 * 60 * 1000));
  return ageDays > staleCurrentSectionAgeDays;
}

function isExpiredSection(section: MarkdownSection, now: Date): boolean {
  const firstBodyLine = section.body.split(/\r?\n/).find((line) => line.trim().length > 0) ?? '';
  return containsExpiredMarker(`${section.rawHeading}\n${firstBodyLine}`, now);
}

function containsLine(section: MarkdownSection, line: number): boolean {
  return section.startLine <= line && line < section.endLineExclusive;
}

function containsLineRange(
  range: { startLine: number; endLineExclusive: number },
  startLine: number,
  endLineExclusive: number,
): boolean {
  return range.startLine <= startLine && endLineExclusive <= range.endLineExclusive;
}

function buildPartialExtraction(section: MarkdownSection): {
  movedBody: string;
  retainedLines: string[];
  signpostPlaceholder: typeof PARTIAL_SIGNPOST_PLACEHOLDER;
} | null {
  const blocks = splitBodyIntoMovableBlocks(section.body);
  const movedBlocks = blocks.filter((block) => isSafePartialExtractionBlock(block.text));
  const retainedBlocks = blocks.filter((block) => !isSafePartialExtractionBlock(block.text));
  const movedBody = movedBlocks.map((block) => block.text).join('\n\n').trim();
  if (movedBody.length < MIN_PARTIAL_EXTRACTION_CHARACTERS || retainedBlocks.length === 0) {
    return null;
  }
  return {
    movedBody,
    retainedLines: retainedBlocks
      .flatMap((block) => [...block.text.split(/\r?\n/), ''])
      .slice(0, -1),
    signpostPlaceholder: PARTIAL_SIGNPOST_PLACEHOLDER,
  };
}

function isSafePartialExtractionBlock(block: string): boolean {
  if (
    hasMemoryReference(block)
    && WORK_CONTEXT_RE.test(block)
    && !HARD_PIN_BLOCK_RE.test(block)
    && !BOUNDARY_PIN_BLOCK_RE.test(block)
    && !STRICT_INSTRUCTION_BLOCK_RE.test(block)
  ) {
    return true;
  }
  if (
    block.length >= MIN_PARTIAL_EXTRACTION_CHARACTERS
    && WORK_CONTEXT_RE.test(block)
    && !HARD_PIN_BLOCK_RE.test(block)
    && !BOUNDARY_PIN_BLOCK_RE.test(block)
    && !STRICT_INSTRUCTION_BLOCK_RE.test(block)
  ) {
    return true;
  }

  return !RISKY_BODY_RE.test(block)
    && !INSTRUCTION_BLOCK_RE.test(block)
    && !FIRST_PERSON_PROFILE_RE.test(block)
    && WORK_CONTEXT_RE.test(block);
}

function requiresPartialExtraction(body: string): boolean {
  return RISKY_BODY_RE.test(body)
    || INSTRUCTION_BLOCK_RE.test(body)
    || FIRST_PERSON_PROFILE_RE.test(body);
}

function splitBodyIntoMovableBlocks(body: string): Array<{ text: string }> {
  const blocks: Array<{ text: string }> = [];
  let current: string[] = [];
  const flush = (): void => {
    const text = current.join('\n').trim();
    if (text) {
      blocks.push({ text });
    }
    current = [];
  };

  for (const line of body.split(/\r?\n/)) {
    if (line.trim() === '') {
      flush();
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      flush();
    }
    current.push(line);
  }
  flush();

  return blocks;
}

function findExpiredBlockCandidates(
  sections: MarkdownSection[],
  lines: string[],
  now: Date,
  coreDirectory: string,
  readmePath: string,
  skippedRiskyItems: ChiefOfStaffHygieneRunManifest['skippedRiskyItems'],
): ExpiredBlockCandidate[] {
  const candidates: ExpiredBlockCandidate[] = [];
  for (const section of sections) {
    if (isExpiredSection(section, now)) {
      continue;
    }
    const blocks = splitSectionBodyIntoLineBlocks(section, lines);
    for (const block of blocks) {
      if (!containsExpiredMarker(block.text, now)) {
        continue;
      }
      if (RISKY_HEADING_RE.test(section.heading) || !isSafeExpiredBlock(block.text)) {
        skippedRiskyItems.push({
          reason: 'risky_section_not_rewritten',
          path: toWorkspaceRelative(coreDirectory, readmePath),
          heading: section.heading,
        });
        continue;
      }
      candidates.push({
        section,
        startLine: block.startLine,
        endLineExclusive: block.endLineExclusive,
        movedBody: block.text,
      });
    }
  }
  return candidates;
}

function splitSectionBodyIntoLineBlocks(
  section: MarkdownSection,
  lines: string[],
): Array<{ startLine: number; endLineExclusive: number; text: string }> {
  const blocks: Array<{ startLine: number; endLineExclusive: number; text: string }> = [];
  let startLine = section.startLine + 1;
  let blockLines: string[] = [];

  const flush = (endLineExclusive: number): void => {
    const text = blockLines.join('\n').trim();
    if (text) {
      blocks.push({ startLine, endLineExclusive, text });
    }
    blockLines = [];
  };

  for (let index = section.startLine + 1; index < section.endLineExclusive; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim() === '') {
      flush(index);
      startLine = index + 1;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line) && blockLines.length > 0) {
      flush(index);
      startLine = index;
    }
    if (blockLines.length === 0) {
      startLine = index;
    }
    blockLines.push(line);
  }
  flush(section.endLineExclusive);

  return blocks;
}

function isSafeExpiredBlock(block: string): boolean {
  return !RISKY_BODY_RE.test(block)
    && !INSTRUCTION_BLOCK_RE.test(block)
    && !FIRST_PERSON_PROFILE_RE.test(block)
    && WORK_CONTEXT_RE.test(block);
}

function findTopicBackedCompressionCandidates(
  sections: MarkdownSection[],
  lines: string[],
  thresholds: ChiefOfStaffHygieneThresholds,
): CompressedBlockCandidate[] {
  const candidates: CompressedBlockCandidate[] = [];
  for (const section of sections) {
    if (!isWorkContextCompressionSection(section, thresholds)) {
      continue;
    }
    const blocks = splitSectionBodyIntoLineBlocks(section, lines);
    for (const block of blocks) {
      const candidate = buildTopicBackedCompressionCandidate(section, block);
      if (candidate) {
        candidates.push(candidate);
      }
    }
  }
  return candidates;
}

async function resolveDistillationCandidates(
  sections: MarkdownSection[],
  lines: string[],
  thresholds: ChiefOfStaffHygieneThresholds,
  coreDirectory: string,
  readmePath: string,
  topicRoot: string,
  reservedTopicPaths: Set<string>,
  now: Date,
  distiller: ChiefOfStaffHygieneDistiller | undefined,
  maxDistillationCandidates: number,
  skippedRiskyItems: ChiefOfStaffHygieneRunManifest['skippedRiskyItems'],
  occupiedRanges: Array<{ startLine: number; endLineExclusive: number }>,
): Promise<AcceptedDistillationCandidate[]> {
  if (!distiller) {
    return [];
  }
  const accepted: AcceptedDistillationCandidate[] = [];
  const candidates = findStructuredDistillationCandidates(sections, lines, thresholds)
    .filter((candidate) => !occupiedRanges.some((range) => (
      containsLineRange(range, candidate.startLine, candidate.endLineExclusive)
      || containsLineRange(candidate, range.startLine, range.endLineExclusive)
    )))
    .sort((a, b) => b.movedBody.length - a.movedBody.length);

  const candidateBudget = Math.max(0, Math.floor(maxDistillationCandidates));
  const candidatesToProcess = candidates.slice(0, candidateBudget);
  const deferredCandidates = candidates.slice(candidateBudget);
  for (const candidate of deferredCandidates) {
    removeSupersededRiskySkip(skippedRiskyItems, coreDirectory, readmePath, candidate.section.heading);
    skippedRiskyItems.push({
      reason: 'distillation_candidate_deferred',
      path: toWorkspaceRelative(coreDirectory, readmePath),
      heading: candidate.section.heading,
    });
  }

  for (const candidate of candidatesToProcess) {
    const topicPath = await createUniqueTopicPath(
      topicRoot,
      `${slugify(candidate.section.heading)}-${slugify(candidate.summaryTitle)}`,
      reservedTopicPaths,
    );
    const relativeTopicPath = toWorkspaceRelative(path.dirname(readmePath), topicPath);
    const request = {
      heading: candidate.section.heading,
      originalText: candidate.movedBody,
      relativeTopicPath,
      currentDate: now.toISOString().slice(0, 10),
    };
    const output = await distiller(request);
    if (!output) {
      removeSupersededRiskySkip(skippedRiskyItems, coreDirectory, readmePath, candidate.section.heading);
      skippedRiskyItems.push({
        reason: 'distillation_output_rejected',
        path: toWorkspaceRelative(coreDirectory, readmePath),
        heading: candidate.section.heading,
      });
      continue;
    }
    const validation = validateChiefOfStaffDistillationOutput(output, request);
    if (!validation.ok) {
      removeSupersededRiskySkip(skippedRiskyItems, coreDirectory, readmePath, candidate.section.heading);
      skippedRiskyItems.push({
        reason: `distillation_output_rejected:${validation.failures.join(',')}`,
        path: toWorkspaceRelative(coreDirectory, readmePath),
        heading: candidate.section.heading,
      });
      continue;
    }
    removeSupersededRiskySkip(skippedRiskyItems, coreDirectory, readmePath, candidate.section.heading);
    accepted.push({
      ...candidate,
      topicPath,
      relativeTopicPath,
      output: {
        ...output,
        bullets: validation.bullets,
      },
    });
  }
  return accepted;
}

function removeSupersededRiskySkip(
  skippedRiskyItems: ChiefOfStaffHygieneRunManifest['skippedRiskyItems'],
  coreDirectory: string,
  readmePath: string,
  heading: string,
): void {
  const relativeReadmePath = toWorkspaceRelative(coreDirectory, readmePath);
  for (let index = skippedRiskyItems.length - 1; index >= 0; index -= 1) {
    const item = skippedRiskyItems[index];
    if (
      item.reason === 'risky_section_not_rewritten'
      && item.path === relativeReadmePath
      && item.heading === heading
    ) {
      skippedRiskyItems.splice(index, 1);
    }
  }
}

function findStructuredDistillationCandidates(
  sections: MarkdownSection[],
  lines: string[],
  thresholds: ChiefOfStaffHygieneThresholds,
): DistillationCandidate[] {
  const candidates: DistillationCandidate[] = [];
  for (const section of sections) {
    if (!isDistillableWorkContextSection(section, thresholds)) {
      continue;
    }
    const blocks = splitSectionBodyIntoLineBlocks(section, lines);
    for (const block of blocks) {
      const candidate = buildStructuredDistillationCandidate(section, block);
      if (candidate) {
        candidates.push(candidate);
      }
    }
  }
  return candidates;
}

function isDistillableWorkContextSection(
  section: MarkdownSection,
  thresholds: ChiefOfStaffHygieneThresholds,
): boolean {
  return isSectionTooLong(section, thresholds)
    && WORK_CONTEXT_HEADING_RE.test(section.heading)
    && !DISTILLATION_BLOCKED_HEADING_RE.test(section.heading);
}

function buildStructuredDistillationCandidate(
  section: MarkdownSection,
  block: { startLine: number; endLineExclusive: number; text: string },
): DistillationCandidate | null {
  if (block.text.length < MIN_STRUCTURED_DISTILLATION_CHARACTERS) {
    return null;
  }
  if (!WORK_CONTEXT_RE.test(block.text)) {
    return null;
  }
  if (DISTILLATION_HARD_PIN_BLOCK_RE.test(block.text)) {
    return null;
  }
  if (/memory\/topics\/auto-hygiene\//i.test(block.text)) {
    return null;
  }
  return {
    section,
    startLine: block.startLine,
    endLineExclusive: block.endLineExclusive,
    movedBody: block.text,
    summaryTitle: extractBlockSummaryTitle(block.text),
  };
}

function isWorkContextCompressionSection(
  section: MarkdownSection,
  thresholds: ChiefOfStaffHygieneThresholds,
): boolean {
  return isSectionTooLong(section, thresholds)
    && (WORK_CONTEXT_HEADING_RE.test(section.heading) || hasMemoryReference(section.body))
    && !RISKY_HEADING_RE.test(section.heading);
}

function buildTopicBackedCompressionCandidate(
  section: MarkdownSection,
  block: { startLine: number; endLineExclusive: number; text: string },
): CompressedBlockCandidate | null {
  if (block.text.length < MIN_TOPIC_BACKED_COMPRESSION_CHARACTERS) {
    return null;
  }
  if (
    HARD_PIN_BLOCK_RE.test(block.text)
    || BOUNDARY_PIN_BLOCK_RE.test(block.text)
    || STRICT_INSTRUCTION_BLOCK_RE.test(block.text)
  ) {
    return null;
  }
  if (/memory\/topics\/auto-hygiene\//i.test(block.text)) {
    return null;
  }
  if (!WORK_CONTEXT_RE.test(block.text)) {
    return null;
  }
  const references = extractMemoryReferences(block.text);
  if (references.length === 0) {
    return null;
  }
  return {
    section,
    startLine: block.startLine,
    endLineExclusive: block.endLineExclusive,
    movedBody: block.text,
    summaryTitle: extractBlockSummaryTitle(block.text),
    references,
  };
}

function extractMemoryReferences(value: string): string[] {
  const references = new Set<string>();
  for (const match of value.matchAll(MEMORY_REFERENCE_RE)) {
    references.add(match[0]);
  }
  return [...references].slice(0, 3);
}

function hasMemoryReference(value: string): boolean {
  MEMORY_REFERENCE_RE.lastIndex = 0;
  return MEMORY_REFERENCE_RE.test(value);
}

function extractBlockSummaryTitle(block: string): string {
  const firstLine = block.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? 'Context detail';
  const titleMatch = firstLine.match(/^\s*[-*]\s+(?:(\*\*.+?\*\*)|([^:.[\n]{1,90}))(?:[:.\[]|\s\[|$)/);
  if (titleMatch?.[1]) {
    return titleMatch[1].replace(/\*\*/g, '').trim();
  }
  if (titleMatch?.[2]) {
    return titleMatch[2].trim();
  }
  return firstLine
    .replace(/^\s*[-*]\s+/, '')
    .replace(/\s+/g, ' ')
    .slice(0, 90)
    .trim() || 'Context detail';
}

function buildCompressedBlockSignpost(
  compressedBlock: CompressedBlockCandidate,
  relativeTopicPath: string,
): string {
  const referenceText = compressedBlock.references.length > 0
    ? ` Key references: ${compressedBlock.references.join(', ')}.`
    : '';
  return `- **${compressedBlock.summaryTitle}**: Details moved to \`${relativeTopicPath}\`.${referenceText}`;
}

function containsExpiredMarker(value: string, now: Date): boolean {
  const match = value.match(EXPIRES_MARKER_RE);
  if (!match) {
    return false;
  }
  const expiresAt = parseExpiryMarkerDate(match[1]);
  if (!expiresAt) {
    return false;
  }
  return expiresAt.getTime() <= getUtcDayStart(now).getTime();
}

function parseExpiryMarkerDate(value: string): Date | null {
  if (/^\d{6}$/.test(value)) {
    const year = Number(`20${value.slice(0, 2)}`);
    const month = Number(value.slice(2, 4));
    const day = Number(value.slice(4, 6));
    return createValidUtcDate(year, month, day);
  }
  const [yearValue, monthValue, dayValue] = value.split('-');
  return createValidUtcDate(Number(yearValue), Number(monthValue), Number(dayValue));
}

function createValidUtcDate(year: number, month: number, day: number): Date | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

function getUtcDayStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function findDuplicateInstructionBlocks(
  lines: string[],
  minCharacters: number,
): Array<{ startLine: number; endLineExclusive: number }> {
  const seen = new Set<string>();
  const duplicates: Array<{ startLine: number; endLineExclusive: number }> = [];
  let startLine = 0;
  let blockLines: string[] = [];

  const flush = (endLineExclusive: number): void => {
    const block = blockLines.join('\n').trim();
    if (block) {
      const normalized = normalizeInstructionBlock(block);
      const risky = RISKY_HEADING_RE.test(block) || RISKY_BODY_RE.test(block);
      if (
        normalized.length >= minCharacters
        && INSTRUCTION_BLOCK_RE.test(normalized)
        && !risky
      ) {
        if (seen.has(normalized)) {
          const preserveHeading = HEADING_RE.test(blockLines[0]?.trim() ?? '');
          duplicates.push({
            startLine: preserveHeading ? startLine + 1 : startLine,
            endLineExclusive,
          });
        } else {
          seen.add(normalized);
        }
      }
    }
    blockLines = [];
  };

  lines.forEach((line, index) => {
    if (line.trim() === '') {
      flush(index);
      startLine = index + 1;
      return;
    }
    if (blockLines.length === 0) {
      startLine = index;
    }
    blockLines.push(line);
  });
  flush(lines.length);

  return duplicates;
}

function normalizeInstructionBlock(block: string): string {
  return block
    .split(/\r?\n/)
    .filter((line) => !HEADING_RE.test(line.trim()))
    .map((line) => line.replace(/^[-*]\s+/, '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function buildTopicContent(
  section: MarkdownSection,
  readmePath: string,
  now: Date,
  destination: MoveCandidate['destination'],
  movedBody: string,
): string {
  const action = destination === 'archive' ? 'Archived' : 'Moved';
  return [
    `# ${section.heading}`,
    '',
    `${action} from \`${path.basename(readmePath)}\` by Chief-of-Staff hygiene on ${now.toISOString().slice(0, 10)}.`,
    '',
    movedBody.trim(),
    '',
  ].join('\n');
}

function applyLineReplacements(
  lines: string[],
  spans: RewriteSpan[],
): string {
  const output: string[] = [];
  let cursor = 0;
  const sortedSpans = [...spans].sort((a, b) => a.startLine - b.startLine);
  for (const span of sortedSpans) {
    if (span.startLine < cursor) {
      continue;
    }
    output.push(...lines.slice(cursor, span.startLine));
    output.push(...span.replacementLines);
    cursor = span.endLineExclusive;
  }
  output.push(...lines.slice(cursor));
  return output.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'section';
}

async function createUniqueTopicPath(
  topicRoot: string,
  slug: string,
  reservedTopicPaths: Set<string>,
): Promise<string> {
  for (let suffix = 1; suffix <= 1_000; suffix += 1) {
    const filename = suffix === 1 ? `${slug}.md` : `${slug}-${suffix}.md`;
    const candidate = path.join(topicRoot, filename);
    if (reservedTopicPaths.has(candidate)) {
      continue;
    }
    try {
      await fsp.access(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        reservedTopicPaths.add(candidate);
        return candidate;
      }
      throw error;
    }
  }
  throw new Error(`Unable to create a unique Chief-of-Staff hygiene topic for ${slug}.`);
}

function assertRewriteTargetIsSafe(coreDirectory: string, readmePath: string): void {
  assertPathInsideWorkspace(coreDirectory, readmePath);
  if (path.basename(readmePath).toLowerCase() !== 'readme.md') {
    throw new Error('Chief-of-Staff hygiene rewrite target must be a README.md file.');
  }
}

function assertPathInsideWorkspace(coreDirectory: string, targetPath: string): void {
  if (!isPathInsideLexical(targetPath, coreDirectory)) {
    throw new Error('Chief-of-Staff hygiene rewrite path must stay inside the workspace.');
  }
}

async function assertNoSymlinkInPath(coreDirectory: string, targetPath: string): Promise<void> {
  const relativeParts = path.relative(coreDirectory, targetPath).split(path.sep).filter(Boolean);
  let currentPath = coreDirectory;
  for (const part of relativeParts) {
    currentPath = path.join(currentPath, part);
    try {
      const stat = await fsp.lstat(currentPath);
      if (stat.isSymbolicLink()) {
        throw new Error('Chief-of-Staff hygiene rewrite path must not traverse symlinks.');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }
  }
}

function toWorkspaceRelative(root: string, filePath: string): string {
  return path.relative(root, filePath).replaceAll(path.sep, '/');
}

async function writeDurable(filePath: string, data: string): Promise<void> {
  const result = await atomicWriteFile(filePath, data);
  if (!result.durable) {
    throw new Error(result.error ?? `Failed to write ${path.basename(filePath)}`);
  }
}
