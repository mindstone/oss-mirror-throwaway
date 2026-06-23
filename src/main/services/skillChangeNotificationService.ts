import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import fm from "front-matter";
import { createScopedLogger } from "@core/logger";
import { getBroadcastService } from "@core/broadcastService";
import {
  fileLocationFromSkillTarget,
  FileLocationSchema,
  type FileLocation,
} from "@rebel/shared";
import {
  sharedSkillMutationService,
  type ManagedSharedSkillWriteEvent,
  type SharedSkillTarget,
} from "./sharedSkillMutationService";
import { getCurrentUserProvider, type CurrentUserSnapshot } from "@core/currentUserProvider";
import { getSettings } from "@core/services/settingsStore";
import { scanSpaces } from "./spaceService";
import { getOrGenerateAnonymousId, trackMainEvent } from "../analytics";
import { writeFileAtomic } from "../utils/atomicFs";
import { hashSessionId } from "@shared/trackingTypes";

const log = createScopedLogger({ service: "skillChangeNotifications" });

const SKILL_NOTIFICATION_DIR = [
  ".rebel",
  "history",
  "skill-notifications",
] as const;
const NOTIFICATION_PRUNE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const NOTIFICATION_PRUNE_DEBOUNCE_MS = 60 * 60 * 1000; // 1 hour
// Only explicit authorship claims qualify for creator_fallback notifications.
// 'migrated' is excluded — it's an inferred mapping from attribution repair,
// not a confirmed claim of authorship, and produces false-positive notifications.
const NOTIFICATION_ELIGIBLE_AUTHOR_SOURCES = new Set(["created", "confirmed"]);
const notificationLocationProjectionDebugged = new Map<string, boolean>();

type RecipientReason = "previous_editor" | "creator_fallback";

interface SkillChangeNotificationRecord {
  rebelSkillNotification: 1;
  id: string;
  skillName: string;
  skillWorkspacePath: string;
  spacePath: string;
  location?: FileLocation;
  recipientUserId: string | null;
  recipientEmail: string | null;
  recipientReason: RecipientReason;
  actorLabel: string;
  actorKind: "human" | "agent";
  createdAt: number;
  updatedAt: number;
  dismissedAt?: number;
}

export interface SkillChangeNotification {
  id: string;
  skillName: string;
  skillWorkspacePath: string;
  spacePath: string;
  /**
   * Optional to match `SkillChangeNotificationSchema` in
   * `src/shared/ipc/channels/library.ts` (Stage 5A tolerant schema). Becomes
   * required in Stage 5B alongside the schema tightening. Consumers MUST
   * apply `legacyMissingLocation(...)` when undefined — see Invariant #4.
   */
  location?: FileLocation;
  actorLabel: string;
  actorKind: "human" | "agent";
  recipientReason: RecipientReason;
  createdAt: number;
  updatedAt: number;
}

interface RecipientCandidate {
  userId: string | null;
  email: string | null;
  reason: RecipientReason;
}

