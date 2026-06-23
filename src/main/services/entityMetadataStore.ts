/**
 * Entity Metadata Store
 *
 * Indexes entity frontmatter from markdown files.
 * Enables structured queries like "people at Acme" and entity resolution by email/name.
 */

import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import fm from 'front-matter';
import { z } from 'zod';
import { createScopedLogger } from '@core/logger';
import { getAllMeetingEntries, type MeetingHistoryEntry } from './meetingHistoryStore';

const log = createScopedLogger({ service: 'entityMetadata' });

const ENTITY_METADATA_STORE_VERSION = 1;

const PersonEntityFrontmatterSchema = z.object({
  entity_type: z.literal('person'),
  canonical_name: z.string().trim().min(1),
  emails: z.array(z.string().trim().min(1)).optional(),
  company: z.string().trim().min(1).optional(),
  role: z.string().trim().min(1).optional(),
  aliases: z.array(z.string().trim().min(1)).optional(),
});

const CompanyEntityFrontmatterSchema = z.object({
  entity_type: z.literal('company'),
  canonical_name: z.string().trim().min(1),
  domain: z.string().trim().min(1).optional(),
  aliases: z.array(z.string().trim().min(1)).optional(),
});

export const EntityFrontmatterSchema = z.discriminatedUnion('entity_type', [
  PersonEntityFrontmatterSchema,
  CompanyEntityFrontmatterSchema,
]);

export type EntityFrontmatter = z.infer<typeof EntityFrontmatterSchema>;
export type EntityType = EntityFrontmatter['entity_type'];

export interface EntityMetadataEntry {
  filePath: string;
  relativePath: string;
  entityType: EntityType;
  canonicalName: string;
  emails: string[];
  company?: string;
  role?: string;
  domain?: string;
  aliases: string[];
  spacePath: string;
  indexedAt: number;
  mtime: number;
}

type EntityMetadataStoreShape = {
  version: number;
  workspacePath: string | null;
  entries: Record<string, EntityMetadataEntry>;
}

const createDefaultState = (): EntityMetadataStoreShape => ({
  version: ENTITY_METADATA_STORE_VERSION,
  workspacePath: null,
  entries: {},
});

let _store: KeyValueStore<EntityMetadataStoreShape> | null = null;
const getStore = () => _store ??= createStore<EntityMetadataStoreShape>({
  name: 'entity-metadata',
  defaults: createDefaultState(),
});

const normalizeEmails = (emails: string[]): string[] => {
  const deduped = new Set<string>();
  for (const email of emails) {
    const normalized = email.trim().toLowerCase();
    if (normalized) {
      deduped.add(normalized);
    }
  }
  return [...deduped];
};

const normalizeAliases = (aliases: string[] | undefined): string[] => {
  if (!aliases) return [];

  const dedupedByLower = new Map<string, string>();
  for (const alias of aliases) {
    const normalized = alias.trim();
    if (normalized && !dedupedByLower.has(normalized.toLowerCase())) {
      dedupedByLower.set(normalized.toLowerCase(), normalized);
    }
  }
  return [...dedupedByLower.values()];
};

const extractSpacePath = (relativePath: string): string => {
  const segments = relativePath.split(/[/\\]/);
  const memoryIndex = segments.indexOf('memory');

  if (memoryIndex === -1) {
    return '';
  }

  if (memoryIndex === 0) {
    return 'memory';
  }

  return segments.slice(0, memoryIndex).join('/');
};

function matchesParticipant(participant: string, query: string): boolean {
  const pLower = participant.toLowerCase();
  const qLower = query.toLowerCase();

  if (pLower.includes(qLower)) {
    return true;
  }

  const emailMatch = pLower.match(/^([^@]+)@/);
  if (emailMatch) {
    const localPart = emailMatch[1];
    if (localPart.startsWith(qLower) || localPart.split('.')[0] === qLower) {
      return true;
    }
  }

  return false;
}

const parseEntityFrontmatter = (content: string): EntityFrontmatter | null => {
  try {
    if (!fm.test(content)) {
      return null;
    }

    const parsed = fm<Record<string, unknown>>(content);
    const result = EntityFrontmatterSchema.safeParse(parsed.attributes);
    if (!result.success) {
      return null;
    }

    return result.data;
  } catch {
    return null;
  }
};

