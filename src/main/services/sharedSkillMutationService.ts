import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import fm from 'front-matter';
import { createScopedLogger } from '@core/logger';
import { getErrorReporter } from '@core/errorReporter';
import { getCurrentUserProvider, type CurrentUserSnapshot } from '@core/currentUserProvider';
import { getSettings } from '@core/services/settingsStore';
import type { SpaceType } from '@shared/types';
import { getSpaceDisplayName, readSpaceReadmeFrontmatter, scanSpaces } from './spaceService';

const log = createScopedLogger({ service: 'sharedSkillMutation' });

type NonPrivateSharing = 'restricted' | 'company-wide' | 'public';
type SkillShape = 'file' | 'folder';

type ScannedSpace = Awaited<ReturnType<typeof scanSpaces>>[number];

interface FallbackSpace {
  name: string;
  path: string;
  absolutePath: string;
  type: SpaceType;
  isSymlink: boolean;
  sourcePath?: string;
  sharing?: string;
  description?: string;
  displayName?: string;
}

type ResolvedSpace = ScannedSpace | FallbackSpace;

const SKILL_FILE_SKIP_NAMES = new Set(['README.md', 'index.md', 'SKILLS-MENU.md']);

export interface SharedSkillTarget {
  absolutePath: string;
  relativePath: string;
  sharing: NonPrivateSharing;
  spaceName: string;
  spacePath: string;
  spaceAbsolutePath: string;
  spaceType?: SpaceType;
  shape: SkillShape;
}

export interface SharedSkillWriteConflict {
  conflict: true;
  currentHash: string;
  path: string;
}

export interface SharedSkillWriteSuccess {
  conflict?: false;
  currentHash: string;
  path: string;
  updatedAt: number;
  content: string;
  target: SharedSkillTarget;
}

export type SharedSkillWriteResult = SharedSkillWriteSuccess | SharedSkillWriteConflict;

export interface SharedSkillActor {
  kind: 'human' | 'agent';
  user: CurrentUserSnapshot | null;
}

export interface SharedSkillRestoreLineage {
  restoredFromVersionId: string;
  restoredFromSkillPath: string;
}

export interface SharedSkillWriteContext {
  restoreLineage?: SharedSkillRestoreLineage;
  /**
   * SHA-256 hex of file content the client last read. When set, the write is rejected
   * if the on-disk content hash differs (stale editor / external edit).
   */
  baseContentHash?: string;
}

export interface SharedSkillProtectionContext {
  target: SharedSkillTarget;
  authorLabel: string;
  skillName: string;
  approvalIdentifier: string;
}

export interface ManagedSharedSkillWriteEvent {
  target: SharedSkillTarget;
  previousContent: string | null;
  nextContent: string;
  actor: SharedSkillActor;
  context?: SharedSkillWriteContext;
}

interface PreparedSharedSkillMutation {
  target: SharedSkillTarget;
  content: string;
  previousContent: string | null;
}

interface PendingManagedWrite {
  target: SharedSkillTarget;
  previousContent: string | null;
  nextContentHash: string;
  actor: SharedSkillActor;
  context?: SharedSkillWriteContext;
}

type ManagedSharedSkillWriteObserver = (event: ManagedSharedSkillWriteEvent) => Promise<void>;

const SKILL_FRONTMATTER_ORDER = [
  'description',
  'use_cases',
  'last_updated',
  'tools_required',
  'agent_type',
  'dependencies',
  'extends',
  'extension_type',
  'author',
  'author_id',
  'author_email',
  'contributed',
  'contributors',
  'last_modified_by',
  'last_modified_by_id',
  'last_modified_by_email',
  'last_responsible_human_by',
  'last_responsible_human_id',
  'last_responsible_human_email',
  'last_modified_at',
  'last_modified_context',
  'coach_type',
  'proactive_interval_minutes',
] as const;

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
}

function normalizeEmail(value?: string): string | null {
  const trimmed = value?.trim().toLowerCase();
  return trimmed || null;
}

function normalizeSharing(value: string | undefined): 'private' | NonPrivateSharing | undefined {
  if (value === 'team') return 'restricted';
  if (value === 'private' || value === 'restricted' || value === 'company-wide' || value === 'public') {
    return value;
  }
  return undefined;
}

