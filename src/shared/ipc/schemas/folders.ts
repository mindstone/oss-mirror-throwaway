import { z } from 'zod';

/**
 * Conversation folder schema — user-created grouping for sidebar organization.
 * Folders are a UI concern; they don't affect agent execution or session content.
 */
export const ConversationFolderSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(100),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ConversationFolder = z.infer<typeof ConversationFolderSchema>;

/**
 * Complete folder store state — definitions + session membership map.
 * Persisted as `folders.json` in `userData/sessions/`.
 *
 * Membership is `Record<sessionId, folderId>` — a session belongs to at most one folder.
 * This is stored externally (not on AgentSession) to avoid touching the 55+ file
 * session type chain and eliminating INDEX_VERSION rebuild for all users.
 */
export const FolderStoreDataSchema = z.object({
  version: z.literal(1),
  folders: z.array(ConversationFolderSchema),
  membership: z.record(z.string(), z.string()),
});
export type FolderStoreData = z.infer<typeof FolderStoreDataSchema>;

/**
 * Empty/default folder document. Used by the cloud-service folders route as the
 * GET default (no doc stored) and by restore as the "trivial local" baseline.
 */
export const EMPTY_FOLDER_STORE_DATA: FolderStoreData = {
  version: 1,
  folders: [],
  membership: {},
};

/**
 * ONE shared parse helper for the folders cloud wire contract — consumed by
 * BOTH the desktop client (restore path) and the cloud-service route. The wire
 * contract IS `FolderStoreDataSchema` directly (Amendment A2 — no v2 DTO).
 *
 * Returns `null` on any parse failure. Per A2, the caller treats a `null`
 * result as a NO-OP: a 404, malformed body, or future/unknown version all
 * collapse to "no valid folders doc" → never clobber local. This single
 * definition is the contract's source of truth.
 */
export function parseFolderStoreData(value: unknown): FolderStoreData | null {
  const result = FolderStoreDataSchema.safeParse(value);
  return result.success ? result.data : null;
}