interface NotificationRecordMatch {
  record: SkillChangeNotificationRecord;
  filePath: string;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function normalizeEmail(value: unknown): string | null {
  const normalized = normalizeString(value);
  return normalized ? normalized.toLowerCase() : null;
}

function normalizeSkillWorkspacePath(value: string): string {
  return normalizePath(value);
}

function matchesRecipient(
  record: { recipientUserId: string | null; recipientEmail: string | null },
  candidate: { userId: string | null; email: string | null },
): boolean {
  // Prefer stable user id when the record has one. This prevents stale
  // mixed-identity records like `{ recipientUserId: "bob", recipientEmail:
  // "alice@example.com" }` from matching both humans via OR semantics.
  if (record.recipientUserId && candidate.userId) {
    return record.recipientUserId === candidate.userId;
  }

  if (record.recipientEmail && candidate.email) {
    return record.recipientEmail === candidate.email;
  }

  return false;
}

function isRecipientOfNotification(
  record: SkillChangeNotificationRecord,
  user: CurrentUserSnapshot,
): boolean {
  return matchesRecipient(record, {
    userId: user.id,
    email: normalizeEmail(user.email),
  });
}

function isNotificationEligibleAuthorSource(value: unknown): boolean {
  const normalized = normalizeString(value);
  return normalized != null && NOTIFICATION_ELIGIBLE_AUTHOR_SOURCES.has(normalized);
}

function sameHuman(
  candidate: { userId: string | null; email: string | null },
  user: Pick<CurrentUserSnapshot, "id" | "email">,
): boolean {
  const currentUserId = normalizeString(user.id);
  const currentEmail = normalizeEmail(user.email);
  return (
    (!!currentUserId && candidate.userId === currentUserId) ||
    (!!candidate.email && !!currentEmail && candidate.email === currentEmail)
  );
}

function getNotificationsDir(spaceAbsolutePath: string): string {
  return path.join(spaceAbsolutePath, ...SKILL_NOTIFICATION_DIR);
}

function getNotificationAbsolutePath(
  spaceAbsolutePath: string,
  id: string,
): string {
  return path.join(getNotificationsDir(spaceAbsolutePath), `${id}.json`);
}

function parseFrontmatter(content: string): Record<string, unknown> {
  try {
    return fm<Record<string, unknown>>(content).attributes ?? {};
  } catch (err) {
    // Malformed frontmatter silently becoming "no attributes" can hide a
    // corrupt notification file — surface it before the empty fallback.
    log.warn({ err }, 'Failed to parse skill-notification frontmatter — treating as empty attributes');
    return {};
  }
}

function humanizeSkillSlug(slug: string): string {
  return slug
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function deriveSkillSlug(skillId: string): string {
  const normalized = normalizePath(skillId);
  const fileName = path.posix.basename(normalized);
  if (fileName.toLowerCase() === "skill.md") {
    return path.posix.basename(path.posix.dirname(normalized));
  }
  return fileName.replace(/\.md$/i, "");
}

function deriveSkillTitle(attributes: Record<string, unknown>, skillSlug: string): string {
  return (
    normalizeString(attributes.title) ??
    normalizeString(attributes.name) ??
    normalizeString(attributes.skill_name) ??
    humanizeSkillSlug(skillSlug)
  );
}

function trackSkillModifiedEvent(event: ManagedSharedSkillWriteEvent): void {
  if (event.context?.restoreLineage) {
    return;
  }
  const attributes = parseFrontmatter(event.nextContent);
  const skillId = normalizePath(event.target.relativePath);
  const skillSlug = deriveSkillSlug(skillId);
  const skillTitle = deriveSkillTitle(attributes, skillSlug);
  const creatorId = event.actor.user?.id ?? (event.actor.kind === "agent" ? "rebel" : null);
  const creatorEmail = normalizeEmail(event.actor.user?.email);
  const creatorName = normalizeString(event.actor.user?.name);
  if (!event.previousContent) {
    trackMainEvent({
      anonymousId: getOrGenerateAnonymousId(),
      ...(event.actor.user?.id ? { userId: event.actor.user.id } : {}),
      event: "Skill Created",
      properties: {
        skillId,
        skillPath: skillId,
        skillSlug,
        skillTitle,
        skillScope: "shared",
        source: "shared_skill_write",
        actorKind: event.actor.kind,
        actor_kind: event.actor.kind,
        creatorId,
        creator_id: creatorId,
        creatorUserId: event.actor.user?.id ?? null,
        creator_user_id: event.actor.user?.id ?? null,
        creatorName,
        creator_name: creatorName,
        creatorEmail,
        creator_email: creatorEmail,
        user_id: event.actor.user?.id ?? null,
        user_email: creatorEmail,
        email: creatorEmail,
      },
    });
    trackMainEvent({
      anonymousId: getOrGenerateAnonymousId(),
      ...(event.actor.user?.id ? { userId: event.actor.user.id } : {}),
      event: "Work Artifact Created",
      properties: {
        artifactType: "skill",
        source: "shared_skill_write",
        shared: true,
        skillId,
        skillPath: skillId,
        skillSlug,
        skillTitle,
        fileExtension: path.extname(skillId).toLowerCase(),
        actorKind: event.actor.kind,
        creatorId,
        creatorEmail,
      },
    });
    trackMainEvent({
      anonymousId: getOrGenerateAnonymousId(),
      ...(event.actor.user?.id ? { userId: event.actor.user.id } : {}),
      event: "Work Output Created",
      properties: {
        output_id: hashSessionId(skillId),
        output_type: "skill",
        output_format: "skill",
        source_surface: "shared_skill_write",
        shared: true,
        skillId,
        skillPath: skillId,
        skillSlug,
        skillTitle,
        actorKind: event.actor.kind,
        creatorId,
        creatorEmail,
      },
    });
  }
  trackMainEvent({
    anonymousId: getOrGenerateAnonymousId(),
    ...(event.actor.user?.id ? { userId: event.actor.user.id } : {}),
    event: "skill_modified",
    properties: {
      skill_id: skillId,
      skill_slug: skillSlug,
      skill_title: skillTitle,
      author_id: normalizeString(attributes.author_id),
      modified_by:
        event.actor.user?.id ?? (event.actor.kind === "agent" ? "rebel" : null),
      modified_by_email: creatorEmail,
      is_agent: event.actor.kind === "agent",
      space_id: normalizePath(event.target.spacePath),
    },
  });
}

function normalizeNotificationSharing(value: unknown): "restricted" | "company-wide" | "public" {
  return value === "company-wide" || value === "public" ? value : "restricted";
}

function deriveSkillShape(skillWorkspacePath: string): "file" | "folder" {
  return normalizePath(skillWorkspacePath).endsWith("/SKILL.md") ? "folder" : "file";
}

function buildSkillTargetFromRecord(
  space: Awaited<ReturnType<typeof scanSpaces>>[number],
  currentSpacePath: string,
  currentSkillWorkspacePath: string,
): SharedSkillTarget {
  const normalizedSkillPath = normalizePath(currentSkillWorkspacePath);
  const normalizedSpacePath = normalizePath(currentSpacePath);
  const spaceRelativePath = normalizedSkillPath.startsWith(`${normalizedSpacePath}/`)
    ? normalizedSkillPath.slice(normalizedSpacePath.length + 1)
    : normalizedSkillPath;

  return {
    absolutePath: path.join(space.absolutePath, spaceRelativePath),
    relativePath: normalizedSkillPath,
    sharing: normalizeNotificationSharing(space.sharing),
    spaceName: space.name,
    spacePath: normalizedSpacePath,
    spaceAbsolutePath: space.absolutePath,
    spaceType: space.type,
    shape: deriveSkillShape(normalizedSkillPath),
  };
}

function projectNotificationLocation(
  record: SkillChangeNotificationRecord,
  space: Awaited<ReturnType<typeof scanSpaces>>[number],
  currentSpacePath: string,
  currentSkillWorkspacePath: string,
): FileLocation | undefined {
  const parsedLocation = record.location
    ? FileLocationSchema.safeParse(record.location)
    : null;

  if (record.location && parsedLocation && !parsedLocation.success) {
    log.warn(
      { id: record.id, skillWorkspacePath: record.skillWorkspacePath },
      "Invalid persisted skill notification location; reprojecting from record fields",
    );
  }

  const storedLocation = parsedLocation?.success &&
    parsedLocation.data.kind !== "legacy-missing-location"
    ? parsedLocation.data
    : null;

  const recomputedLocation = fileLocationFromSkillTarget(
    buildSkillTargetFromRecord(
      space,
      currentSpacePath,
      currentSkillWorkspacePath,
    ),
  );

  if (recomputedLocation.kind === "legacy-missing-location") {
    return storedLocation ?? undefined;
  }

  if (
    storedLocation &&
    JSON.stringify(storedLocation) !== JSON.stringify(recomputedLocation)
  ) {
    const key = `projection-mismatch:${record.id}`;
    if (!notificationLocationProjectionDebugged.get(key)) {
      notificationLocationProjectionDebugged.set(key, true);
      log.debug(
        {
          id: record.id,
          storedLocation,
          recomputedLocation,
          skillWorkspacePath: record.skillWorkspacePath,
        },
        "Stored skill notification FileLocation disagreed with recomputed projection; using recomputed value",
      );
    }
  }

  return recomputedLocation;
}

function buildActorLabel(event: ManagedSharedSkillWriteEvent): string {
  if (event.actor.kind === "agent") {
    return "Rebel";
  }
  return (
    event.actor.user?.name?.trim() ||
    normalizeEmail(event.actor.user?.email)?.split("@")[0] ||
    "Someone"
  );
}

function resolveRecipientCandidate(
  previousContent: string,
  currentResponsibleHuman: Pick<CurrentUserSnapshot, "id" | "email">,
): RecipientCandidate | null {
  const attributes = parseFrontmatter(previousContent);

  // Resolve previous editor as an atomic (id, email) pair from a single trusted
  // source. Mixing sources produced Frankenstein identities — e.g. userId from
  // `last_responsible_human_id` paired with email from the legacy
  // `last_modified_by_email` fallback — which caused notifications to route to
  // unrelated users via the OR-based `matchesRecipient` check at read time.
  //
  // `last_responsible_human_*` is only written by the managed mutation
  // pipeline in `sharedSkillMutationService.applyCollaborationMetadata`, so its
  // presence is first-party evidence of a real edit. Legacy `last_modified_by_*`
  // may carry inherited or migrated metadata with no trust grounding (the same
  // reason we already gate `creator_fallback` to trusted `author_source`); we
  // no longer fall back to it.
  const previousEditor = {
    userId: normalizeString(attributes.last_responsible_human_id),
    email: normalizeEmail(attributes.last_responsible_human_email),
  };

  if (
    (previousEditor.userId || previousEditor.email) &&
    !sameHuman(previousEditor, currentResponsibleHuman)
  ) {
    return {
      userId: previousEditor.userId,
      email: previousEditor.email,
      reason: "previous_editor",
    };
  }

  const author = {
    userId: normalizeString(attributes.author_id),
    email: normalizeEmail(attributes.author_email),
  };

  if (
    isNotificationEligibleAuthorSource(attributes.author_source) &&
    (author.userId || author.email) &&
    !sameHuman(author, currentResponsibleHuman)
  ) {
    return {
      userId: author.userId,
      email: author.email,
      reason: "creator_fallback",
    };
  }

  return null;
}

async function readNotificationRecord(
  filePath: string,
): Promise<SkillChangeNotificationRecord | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as SkillChangeNotificationRecord;
    if (parsed.rebelSkillNotification !== 1 || typeof parsed.id !== "string") {
      return null;
    }
    return parsed;
  } catch (error) {
    log.warn(
      { err: error, filePath },
      "Failed to read skill notification record",
    );
    return null;
  }
}