function matchPathToSpace(filePath: string, spaces: ResolvedSpace[], coreDirectory: string): ResolvedSpace | null {
  const normalized = normalizePath(path.isAbsolute(filePath) ? filePath : path.resolve(coreDirectory, filePath)).toLowerCase();
  const coreNormalized = normalizePath(coreDirectory).toLowerCase();

  let bestMatch: ResolvedSpace | null = null;
  let bestMatchLength = 0;

  for (const space of spaces) {
    const relativeSpacePath = normalizePath(space.path).toLowerCase();
    const absoluteSpacePath = normalizePath(space.absolutePath).toLowerCase();

    if (normalized === relativeSpacePath || normalized.startsWith(`${relativeSpacePath}/`)) {
      if (relativeSpacePath.length > bestMatchLength) {
        bestMatch = space;
        bestMatchLength = relativeSpacePath.length;
      }
    }

    if (normalized === absoluteSpacePath || normalized.startsWith(`${absoluteSpacePath}/`)) {
      if (absoluteSpacePath.length > bestMatchLength) {
        bestMatch = space;
        bestMatchLength = absoluteSpacePath.length;
      }
    }

    const corePrefixedPath = `${coreNormalized}/${relativeSpacePath}`;
    if (normalized === corePrefixedPath || normalized.startsWith(`${corePrefixedPath}/`)) {
      if (corePrefixedPath.length > bestMatchLength) {
        bestMatch = space;
        bestMatchLength = corePrefixedPath.length;
      }
    }

    if ('sourcePath' in space && typeof space.sourcePath === 'string' && space.sourcePath) {
      const resolvedSourcePath = path.isAbsolute(space.sourcePath)
        ? space.sourcePath
        : path.resolve(space.absolutePath, '..', space.sourcePath);
      const normalizedSourcePath = normalizePath(resolvedSourcePath).toLowerCase();

      if (normalized === normalizedSourcePath || normalized.startsWith(`${normalizedSourcePath}/`)) {
        if (normalizedSourcePath.length > bestMatchLength) {
          bestMatch = space;
          bestMatchLength = normalizedSourcePath.length;
        }
      }
    }
  }

  return bestMatch;
}

function getSpacePath(space: ResolvedSpace, coreDirectory: string): string {
  return path.relative(coreDirectory, space.absolutePath).split(path.sep).join('/');
}

