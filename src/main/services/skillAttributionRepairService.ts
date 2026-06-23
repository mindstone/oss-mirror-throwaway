import fs from 'node:fs/promises';
import fm from 'front-matter';
import { createScopedLogger } from '@core/logger';
import { scanSkills, type SkillFrontmatter, type SkillInfo, type SkillsScanResult } from './skillsService';

const log = createScopedLogger({ service: 'skillAttributionRepair' });

type TrustedAuthorRecord = {
  author: string;
  authorId: string;
  authorEmail?: string;
};

type TrustedAuthorCluster = {
  record: TrustedAuthorRecord;
  sampleCount: number;
};

type SkillAttributionIssue =
  | 'missing_author'
  | 'missing_author_id'
  | 'missing_author_email'
  | 'untrusted_author_source'
  | 'already_complete';

export interface SkillAttributionRepairCandidate {
  relativePath: string;
  absolutePath: string;
  issue: SkillAttributionIssue;
  action: 'updated' | 'skipped';
  reason: string;
}

export interface SkillAttributionRepairResult {
  scanned: number;
  updated: number;
  skipped: number;
  candidates: SkillAttributionRepairCandidate[];
}

const TRUSTED_AUTHOR_SOURCES = new Set(['created', 'migrated', 'confirmed']);

function normalizeName(value?: string): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

function isSharedSkillsGroup(group: SkillsScanResult['groups'][number]): boolean {
  return group.type === 'space' && group.sharing !== 'private';
}

function isTrustedAuthor(frontmatter?: SkillFrontmatter): frontmatter is SkillFrontmatter & {
  author: string;
  author_id: string;
} {
  return Boolean(
    frontmatter?.author &&
    frontmatter.author_id &&
    frontmatter.author_source &&
    TRUSTED_AUTHOR_SOURCES.has(frontmatter.author_source),
  );
}

function buildTrustedAuthorMap(groups: SkillsScanResult['groups']): Map<string, TrustedAuthorRecord> {
  const byName = new Map<string, TrustedAuthorRecord[]>();

  for (const group of groups) {
    if (!isSharedSkillsGroup(group)) continue;
    for (const skills of Object.values(group.categories)) {
      for (const skill of skills) {
        if (!isTrustedAuthor(skill.frontmatter)) continue;
        const key = normalizeName(skill.frontmatter.author);
        if (!key) continue;
        const bucket = byName.get(key) ?? [];
        bucket.push({
          author: skill.frontmatter.author,
          authorId: skill.frontmatter.author_id,
          authorEmail: skill.frontmatter.author_email,
        });
        byName.set(key, bucket);
      }
    }
  }

  const trusted = new Map<string, TrustedAuthorRecord>();
  for (const [key, values] of byName.entries()) {
    const distinct = new Map(values.map((value) => [`${value.authorId}::${value.authorEmail ?? ''}`, value]));
    if (distinct.size === 1) {
      const [record] = Array.from(distinct.values());
      if (record) {
        trusted.set(key, record);
      }
    }
  }

  return trusted;
}

function normalizeFamilyToken(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const token = trimmed
    .split(/[-_]/)
    .map((segment) => segment.trim())
    .find(Boolean);
  if (!token || token.length < 4) {
    return null;
  }

  return token.toLowerCase();
}

function getSkillStem(skill: SkillInfo): string | null {
  const normalized = skill.relativePath.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  const fileName = segments.at(-1);
  const parentName = segments.at(-2);

  if (fileName?.toLowerCase() === 'skill.md' && parentName) {
    return parentName;
  }

  if (!fileName) {
    return null;
  }

  return fileName.replace(/\.md$/i, '');
}

function getSkillFamilyKey(skill: SkillInfo): string | null {
  const familyToken = normalizeFamilyToken(getSkillStem(skill) ?? '');
  if (!familyToken) {
    return null;
  }

  return `${skill.category.toLowerCase()}::${familyToken}`;
}

function buildTrustedFamilyMap(groups: SkillsScanResult['groups']): Map<string, TrustedAuthorCluster> {
  const byFamily = new Map<string, TrustedAuthorRecord[]>();

  for (const group of groups) {
    if (!isSharedSkillsGroup(group)) continue;
    for (const skills of Object.values(group.categories)) {
      for (const skill of skills) {
        if (!isTrustedAuthor(skill.frontmatter)) continue;
        const familyKey = getSkillFamilyKey(skill);
        if (!familyKey) continue;

        const bucket = byFamily.get(familyKey) ?? [];
        bucket.push({
          author: skill.frontmatter.author,
          authorId: skill.frontmatter.author_id,
          authorEmail: skill.frontmatter.author_email,
        });
        byFamily.set(familyKey, bucket);
      }
    }
  }

  const trusted = new Map<string, TrustedAuthorCluster>();
  for (const [key, values] of byFamily.entries()) {
    const distinct = new Map(values.map((value) => [`${value.authorId}::${value.authorEmail ?? ''}`, value]));
    if (distinct.size === 1 && values.length >= 2) {
      const [record] = Array.from(distinct.values());
      if (record) {
        trusted.set(key, { record, sampleCount: values.length });
      }
    }
  }

  return trusted;
}

function getTrustedAuthorForSkill(
  skill: SkillInfo,
  trustedAuthors: Map<string, TrustedAuthorRecord>,
  trustedFamilies: Map<string, TrustedAuthorCluster>,
): { trusted: TrustedAuthorRecord | undefined; reason: string } {
  const authorName = normalizeName(skill.frontmatter?.author);
  if (authorName) {
    return {
      trusted: trustedAuthors.get(authorName),
      reason: 'name-match',
    };
  }

  const familyKey = getSkillFamilyKey(skill);
  const cluster = familyKey ? trustedFamilies.get(familyKey) : undefined;
  return {
    trusted: cluster?.record,
    reason: cluster ? `family-match:${cluster.sampleCount}` : 'none',
  };
}