export function initForWorkspace(workspacePath: string): void {
  const storedVersion = getStore().get('version');
  const storedWorkspace = getStore().get('workspacePath');

  if (storedVersion !== ENTITY_METADATA_STORE_VERSION) {
    log.info({ storedVersion, currentVersion: ENTITY_METADATA_STORE_VERSION }, 'Version mismatch, clearing store');
    getStore().set('version', ENTITY_METADATA_STORE_VERSION);
    getStore().set('entries', {});
  }

  if (storedWorkspace !== workspacePath) {
    log.info({ oldWorkspace: storedWorkspace, newWorkspace: workspacePath }, 'Workspace changed, clearing store');
    getStore().set('workspacePath', workspacePath);
    getStore().set('entries', {});
  }
}

export function isEmpty(): boolean {
  const entries = getStore().get('entries');
  return !entries || Object.keys(entries).length === 0;
}

/**
 * Content-based entity detection.
 * Fast path checks first 2KB for entity_type marker before full parse.
 */
export function isEntityFile(content: string): boolean {
  if (!content.substring(0, 2048).includes('entity_type:')) {
    return false;
  }

  return parseEntityFrontmatter(content) !== null;
}

export function indexEntity(
  filePath: string,
  relativePath: string,
  content: string,
  mtime: number
): void {
  try {
    const frontmatter = parseEntityFrontmatter(content);
    if (!frontmatter) {
      return;
    }

    const entry: EntityMetadataEntry = {
      filePath,
      relativePath,
      entityType: frontmatter.entity_type,
      canonicalName: frontmatter.canonical_name,
      emails: frontmatter.entity_type === 'person' ? normalizeEmails(frontmatter.emails ?? []) : [],
      company: frontmatter.entity_type === 'person' ? frontmatter.company : undefined,
      role: frontmatter.entity_type === 'person' ? frontmatter.role : undefined,
      domain: frontmatter.entity_type === 'company' ? frontmatter.domain : undefined,
      aliases: normalizeAliases(frontmatter.aliases),
      spacePath: extractSpacePath(relativePath),
      indexedAt: Date.now(),
      mtime,
    };

    const entries = getStore().get('entries') || {};
    entries[filePath] = entry;
    getStore().set('entries', entries);

    log.debug({ filePath, entityType: entry.entityType, emailCount: entry.emails.length }, 'Indexed entity');
  } catch (error) {
    log.warn({ err: error, filePath }, 'Failed to index entity');
  }
}

export function removeEntity(filePath: string): void {
  try {
    const entries = getStore().get('entries') || {};
    if (entries[filePath]) {
      delete entries[filePath];
      getStore().set('entries', entries);
      log.debug({ filePath }, 'Removed entity from index');
    }
  } catch (error) {
    log.warn({ err: error, filePath }, 'Failed to remove entity');
  }
}

export function getEntity(filePath: string): EntityMetadataEntry | undefined {
  const entries = getStore().get('entries') || {};
  return entries[filePath];
}

export function getAllEntities(): EntityMetadataEntry[] {
  const entries = getStore().get('entries') || {};
  return Object.values(entries);
}

export function getEntityCount(): number {
  const entries = getStore().get('entries') || {};
  return Object.keys(entries).length;
}

export function needsReindexing(filePath: string, mtime: number): boolean {
  const existing = getEntity(filePath);
  if (!existing) return true;
  return existing.mtime < mtime;
}

export function clearStore(): void {
  getStore().set('entries', {});
  log.info('Cleared entity metadata store');
}

/**
 * Derive the last interaction date for a person by email.
 * Queries meetingHistoryStore for the most recent meeting where `participantEmails`
 * includes the given email.
 *
 * **Limitation:** meetingHistoryStore only retains ~30 days / 500 entries,
 * so interactions older than that window are not discoverable.
 *
 * @returns ISO date string of the most recent meeting's startTime, or undefined
 */
export function deriveLastInteraction(email: string): string | undefined {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return undefined;

  let entries: MeetingHistoryEntry[];
  try {
    entries = getAllMeetingEntries();
  } catch {
    // meetingHistoryStore may not be initialized yet
    return undefined;
  }

  const now = Date.now();
  let latestTime = 0;
  let latestStartTime: string | undefined;

  for (const entry of entries) {
    if (!entry.participantEmails || entry.participantEmails.length === 0) continue;
    if (!entry.participantEmails.some((pe) => pe.toLowerCase() === normalized)) continue;

    const meetingTime = new Date(entry.startTime).getTime();
    // Only count past meetings as interactions, not future/upcoming ones
    if (Number.isNaN(meetingTime) || meetingTime > now) continue;
    if (meetingTime > latestTime) {
      latestTime = meetingTime;
      latestStartTime = entry.startTime;
    }
  }

  return latestStartTime;
}

/**
 * Build a map of email → most recent past meeting startTime (ISO string) for all meeting entries.
 * Called once per search invocation to avoid O(entities x meetings) per-entity scans.
 * Future/upcoming meetings are excluded — only actual past interactions count.
 */