async function listNotificationFiles(
  spaceAbsolutePath: string,
): Promise<string[]> {
  try {
    return (await fs.readdir(getNotificationsDir(spaceAbsolutePath)))
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(getNotificationsDir(spaceAbsolutePath), name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function collectNotificationMatches(
  roots: string[],
): Promise<NotificationRecordMatch[]> {
  const matches: NotificationRecordMatch[] = [];
  const seenPaths = new Set<string>();

  for (const root of roots) {
    const files = await listNotificationFiles(root);
    for (const filePath of files) {
      const normalizedPath = path.resolve(filePath);
      if (seenPaths.has(normalizedPath)) {
        continue;
      }

      seenPaths.add(normalizedPath);
      const record = await readNotificationRecord(filePath);
      if (!record) {
        continue;
      }

      matches.push({ record, filePath });
    }
  }

  return matches;
}

function resolveNotificationRoots(
  space: Awaited<ReturnType<typeof scanSpaces>>[number],
  _coreDirectory: string | null,
): string[] {
  const roots = new Set<string>([path.resolve(space.absolutePath)]);
  if (space.sourcePath) {
    roots.add(
      path.resolve(
        path.isAbsolute(space.sourcePath)
          ? space.sourcePath
          : path.resolve(space.absolutePath, "..", space.sourcePath),
      ),
    );
  }
  return Array.from(roots);
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const payload = JSON.stringify(data, null, 2);
  await writeFileAtomic(filePath, payload);
}

class SkillChangeNotificationService {
  private observerAttached = false;
  private readonly notificationLockTails = new Map<string, Promise<unknown>>();
  private lastPruneTimestamp = 0;

  private async withSpaceNotificationLock<T>(
    spaceRoot: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const key = spaceRoot.startsWith("space:")
      ? spaceRoot
      : path.resolve(spaceRoot);
    const previous = this.notificationLockTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.notificationLockTails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async resolveNotificationRootsForTarget(
    target: SharedSkillTarget,
    coreDirectory: string | null,
  ): Promise<string[]> {
    if (!coreDirectory) {
      return [path.resolve(target.spaceAbsolutePath)];
    }

    const spaces = await scanSpaces(coreDirectory, { skipAutoFix: true });
    const matchingSpace = spaces.find(
      (space) =>
        normalizePath(space.path) === normalizePath(target.spacePath) ||
        path.resolve(space.absolutePath) ===
          path.resolve(target.spaceAbsolutePath),
    );

    if (matchingSpace) {
      return resolveNotificationRoots(matchingSpace, coreDirectory);
    }

    return Array.from(
      new Set([
        path.resolve(target.spaceAbsolutePath),
        path.resolve(coreDirectory, target.spacePath),
      ]),
    );
  }

  attachManagedWriteObserver(): void {
    if (this.observerAttached) {
      return;
    }
    this.observerAttached = true;
    sharedSkillMutationService.addManagedWriteObserver((event) =>
      this.onManagedSharedSkillWrite(event),
    );
  }

  private async onManagedSharedSkillWrite(
    event: ManagedSharedSkillWriteEvent,
  ): Promise<void> {
    trackSkillModifiedEvent(event);

    if (!event.actor.user) {
      return;
    }

    if (!event.previousContent) {
      return;
    }

    const recipient = resolveRecipientCandidate(
      event.previousContent,
      event.actor.user,
    );
    if (!recipient) {
      return;
    }

    const settings = getSettings();
    await this.withSpaceNotificationLock(
      `space:${normalizePath(event.target.spacePath)}`,
      async () => {
        const location = fileLocationFromSkillTarget(event.target);
        if (location.kind === "legacy-missing-location") {
          log.error(
            { target: event.target },
            "Refusing to persist skill change notification with legacy-missing-location variant — fails Invariant #14",
          );
          return;
        }

        const notificationsDir = getNotificationsDir(
          event.target.spaceAbsolutePath,
        );
        await fs.mkdir(notificationsDir, { recursive: true });

        const existingMatch = await this.findActiveNotificationForSkill(
          event.target,
          recipient,
          settings.coreDirectory,
        );
        const now = Date.now();
        const normalizedSkillPath = normalizePath(event.target.relativePath);
        const skillFileName = path.posix.basename(normalizedSkillPath);
        const skillName =
          event.target.shape === "folder" && skillFileName === "SKILL.md"
            ? path.posix.basename(path.posix.dirname(normalizedSkillPath))
            : skillFileName.replace(/\.md$/i, "");
        const record: SkillChangeNotificationRecord = existingMatch
          ? {
              ...existingMatch.record,
              location,
              // Refresh recipient identity from the freshly resolved candidate
              // so that any stale record written before the atomic-pair fix
              // (pre-FOX-3052 build) is healed on the next managed write. Keeps
              // `recipientUserId`/`recipientEmail` coherent with a single source.
              recipientUserId: recipient.userId,
              recipientEmail: recipient.email,
              recipientReason: recipient.reason,
              actorLabel: buildActorLabel(event),
              actorKind: event.actor.kind,
              updatedAt: now,
            }
          : {
              rebelSkillNotification: 1,
              id: randomUUID(),
              skillName,
              skillWorkspacePath: normalizePath(event.target.relativePath),
              spacePath: normalizePath(event.target.spacePath),
              location,
              recipientUserId: recipient.userId,
              recipientEmail: recipient.email,
              recipientReason: recipient.reason,
              actorLabel: buildActorLabel(event),
              actorKind: event.actor.kind,
              createdAt: now,
              updatedAt: now,
            };

        const writePath =
          existingMatch?.filePath ??
          getNotificationAbsolutePath(
            event.target.spaceAbsolutePath,
            record.id,
          );
        await writeJsonAtomic(writePath, record);

        getBroadcastService().sendToAllWindows("skill-notifications:changed", {
          timestamp: now,
        });
      },
    );
  }

  private async findActiveNotificationForSkill(
    target: SharedSkillTarget,
    recipient: { userId: string | null; email: string | null },
    coreDirectory: string | null,
  ): Promise<{
    record: SkillChangeNotificationRecord;
    filePath: string;
  } | null> {
    const matches = await collectNotificationMatches(
      await this.resolveNotificationRootsForTarget(target, coreDirectory),
    );
    const activeMatches = matches
      .filter(({ record }) => !record.dismissedAt)
      .filter(({ record }) => matchesRecipient(record, recipient))
      .filter(
        ({ record }) =>
          normalizeSkillWorkspacePath(record.skillWorkspacePath) ===
          normalizeSkillWorkspacePath(target.relativePath),
      )
      .sort((left, right) => right.record.updatedAt - left.record.updatedAt);

    if (activeMatches.length > 0) {
      return activeMatches[0] ?? null;
    }

    return null;
  }

  private async pruneOldDismissedNotifications(): Promise<void> {
    const now = Date.now();
    if (now - this.lastPruneTimestamp < NOTIFICATION_PRUNE_DEBOUNCE_MS) {
      return;
    }
    this.lastPruneTimestamp = now;

    const settings = getSettings();
    if (!settings.coreDirectory) {
      return;
    }
    const spaces = await scanSpaces(settings.coreDirectory, {
      skipAutoFix: true,
    });
    const cutoff = now - NOTIFICATION_PRUNE_THRESHOLD_MS;
    let pruned = 0;

    for (const space of spaces) {
      for (const root of resolveNotificationRoots(
        space,
        settings.coreDirectory,
      )) {
        const files = await listNotificationFiles(root);
        for (const filePath of files) {
          const record = await readNotificationRecord(filePath);
          if (
            !record ||
            typeof record.dismissedAt !== "number" ||
            record.dismissedAt > cutoff
          ) {
            continue;
          }
          try {
            await fs.unlink(filePath);
            pruned += 1;
          } catch (error) {
            log.warn(
              { err: error, filePath },
              "Failed to prune old notification",
            );
          }
        }
      }
    }

    if (pruned > 0) {
      log.info({ pruned }, "Pruned old dismissed skill change notifications");
    }
  }

  async listNotifications(): Promise<SkillChangeNotification[]> {
    const currentUser = getCurrentUserProvider().getCurrentUser();
    if (!currentUser) {
      return [];
    }

    const settings = getSettings();
    if (!settings.coreDirectory) {
      return [];
    }
    const spaces = await scanSpaces(settings.coreDirectory, {
      skipAutoFix: true,
    });
    const notificationsByKey = new Map<string, SkillChangeNotification>();
    const skillExistsCache = new Map<string, boolean>();

    for (const space of spaces) {
      const roots = resolveNotificationRoots(space, settings.coreDirectory);
      const matches = await collectNotificationMatches(roots);
      for (const { record, filePath } of matches) {
        if (record.dismissedAt) {
          continue;
        }

        if (!isRecipientOfNotification(record, currentUser)) {
          continue;
        }

        // Reconstruct paths using current space path instead of stale record path
        const currentSpacePath = normalizePath(space.path);
        const storedSpacePath = normalizePath(record.spacePath);
        const storedSkillPath = normalizeSkillWorkspacePath(
          record.skillWorkspacePath,
        );
        let currentSkillWorkspacePath = storedSkillPath;
        if (storedSkillPath.startsWith(storedSpacePath + "/")) {
          const relativePart = storedSkillPath.slice(
            storedSpacePath.length + 1,
          );
          currentSkillWorkspacePath = currentSpacePath + "/" + relativePart;
        }

        // Check if skill file still exists on disk (orphan detection)
        const spaceRelativePath = currentSkillWorkspacePath.startsWith(
          currentSpacePath + "/",
        )
          ? currentSkillWorkspacePath.slice(currentSpacePath.length + 1)
          : null;

        if (spaceRelativePath) {
          if (!skillExistsCache.has(currentSkillWorkspacePath)) {
            let exists = false;
            for (const root of roots) {
              try {
                await fs.access(path.join(root, spaceRelativePath));
                exists = true;
                break;
              } catch (err) {
                if (
                  (err as NodeJS.ErrnoException).code !== "ENOENT"
                ) {
                  exists = true; // Non-ENOENT: assume file exists (fail closed)
                  break;
                }
              }
            }
            skillExistsCache.set(currentSkillWorkspacePath, exists);
          }

          if (skillExistsCache.get(currentSkillWorkspacePath) === false) {
            // Auto-dismiss orphaned notification
            let autoDismissed = false;
            try {
              await this.withSpaceNotificationLock(
                `space:${currentSpacePath}`,
                async () => {
                  // Re-check existence inside the lock to prevent race with onManagedSharedSkillWrite
                  let stillMissing = true;
                  for (const root of roots) {
                    try {
                      await fs.access(path.join(root, spaceRelativePath as string));
                      stillMissing = false;
                      break;
                    } catch {
                      // continue checking other roots
                    }
                  }
                  if (!stillMissing) {
                    skillExistsCache.set(currentSkillWorkspacePath, true);
                    return;
                  }
                  const freshRecord =
                    await readNotificationRecord(filePath);
                  if (freshRecord && !freshRecord.dismissedAt) {
                    await writeJsonAtomic(filePath, {
                      ...freshRecord,
                      dismissedAt: Date.now(),
                      updatedAt: Date.now(),
                    });
                  }
                  autoDismissed = true;
                },
              );
            } catch (err) {
              log.warn(
                { err, filePath },
                "Failed to auto-dismiss orphaned notification",
              );
            }
            if (autoDismissed) {
              continue; // Only skip if auto-dismiss succeeded
            }
          }
        }

        // Use reconstructed path for dedup key
        const currentLogicalKey = normalizeSkillWorkspacePath(
          currentSkillWorkspacePath,
        );

        const existing = notificationsByKey.get(currentLogicalKey);
        if (existing && existing.updatedAt >= record.updatedAt) {
          continue;
        }

        const location = projectNotificationLocation(
          record,
          space,
          currentSpacePath,
          currentSkillWorkspacePath,
        );

        const notificationBase = {
          id: record.id,
          skillName: record.skillName,
          skillWorkspacePath: currentSkillWorkspacePath,
          spacePath: currentSpacePath,
          actorLabel: record.actorLabel,
          actorKind: record.actorKind,
          recipientReason: record.recipientReason,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        };

        notificationsByKey.set(
          currentLogicalKey,
          location
            ? { ...notificationBase, location }
            : notificationBase,
        );
      }
    }

    const notifications = Array.from(notificationsByKey.values());
    notifications.sort((left, right) => right.updatedAt - left.updatedAt);
    return notifications;
  }

  async dismissNotification(id: string, spacePath?: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return false;
    }

    const settings = getSettings();
    const currentUser = getCurrentUserProvider().getCurrentUser();
    if (!currentUser || !settings.coreDirectory) {
      return false;
    }

    const spaces = await scanSpaces(settings.coreDirectory, {
      skipAutoFix: true,
    });

    // Fast path: try the hinted spacePath first
    let matchingSpace = spacePath
      ? spaces.find(
          (space) => normalizePath(space.path) === normalizePath(spacePath),
        )
      : undefined;

    // Fallback: scan ALL spaces to find the notification by ID
    if (!matchingSpace) {
      for (const space of spaces) {
        const roots = resolveNotificationRoots(space, settings.coreDirectory);
        const matches = await collectNotificationMatches(roots);
        if (matches.some(({ record }) => record.id === id)) {
          matchingSpace = space;
          break;
        }
      }
    }

    if (!matchingSpace) {
      return false;
    }

    return this.withSpaceNotificationLock(
      `space:${normalizePath(matchingSpace.path)}`,
      async () => {
        const matches = await collectNotificationMatches(
          resolveNotificationRoots(matchingSpace, settings.coreDirectory),
        );
        const clicked = matches.find(
          ({ record }) => record.id === id && !record.dismissedAt,
        );
        if (!clicked) {
          return false;
        }

        if (
          !matchesRecipient(clicked.record, {
            userId: currentUser.id,
            email: normalizeEmail(currentUser.email),
          })
        ) {
          return false;
        }

        const skillPath = normalizeSkillWorkspacePath(
          clicked.record.skillWorkspacePath,
        );
        const siblings = matches.filter(
          ({ record }) =>
            !record.dismissedAt &&
            normalizeSkillWorkspacePath(record.skillWorkspacePath) ===
              skillPath &&
            matchesRecipient(record, {
              userId: currentUser.id,
              email: normalizeEmail(currentUser.email),
            }),
        );

        if (siblings.length === 0) {
          return false;
        }

        const now = Date.now();
        await Promise.all(
          siblings.map(async ({ record, filePath }) => {
            const nextRecord: SkillChangeNotificationRecord = {
              ...record,
              dismissedAt: now,
              updatedAt: now,
            };
            await writeJsonAtomic(filePath, nextRecord);
          }),
        );

        getBroadcastService().sendToAllWindows("skill-notifications:changed", {
          timestamp: now,
        });
        void this.pruneOldDismissedNotifications().catch((err) => {
          log.warn({ err }, "Notification pruning failed");
        });
        return true;
      },
    );
  }
}

export const skillChangeNotificationService =
  new SkillChangeNotificationService();