function updateFrontmatter(
  content: string,
  update: (attributes: Record<string, unknown>) => boolean,
): { changed: boolean; content: string } {
  const parsed = fm<Record<string, unknown>>(content);
  const attributes = { ...parsed.attributes };
  const changed = update(attributes);
  if (!changed) {
    return { changed: false, content };
  }

  const lines = ['---'];
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) {
        lines.push(`  - ${JSON.stringify(item)}`);
      }
      continue;
    }
    lines.push(`${key}: ${JSON.stringify(value)}`);
  }
  lines.push('---', '');
  return { changed: true, content: `${lines.join('\n')}${parsed.body}` };
}

async function maybeRepairSkill(
  skill: SkillInfo,
  trustedAuthors: Map<string, TrustedAuthorRecord>,
  trustedFamilies: Map<string, TrustedAuthorCluster>,
): Promise<SkillAttributionRepairCandidate> {
  const frontmatter = skill.frontmatter;
  const { trusted, reason } = getTrustedAuthorForSkill(skill, trustedAuthors, trustedFamilies);
  if (!trusted) {
    return {
      relativePath: skill.relativePath,
      absolutePath: skill.absolutePath,
      issue: frontmatter?.author ? (frontmatter.author_id ? 'untrusted_author_source' : 'missing_author_id') : 'missing_author',
      action: 'skipped',
      reason: frontmatter?.author
        ? 'No unique trusted author mapping exists for this author name.'
        : 'No deterministic author signal exists yet for this legacy skill.',
    };
  }

  const shouldRepairMissingAuthor = !frontmatter?.author && !frontmatter?.last_modified_by_id;
  const shouldRepairMissingId =
    Boolean(frontmatter?.author) &&
    !frontmatter?.author_id &&
    !frontmatter?.last_modified_by_id;
  const shouldRepairTrustedSource =
    Boolean(frontmatter?.author_id) &&
    frontmatter?.author_id === trusted.authorId &&
    !frontmatter?.author_source &&
    !frontmatter?.last_modified_by_id &&
    !frontmatter?.last_modified_at;

  if (!shouldRepairMissingAuthor && !shouldRepairMissingId && !shouldRepairTrustedSource) {
    return {
      relativePath: skill.relativePath,
      absolutePath: skill.absolutePath,
      issue: 'already_complete',
      action: 'skipped',
      reason: 'Skill already has author attribution or has modification history that makes auto-repair unsafe.',
    };
  }

  const raw = await fs.readFile(skill.absolutePath, 'utf8');
  const result = updateFrontmatter(raw, (attributes) => {
    let changed = false;

    if (!attributes.author) {
      attributes.author = trusted.author;
      changed = true;
    }
    if (!attributes.author_id) {
      attributes.author_id = trusted.authorId;
      changed = true;
    }
    if (!attributes.author_email && trusted.authorEmail) {
      attributes.author_email = trusted.authorEmail;
      changed = true;
    }
    if (!attributes.author_source) {
      attributes.author_source = 'migrated';
      changed = true;
    }
    if (!attributes.contributors && attributes.author_id) {
      attributes.contributors = [attributes.author_id];
      changed = true;
    }

    return changed;
  });

  if (!result.changed) {
    return {
      relativePath: skill.relativePath,
      absolutePath: skill.absolutePath,
      issue: 'already_complete',
      action: 'skipped',
      reason: 'No deterministic attribution update was needed.',
    };
  }

  // SAFETY: This uses fs.writeFile directly (bypasses the managed shared-skill pipeline)
  // because repair is a maintenance-only operation that runs during scan, never while users
  // are actively editing. It only touches author/contributor metadata, not skill body content.
  // Do NOT call this while concurrent user or agent edits are in flight.
  await fs.writeFile(skill.absolutePath, result.content, 'utf8');
  return {
    relativePath: skill.relativePath,
    absolutePath: skill.absolutePath,
    issue: shouldRepairMissingAuthor
      ? 'missing_author'
      : (shouldRepairMissingId ? 'missing_author_id' : 'untrusted_author_source'),
    action: 'updated',
    reason: reason.startsWith('family-match')
      ? 'Applied unique trusted family-level author mapping and marked authorship as migrated.'
      : 'Applied unique trusted author mapping and marked authorship as migrated.',
  };
}

export async function repairSharedSkillAttributionFromScanResult(
  workspacePath: string,
  scanResult: SkillsScanResult,
): Promise<SkillAttributionRepairResult> {
  const trustedAuthors = buildTrustedAuthorMap(scanResult.groups);
  const trustedFamilies = buildTrustedFamilyMap(scanResult.groups);
  const candidates: SkillAttributionRepairCandidate[] = [];

  for (const group of scanResult.groups) {
    if (!isSharedSkillsGroup(group)) continue;
    for (const skills of Object.values(group.categories)) {
      for (const skill of skills) {
        candidates.push(await maybeRepairSkill(skill, trustedAuthors, trustedFamilies));
      }
    }
  }

  const updated = candidates.filter((candidate) => candidate.action === 'updated').length;
  const skipped = candidates.length - updated;
  log.info({ scanned: candidates.length, updated, skipped }, 'Shared skill attribution repair complete');

  return {
    scanned: candidates.length,
    updated,
    skipped,
    candidates,
  };
}

export async function repairSharedSkillAttribution(workspacePath: string): Promise<SkillAttributionRepairResult> {
  const scanResult = await scanSkills(workspacePath);
  return repairSharedSkillAttributionFromScanResult(workspacePath, scanResult);
}