function buildEmailLastInteractionMap(): Map<string, string> {
  const map = new Map<string, string>();

  let entries: MeetingHistoryEntry[];
  try {
    entries = getAllMeetingEntries();
  } catch {
    return map;
  }

  const now = Date.now();
  for (const entry of entries) {
    if (!entry.participantEmails || entry.participantEmails.length === 0) continue;
    const meetingTime = new Date(entry.startTime).getTime();
    // Only count past meetings as interactions
    if (Number.isNaN(meetingTime) || meetingTime > now) continue;

    for (const email of entry.participantEmails) {
      const normalized = email.toLowerCase();
      const existing = map.get(normalized);
      if (!existing || new Date(existing).getTime() < meetingTime) {
        map.set(normalized, entry.startTime);
      }
    }
  }

  return map;
}

export interface SearchEntitiesParams {
  name?: string;
  email?: string;
  company?: string;
  entityType?: EntityType;
  /** ISO date string — filter to entities whose last meeting interaction is before this date. Only applies to person entities. */
  noInteractionSince?: string;
  limit?: number;
}

export interface SearchEntitiesResult {
  entities: EntityMetadataEntry[];
  totalCount: number;
}

export function searchEntities(params: SearchEntitiesParams): SearchEntitiesResult {
  const { limit = 20 } = params;
  let candidates = getAllEntities();

  if (params.entityType) {
    candidates = candidates.filter((entry) => entry.entityType === params.entityType);
  }

  if (params.name) {
    const nameQuery = params.name;
    candidates = candidates.filter((entry) => {
      if (matchesParticipant(entry.canonicalName, nameQuery)) {
        return true;
      }

      return entry.aliases.some((alias) => matchesParticipant(alias, nameQuery));
    });
  }

  if (params.email) {
    const emailQuery = params.email;
    candidates = candidates.filter((entry) =>
      entry.emails.some((email) => matchesParticipant(email, emailQuery))
    );
  }

  if (params.company) {
    const companyQuery = params.company;
    candidates = candidates.filter((entry) => {
      if (entry.entityType === 'person') {
        return entry.company ? matchesParticipant(entry.company, companyQuery) : false;
      }

      if (matchesParticipant(entry.canonicalName, companyQuery)) {
        return true;
      }

      return entry.aliases.some((alias) => matchesParticipant(alias, companyQuery));
    });
  }

  if (params.noInteractionSince) {
    const cutoffMs = new Date(params.noInteractionSince).getTime();
    if (!Number.isNaN(cutoffMs)) {
      const emailLastInteractionMap = buildEmailLastInteractionMap();

      candidates = candidates.filter((entry) => {
        // Only applies to person entities — companies don't have meetings
        if (entry.entityType !== 'person') return false;
        // Person has no emails → no meeting match possible → include
        if (entry.emails.length === 0) return true;

        // Check the most recent meeting across all of this person's emails
        let latestInteraction = 0;
        for (const email of entry.emails) {
          const lastMeeting = emailLastInteractionMap.get(email);
          if (lastMeeting) {
            const meetingMs = new Date(lastMeeting).getTime();
            if (meetingMs > latestInteraction) {
              latestInteraction = meetingMs;
            }
          }
        }

        // No meeting found for any email → include (never interacted in known history)
        if (latestInteraction === 0) return true;
        // Last interaction is before the cutoff → include
        return latestInteraction < cutoffMs;
      });
    }
  }

  const sorted = candidates.sort((a, b) => a.canonicalName.localeCompare(b.canonicalName));

  return {
    entities: sorted.slice(0, limit),
    totalCount: sorted.length,
  };
}

export function resolveByEmail(email: string): EntityMetadataEntry | undefined {
  const normalized = email.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  const matches = getAllEntities().filter((entry) =>
    entry.emails.some((entryEmail) => entryEmail === normalized)
  );

  if (matches.length === 0) {
    return undefined;
  }

  return matches.sort((a, b) => b.indexedAt - a.indexedAt)[0];
}

export function resolveByName(name: string): EntityMetadataEntry | undefined {
  const normalized = name.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  const entities = getAllEntities();

  const canonicalExact = entities.find((entry) => entry.canonicalName.toLowerCase() === normalized);
  if (canonicalExact) {
    return canonicalExact;
  }

  const aliasExact = entities.find((entry) =>
    entry.aliases.some((alias) => alias.toLowerCase() === normalized)
  );
  if (aliasExact) {
    return aliasExact;
  }

  return entities.find((entry) => {
    if (matchesParticipant(entry.canonicalName, normalized)) {
      return true;
    }
    return entry.aliases.some((alias) => matchesParticipant(alias, normalized));
  });
}