function isPathInsideBase(filePath: string, basePath: string): boolean {
  const relativePath = path.relative(basePath, filePath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function resolveCandidateSpaceBases(space: ResolvedSpace, coreDirectory: string): string[] {
  const candidates = new Set<string>();
  candidates.add(path.resolve(space.absolutePath));
  candidates.add(path.resolve(coreDirectory, space.path));

  if ('sourcePath' in space && typeof space.sourcePath === 'string' && space.sourcePath) {
    candidates.add(path.isAbsolute(space.sourcePath)
      ? path.resolve(space.sourcePath)
      : path.resolve(space.absolutePath, '..', space.sourcePath));
  }

  return Array.from(candidates);
}

function deriveRelativePathFromSpace(
  filePath: string,
  space: ResolvedSpace,
  coreDirectory: string,
): { relativeInsideSpace: string; workspaceRelativePath: string; absoluteSpaceBase: string } | null {
  const absoluteFilePath = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(coreDirectory, filePath);
  const matchingBase = resolveCandidateSpaceBases(space, coreDirectory)
    .filter((basePath) => isPathInsideBase(absoluteFilePath, basePath))
    .sort((left, right) => right.length - left.length)[0];

  if (!matchingBase) {
    return null;
  }

  const relativeInsideSpace = path.relative(matchingBase, absoluteFilePath).split(path.sep).join('/');
  const workspaceRelativePath = path.posix.join(space.path.replace(/\\/g, '/'), relativeInsideSpace);

  return {
    relativeInsideSpace,
    workspaceRelativePath,
    absoluteSpaceBase: matchingBase,
  };
}

function getFallbackSpaces(coreDirectory: string): FallbackSpace[] {
  const settings = getSettings();
  return (settings.spaces ?? []).map((space) => ({
    name: space.name,
    displayName: space.name,
    path: space.path.replace(/\\/g, '/'),
    absolutePath: path.join(coreDirectory, space.path),
    type: space.type,
    isSymlink: space.isSymlink,
    sourcePath: space.sourcePath,
    sharing: space.sharing,
    description: space.description,
  }));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveSkillShape(
  relativeInsideSpace: string,
  absolutePath: string,
  absoluteSpaceBase: string,
): Promise<SkillShape | null> {
  const normalized = relativeInsideSpace.replace(/\\/g, '/');
  if (!normalized.toLowerCase().startsWith('skills/')) {
    return null;
  }

  if (normalized.includes('/.rebel/') || normalized.startsWith('.rebel/')) {
    return null;
  }

  const skillsRelative = normalized.slice('skills/'.length);
  if (!skillsRelative) {
    return null;
  }

  const parts = skillsRelative.split('/').filter(Boolean);
  if (parts.length === 0 || parts.includes('examples')) {
    return null;
  }

  const baseName = parts[parts.length - 1];
  if (baseName === 'SKILL.md') {
    return 'folder';
  }

  if (!baseName.toLowerCase().endsWith('.md') || SKILL_FILE_SKIP_NAMES.has(baseName)) {
    return null;
  }

  // File-based skills can live at the root of `skills/` or in nested categories,
  // but not inside a folder-based skill's support files.
  const skillsRootDir = path.join(absoluteSpaceBase, 'skills');
  const directoryParts = parts.slice(0, -1);
  for (let index = directoryParts.length; index > 0; index -= 1) {
    const ancestorSkillPath = path.join(skillsRootDir, ...directoryParts.slice(0, index), 'SKILL.md');
    if (normalizePath(ancestorSkillPath) === normalizePath(absolutePath)) {
      continue;
    }
    if (await fileExists(ancestorSkillPath)) {
      return null;
    }
  }

  return 'file';
}

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function yamlScalar(value: string | number | boolean | null): string {
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (value.includes('\n')) {
    return `|\n${value.split('\n').map((line) => `  ${line}`).join('\n')}`;
  }

  if (value === '') {
    return '""';
  }

  return JSON.stringify(value);
}

function serializeYamlValue(key: string, value: unknown): string[] {
  if (value === undefined) {
    return [];
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return [`${key}: []`];
    }

    return [
      `${key}:`,
      ...value.map((item) => {
        if (item === null || typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
          return `  - ${yamlScalar(item)}`;
        }
        return `  - ${JSON.stringify(item)}`;
      }),
    ];
  }

  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const serialized = yamlScalar(value);
    if (serialized.startsWith('|\n')) {
      return [`${key}: ${serialized}`];
    }
    return [`${key}: ${serialized}`];
  }

  return [`${key}: ${JSON.stringify(value)}`];
}

function serializeFrontmatter(attributes: Record<string, unknown>, body: string): string {
  const orderedKeys = [
    ...SKILL_FRONTMATTER_ORDER.filter((key) => key in attributes),
    ...Object.keys(attributes).filter((key) => !SKILL_FRONTMATTER_ORDER.includes(key as typeof SKILL_FRONTMATTER_ORDER[number])),
  ];

  const lines = ['---'];
  for (const key of orderedKeys) {
    lines.push(...serializeYamlValue(key, attributes[key]));
  }
  lines.push('---', '');
  return `${lines.join('\n')}${body}`;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

function getFirstName(value: string | undefined): string | null {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return null;
  }

  if (normalized.toLowerCase() === 'rebel') {
    return 'Rebel';
  }

  return normalized.split(/\s+/)[0] ?? normalized;
}

function getEmailFallback(value: string | undefined): string | null {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (!normalized) {
    return null;
  }

  return normalized.split('@')[0] ?? normalized;
}

function getActorLabel(attributes: Record<string, unknown>, prefix: 'author' | 'last_modified_by'): string | null {
  if (prefix === 'last_modified_by' && normalizeOptionalString(attributes.last_modified_by_id) === 'rebel') {
    return 'Rebel';
  }

  return getFirstName(normalizeOptionalString(attributes[prefix]))
    ?? getEmailFallback(normalizeOptionalString(attributes[`${prefix}_email`]))
    ?? null;
}

function setIfMissing(attributes: Record<string, unknown>, key: string, value: string | undefined): void {
  if (!value) {
    return;
  }
  if (typeof attributes[key] !== 'string' || String(attributes[key]).trim().length === 0) {
    attributes[key] = value;
  }
}

function setOptionalAttribute(
  attributes: Record<string, unknown>,
  key: string,
  value: string | null | undefined,
): void {
  if (value) {
    attributes[key] = value;
  } else {
    delete attributes[key];
  }
}

function setResponsibleHumanIdentity(
  attributes: Record<string, unknown>,
  user: CurrentUserSnapshot | null,
): void {
  const name = normalizeOptionalString(user?.name);
  const id = normalizeOptionalString(user?.id);
  const email = normalizeEmail(normalizeOptionalString(user?.email));

  // `last_responsible_human_*` drives notification routing, so treat it as one
  // coherent identity. A human write with incomplete identity must fail closed
  // rather than preserving stale id/email from a previous editor.
  if (id && email) {
    setOptionalAttribute(attributes, 'last_responsible_human_by', name);
    attributes.last_responsible_human_id = id;
    attributes.last_responsible_human_email = email;
    return;
  }

  delete attributes.last_responsible_human_by;
  delete attributes.last_responsible_human_id;
  delete attributes.last_responsible_human_email;
}

/** Cap to keep frontmatter bounded on long-lived shared skills */
const MAX_CONTRIBUTOR_IDS = 50;

function addContributor(attributes: Record<string, unknown>, userId: string | undefined): void {
  if (!userId) {
    return;
  }

  const contributors = normalizeStringArray(attributes.contributors);
  if (!contributors.includes(userId)) {
    contributors.push(userId);
  }
  if (contributors.length > MAX_CONTRIBUTOR_IDS) {
    attributes.contributors = contributors.slice(-MAX_CONTRIBUTOR_IDS);
  } else {
    attributes.contributors = contributors;
  }
}

function buildLastModifiedContext(userName: string | undefined): string | undefined {
  return userName ? `from ${userName}'s input` : undefined;
}

async function readCurrentFileContent(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

class SharedSkillMutationService {
  private readonly trackedHashes = new Map<string, string>();
  private readonly pendingWrites = new Map<string, PendingManagedWrite>();
  private readonly writeObservers = new Set<ManagedSharedSkillWriteObserver>();
  /** Serialize all mutations per canonical skill key (Library + agent prepare/record). */
  private readonly lockTails = new Map<string, Promise<unknown>>();
  /** Keys currently inside observer dispatch — prevents re-entrant writes from deadlocking. */
  private readonly observerDispatchKeys = new Set<string>();

  private async withSkillWriteLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.lockTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.lockTails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private getTrackedHashKey(target: Pick<SharedSkillTarget, 'relativePath'>): string {
    return normalizePath(target.relativePath).toLowerCase();
  }

  private getProtectionApprovalIdentifier(target: Pick<SharedSkillTarget, 'relativePath'>): string {
    return `shared-skill:${this.getTrackedHashKey(target)}`;
  }

  private getSkillName(target: SharedSkillTarget): string {
    const normalizedPath = target.relativePath.replace(/\\/g, '/');
    const fileName = path.posix.basename(normalizedPath);

    if (target.shape === 'folder' && fileName === 'SKILL.md') {
      return path.posix.basename(path.posix.dirname(normalizedPath));
    }

    return fileName.replace(/\.md$/i, '');
  }

  addManagedWriteObserver(observer: ManagedSharedSkillWriteObserver): () => void {
    this.writeObservers.add(observer);
    return () => {
      this.writeObservers.delete(observer);
    };
  }

  private async notifyManagedWriteObservers(event: ManagedSharedSkillWriteEvent): Promise<void> {
    const key = this.getTrackedHashKey(event.target);
    if (this.observerDispatchKeys.has(key)) {
      log.warn(
        { skillPath: event.target.relativePath },
        'Blocked re-entrant observer dispatch for the same skill — this would deadlock the per-skill write lock',
      );
      return;
    }
    this.observerDispatchKeys.add(key);
    try {
      for (const observer of this.writeObservers) {
        try {
          await observer(event);
        } catch (error) {
          log.warn(
            {
              err: error,
              skillPath: event.target.relativePath,
              actorKind: event.actor.kind,
            },
            'Managed shared-skill observer failed after the primary write already succeeded',
          );
          getErrorReporter().captureException(error, {
            context: 'sharedSkillMutation.observerFailure',
            skillPath: event.target.relativePath,
            actorKind: event.actor.kind,
          });
        }
      }
    } finally {
      this.observerDispatchKeys.delete(key);
    }
  }

  private getTrackedConflict(
    target: SharedSkillTarget,
    currentContent: string | null,
  ): SharedSkillWriteConflict | null {
    const currentHash = currentContent === null ? 'new-file' : sha256(currentContent);
    const trackedHash = this.trackedHashes.get(this.getTrackedHashKey(target));

    if (trackedHash && trackedHash !== currentHash) {
      return {
        conflict: true,
        currentHash,
        path: target.absolutePath,
      };
    }

    return null;
  }

  async classifySharedSkillPath(filePath: string, coreDirectory: string): Promise<SharedSkillTarget | null> {
    // Read-only: path classification must not mutate frontmatter.
    // See docs/plans/260411_shared_space_maintenance.md Stage 3 Refinement.
    const scannedSpaces = await scanSpaces(coreDirectory, { skipAutoFix: true });
    const mergedSpaces = new Map<string, ResolvedSpace>();

    for (const space of scannedSpaces) {
      mergedSpaces.set(normalizePath(space.path).toLowerCase(), space);
    }

    for (const fallbackSpace of getFallbackSpaces(coreDirectory)) {
      const key = normalizePath(fallbackSpace.path).toLowerCase();
      if (!mergedSpaces.has(key)) {
        mergedSpaces.set(key, fallbackSpace);
      }
    }

    const matchedSpace = matchPathToSpace(filePath, Array.from(mergedSpaces.values()), coreDirectory);
    if (!matchedSpace) {
      return null;
    }

    const spaceRelativePath = deriveRelativePathFromSpace(filePath, matchedSpace, coreDirectory);
    if (!spaceRelativePath) {
      return null;
    }

    const shape = await resolveSkillShape(
      spaceRelativePath.relativeInsideSpace,
      path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(coreDirectory, filePath),
      spaceRelativePath.absoluteSpaceBase,
    );
    if (!shape) {
      return null;
    }

    if (matchedSpace.type === 'chief-of-staff') {
      return null;
    }

    let sharing = normalizeSharing('sharing' in matchedSpace ? matchedSpace.sharing : undefined);
    if (!sharing) {
      try {
        const frontmatter = await readSpaceReadmeFrontmatter(matchedSpace.absolutePath);
        sharing = normalizeSharing(frontmatter?.sharing ?? ('sharing' in matchedSpace ? matchedSpace.sharing : undefined));
      } catch (error) {
        log.debug({ err: error, filePath, spacePath: matchedSpace.path }, 'Fell back to space metadata when shared-skill classifier could not read README frontmatter');
      }
    }

    if (!sharing || sharing === 'private') {
      return null;
    }

    return {
      absolutePath: path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(coreDirectory, filePath),
      relativePath: spaceRelativePath.workspaceRelativePath,
      sharing,
      spaceName: getSpaceDisplayName(matchedSpace as ScannedSpace),
      spacePath: getSpacePath(matchedSpace, coreDirectory),
      spaceAbsolutePath: spaceRelativePath.absoluteSpaceBase,
      spaceType: matchedSpace.type,
      shape,
    };
  }

  async getNonAuthorSharedSkillProtectionContext(
    filePath: string,
    coreDirectory: string,
    currentUser: CurrentUserSnapshot | null,
  ): Promise<SharedSkillProtectionContext | null> {
    if (!currentUser) {
      return null;
    }

    const target = await this.classifySharedSkillPath(filePath, coreDirectory);
    if (!target) {
      return null;
    }

    const currentContent = await readCurrentFileContent(target.absolutePath);
    if (currentContent === null) {
      return null;
    }

    const parsed = fm<Record<string, unknown>>(currentContent);
    const authorId = normalizeOptionalString(parsed.attributes.author_id);
    const authorEmail = normalizeEmail(normalizeOptionalString(parsed.attributes.author_email));
    const lastModifiedById = normalizeOptionalString(parsed.attributes.last_modified_by_id);

    if (
      authorId === currentUser.id
      || authorEmail === normalizeEmail(normalizeOptionalString(currentUser.email))
      || lastModifiedById === currentUser.id
    ) {
      return null;
    }

    const authorLabel = getActorLabel(parsed.attributes, 'author');
    const lastModifiedLabel = getActorLabel(parsed.attributes, 'last_modified_by');
    const ownerLabel = authorLabel ?? lastModifiedLabel;
    if (!ownerLabel || ownerLabel === 'You') {
      return null;
    }

    return {
      target,
      authorLabel: ownerLabel,
      skillName: this.getSkillName(target),
      approvalIdentifier: this.getProtectionApprovalIdentifier(target),
    };
  }

  private applyCollaborationMetadata(
    content: string,
    actor: SharedSkillActor,
    options?: { shouldAssignAuthor: boolean },
  ): string {
    const parsed = fm<Record<string, unknown>>(content);
    const attributes = { ...parsed.attributes };

    if (typeof attributes.description !== 'string') {
      attributes.description = '';
    }

    if (options?.shouldAssignAuthor) {
      setIfMissing(attributes, 'author', normalizeOptionalString(actor.user?.name));
      setIfMissing(attributes, 'author_id', normalizeOptionalString(actor.user?.id));
      setIfMissing(attributes, 'author_email', normalizeEmail(normalizeOptionalString(actor.user?.email)) ?? undefined);
      setIfMissing(attributes, 'author_source', 'created');
    }

    if (actor.kind === 'human') {
      setOptionalAttribute(
        attributes,
        'last_modified_by',
        normalizeOptionalString(actor.user?.name),
      );
      setOptionalAttribute(
        attributes,
        'last_modified_by_id',
        normalizeOptionalString(actor.user?.id),
      );
      setOptionalAttribute(
        attributes,
        'last_modified_by_email',
        normalizeEmail(normalizeOptionalString(actor.user?.email)),
      );
      setResponsibleHumanIdentity(attributes, actor.user);
      delete attributes.last_modified_context;
      addContributor(attributes, normalizeOptionalString(actor.user?.id));
    } else {
      attributes.last_modified_by = 'Rebel';
      attributes.last_modified_by_id = 'rebel';
      delete attributes.last_modified_by_email;

      const lastModifiedContext = buildLastModifiedContext(normalizeOptionalString(actor.user?.name));
      if (lastModifiedContext) {
        attributes.last_modified_context = lastModifiedContext;
      } else {
        delete attributes.last_modified_context;
      }

      setResponsibleHumanIdentity(attributes, actor.user);

      addContributor(attributes, normalizeOptionalString(actor.user?.id));
    }

    attributes.last_modified_at = new Date().toISOString().slice(0, 10);

    return serializeFrontmatter(attributes, parsed.body);
  }

  private async prepareManagedMutation(
    filePath: string,
    content: string,
    coreDirectory: string,
    actor: SharedSkillActor,
  ): Promise<PreparedSharedSkillMutation | null> {
    const target = await this.classifySharedSkillPath(filePath, coreDirectory);
    if (!target) {
      return null;
    }

    const previousContent = await readCurrentFileContent(target.absolutePath);

    return {
      target,
      content: this.applyCollaborationMetadata(content, actor, {
        shouldAssignAuthor: previousContent === null,
      }),
      previousContent,
    };
  }

  private buildEditReplacementInput(toolInput: Record<string, unknown>, currentContent: string, finalContent: string): Record<string, unknown> {
    const updatedInput = { ...toolInput };

    if ('old_string' in updatedInput || 'new_string' in updatedInput) {
      updatedInput.old_string = currentContent;
      updatedInput.new_string = finalContent;
    }

    if ('old_str' in updatedInput || 'new_str' in updatedInput) {
      updatedInput.old_str = currentContent;
      updatedInput.new_str = finalContent;
    }

    if (!('old_string' in updatedInput) && !('old_str' in updatedInput)) {
      updatedInput.old_string = currentContent;
      updatedInput.new_string = finalContent;
    }

    return updatedInput;
  }

  async prepareManagedToolInput(
    toolName: string,
    toolInput: Record<string, unknown>,
    coreDirectory: string,
    actor: SharedSkillActor,
    options?: { suppressRegistration?: boolean },
  ): Promise<{ updatedInput: Record<string, unknown>; target: SharedSkillTarget } | { denyReason: string } | null> {
    const filePath = typeof toolInput.file_path === 'string'
      ? toolInput.file_path
      : typeof toolInput.path === 'string'
        ? toolInput.path
        : typeof toolInput.filePath === 'string'
          ? toolInput.filePath
          : null;

    if (!filePath) {
      return null;
    }

    const target = await this.classifySharedSkillPath(filePath, coreDirectory);
    if (!target) {
      return null;
    }

    if (actor.kind === 'human' && !actor.user) {
      return {
        denyReason:
          'Shared skill writes require a signed-in user so collaboration metadata and notifications stay trustworthy.',
      };
    }

    return this.withSkillWriteLock(this.getTrackedHashKey(target), async () => {
    const currentContent = await readCurrentFileContent(target.absolutePath);
    const conflict = this.getTrackedConflict(target, currentContent);
    if (conflict) {
      log.info(
        { skillPath: target.relativePath },
        'Auto-resolved tracked hash drift for agent tool edit — the agent reads current content so stale-write risk does not apply',
      );
      this.trackedHashes.set(this.getTrackedHashKey(target), conflict.currentHash);
    }

    if (toolName === 'Create' || toolName === 'Write' || toolName === 'write_file') {
      if (typeof toolInput.content !== 'string') {
        return {
          denyReason: 'Shared skill write was blocked because the tool input did not contain writable file content.',
        };
      }

      const managedContent = this.applyCollaborationMetadata(toolInput.content, actor, {
        shouldAssignAuthor: currentContent === null,
      });
      if (!options?.suppressRegistration) {
        this.pendingWrites.set(this.getTrackedHashKey(target), {
          target,
          previousContent: currentContent,
          nextContentHash: sha256(managedContent),
          actor,
        });
      }

      return {
        target,
        updatedInput: {
          ...toolInput,
          content: managedContent,
        },
      };
    }

    if (toolName === 'Edit' || toolName === 'str_replace_editor') {
      if (currentContent === null) {
        return {
          denyReason: `Shared skill edit was blocked because "${target.relativePath}" does not exist yet. Write the full file instead.`,
        };
      }

      const replacementContent = typeof toolInput.new_string === 'string'
        ? toolInput.new_string
        : typeof toolInput.new_str === 'string'
          ? toolInput.new_str
          : typeof toolInput.insert === 'string'
            ? toolInput.insert
          : null;

      if (replacementContent === null) {
        return {
          denyReason: 'Shared skill edit was blocked because the Edit tool payload did not include replacement content.',
        };
      }

      const oldString = typeof toolInput.old_string === 'string'
        ? toolInput.old_string
        : typeof toolInput.old_str === 'string'
          ? toolInput.old_str
          : null;

      if (oldString === null) {
        return {
          denyReason: 'Shared skill edit was blocked because the Edit tool payload did not include the original text to replace.',
        };
      }

      const replaceAll = toolInput.change_all === true;
      const firstIndex = currentContent.indexOf(oldString);
      const secondIndex = firstIndex === -1 ? -1 : currentContent.indexOf(oldString, firstIndex + oldString.length);
      if (firstIndex === -1 || (!replaceAll && secondIndex !== -1)) {
        return {
          denyReason: `Shared skill edit was blocked because the requested edit could not be normalized safely for "${target.relativePath}". Re-read the file and write the full updated contents instead.`,
        };
      }

      const rawNextContent = replaceAll
        ? currentContent.split(oldString).join(replacementContent)
        : `${currentContent.slice(0, firstIndex)}${replacementContent}${currentContent.slice(firstIndex + oldString.length)}`;
      const managedContent = this.applyCollaborationMetadata(rawNextContent, actor, {
        shouldAssignAuthor: false,
      });
      if (!options?.suppressRegistration) {
        this.pendingWrites.set(this.getTrackedHashKey(target), {
          target,
          previousContent: currentContent,
          nextContentHash: sha256(managedContent),
          actor,
        });
      }

      const updatedInput = this.buildEditReplacementInput(toolInput, currentContent, managedContent);
      if (toolName === 'str_replace_editor') {
        updatedInput.old_str = currentContent;
        updatedInput.new_str = managedContent;
        delete updatedInput.insert;
      }

      return {
        target,
        updatedInput,
      };
    }

    return {
      denyReason: `Shared skill writes via ${toolName} are not supported yet. Use the standard file write tools so Rebel can preserve collaboration metadata.`,
    };
    });
  }

  async writeManagedSkillFile(
    filePath: string,
    content: string,
    coreDirectory: string,
    actor: SharedSkillActor,
    context?: SharedSkillWriteContext,
  ): Promise<SharedSkillWriteResult | null> {
    const classified = await this.classifySharedSkillPath(filePath, coreDirectory);
    if (!classified) {
      return null;
    }

    return this.withSkillWriteLock(this.getTrackedHashKey(classified), async () => {
    const prepared = await this.prepareManagedMutation(filePath, content, coreDirectory, actor);
    if (!prepared) {
      return null;
    }

    if (prepared.previousContent !== null && context?.baseContentHash) {
      const diskHash = sha256(prepared.previousContent);
      if (diskHash !== context.baseContentHash) {
        return {
          conflict: true,
          currentHash: diskHash,
          path: prepared.target.absolutePath,
        };
      }
    }

    const conflict = this.getTrackedConflict(prepared.target, prepared.previousContent);
    if (conflict) {
      return conflict;
    }

    await fs.mkdir(path.dirname(prepared.target.absolutePath), { recursive: true });
    await fs.writeFile(prepared.target.absolutePath, prepared.content, 'utf8');
    const stat = await fs.stat(prepared.target.absolutePath);
    const finalHash = sha256(prepared.content);
    this.trackedHashes.set(this.getTrackedHashKey(prepared.target), finalHash);
    await this.notifyManagedWriteObservers({
      target: prepared.target,
      previousContent: prepared.previousContent,
      nextContent: prepared.content,
      actor,
      context,
    });

    return {
      conflict: false,
      currentHash: finalHash,
      path: prepared.target.absolutePath,
      updatedAt: stat.mtimeMs,
      content: prepared.content,
      target: prepared.target,
    };
    });
  }

  async recordSuccessfulManagedWrite(filePath: string, content: string, coreDirectory: string): Promise<void> {
    const target = await this.classifySharedSkillPath(filePath, coreDirectory);
    if (!target) {
      return;
    }

    const trackedKey = this.getTrackedHashKey(target);
    await this.withSkillWriteLock(trackedKey, async () => {
    this.trackedHashes.set(trackedKey, sha256(content));

    const pendingWrite = this.pendingWrites.get(trackedKey);
    if (!pendingWrite) {
      log.warn({ filePath: target.absolutePath }, 'No pending managed write found for shared-skill write — snapshot will use inferred context');
      await this.notifyManagedWriteObservers({
        target,
        previousContent: null,
        nextContent: content,
        actor: { kind: 'agent', user: getCurrentUserProvider().getCurrentUser() },
      });
      return;
    }

    this.pendingWrites.delete(trackedKey);
    const contentHash = sha256(content);
    if (pendingWrite.nextContentHash !== contentHash) {
      log.warn(
        { filePath: target.absolutePath, expectedHash: pendingWrite.nextContentHash.slice(0, 8), actualHash: contentHash.slice(0, 8) },
        'Content hash mismatch on shared-skill write — creating snapshot with actual disk content',
      );
    }

    await this.notifyManagedWriteObservers({
      target,
      previousContent: pendingWrite.previousContent,
      nextContent: content,
      actor: pendingWrite.actor,
      context: pendingWrite.context,
    });
    });
  }

  async clearPendingManagedWrite(filePath: string, coreDirectory: string): Promise<void> {
    const target = await this.classifySharedSkillPath(filePath, coreDirectory);
    if (!target) {
      return;
    }
    await this.withSkillWriteLock(this.getTrackedHashKey(target), async () => {
    this.pendingWrites.delete(this.getTrackedHashKey(target));
    });
  }

  clearTrackedHashes(): void {
    this.trackedHashes.clear();
    this.pendingWrites.clear();
  }

  extractManagedContentFromToolInput(toolName: string, toolInput: Record<string, unknown>): string | null {
    if (toolName === 'Create' || toolName === 'Write' || toolName === 'write_file') {
      return typeof toolInput.content === 'string' ? toolInput.content : null;
    }

    if (toolName === 'Edit' || toolName === 'str_replace_editor') {
      if (typeof toolInput.new_string === 'string') return toolInput.new_string;
      if (typeof toolInput.new_str === 'string') return toolInput.new_str;
      if (typeof toolInput.insert === 'string') return toolInput.insert;
    }

    return null;
  }
}

export const sharedSkillMutationService = new SharedSkillMutationService();
