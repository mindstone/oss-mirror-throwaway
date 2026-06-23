import type { AgentSessionSidebarEntry } from '../types';
import type { ConversationFolder } from '@shared/ipc/schemas/folders';

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export type SidebarListEntry =
  | { type: 'session'; id: string; entry: AgentSessionSidebarEntry; isMutedDone?: boolean }
  | {
      type: 'folder-header';
      id: string;
      folder: ConversationFolder;
      childCount: number;
      isCollapsed: boolean;
    }
  | {
      type: 'done-subheader';
      id: string;
      folderId: string;
      folderName: string;
      doneCount: number;
      isCollapsed: boolean;
    };

// ---------------------------------------------------------------------------
// Pure transform
// ---------------------------------------------------------------------------

/**
 * Transforms a flat, pre-filtered list of sidebar entries into a folder-aware
 * sequence suitable for virtualised rendering.
 *
 * Output order:
 *   1. Starred unfiled sessions
 *   2. Folders (sorted by `createdAt` asc) — each as a header, its active
 *      children, then (if any) a collapsed-by-default `Done (N)` subsection
 *      listing that folder's done conversations.
 *   3. Non-starred unfiled sessions (original order)
 *
 * Empty folders are preserved (header with `childCount: 0`).
 *
 * Auto-expand: if `revealSessionId` is inside a collapsed folder, that folder
 * is forced open in the output. If the revealed session is a *done* child, the
 * folder's done subsection is also forced open (one-shot — never persisted).
 *
 * `childCount` on the folder-header is always active-only.
 */
export interface BuildFolderAwareListOptions {
  /** Per-folder collapse state (folderId → collapsed?). Absent → expanded. */
  collapseState?: Record<string, boolean>;
  /** Per-folder Done(N) subsection collapse state. Absent → collapsed. */
  doneCollapseState?: Record<string, boolean>;
  /** One-shot: force-open the folder (and its Done subsection if the revealed session is done) containing this id. Never persisted. */
  revealSessionId?: string | null;
  /** Full non-deleted session list; done children are sourced from here even when filteredEntries is pre-filtered to Active. Defaults to filteredEntries. */
  allEntries?: AgentSessionSidebarEntry[];
  /** Active tab only: emit the inline "Done (N)" subsection. Other tabs MUST leave false. */
  includeDoneSubsection?: boolean;
}

// Note: there is no currentSessionId param — currentSessionId does NOT auto-expand
// a folder (that's handled by a one-time useEffect in the sidebar so users can still
// manually collapse). Auto-expand here is reveal-only (see the reveal logic below).
export function buildFolderAwareList(
  filteredEntries: AgentSessionSidebarEntry[],
  folders: ConversationFolder[],
  membership: Record<string, string>,
  options: BuildFolderAwareListOptions = {},
): SidebarListEntry[] {
  const {
    collapseState = {},
    doneCollapseState = {},
    revealSessionId = null,
    // The "Done (N)" subsection is an Active-tab concept only. The Done
    // tab already lists done conversations as a folder's regular children, and the
    // Starred tab must not surface them at all — so non-Active callers leave this
    // false to avoid double-rendering (Done tab) or leaking done rows (Starred).
    includeDoneSubsection = false,
  } = options;
  const allEntries = options.allEntries ?? filteredEntries;
  // Fast path: no folders defined → pass-through
  if (folders.length === 0) {
    return filteredEntries.map((entry) => ({ type: 'session' as const, id: entry.id, entry }));
  }

  const folderIds = new Set(folders.map((f) => f.id));

  // Partition entries into folders vs unfiled
  const byFolder = new Map<string, AgentSessionSidebarEntry[]>();
  const allChildCounts = new Map<string, number>();
  const unfiled: AgentSessionSidebarEntry[] = [];

  for (const entry of filteredEntries) {
    const folderId = membership[entry.id];
    if (folderId && folderIds.has(folderId)) {
      let bucket = byFolder.get(folderId);
      if (!bucket) {
        bucket = [];
        byFolder.set(folderId, bucket);
      }
      bucket.push(entry);
    } else {
      unfiled.push(entry);
    }
  }

  for (const entry of allEntries) {
    if (entry.isDeleted) continue;
    const folderId = membership[entry.id];
    if (folderId && folderIds.has(folderId)) {
      allChildCounts.set(folderId, (allChildCounts.get(folderId) ?? 0) + 1);
    }
  }

  // Build the per-folder "done" buckets from allEntries: conversations that
  // belong to a folder but are not active (Done), not starred (those
  // live in Starred), and not deleted. These are absent from the Active
  // tab's filteredEntries, so they MUST be sourced from allEntries. Only the
  // Active tab renders this subsection (see `includeDoneSubsection`).
  const doneByFolder = new Map<string, AgentSessionSidebarEntry[]>();
  if (includeDoneSubsection) {
    for (const entry of allEntries) {
      if (entry.isDeleted || entry.isActive || entry.isStarred) continue;
      const folderId = membership[entry.id];
      if (folderId && folderIds.has(folderId)) {
        let bucket = doneByFolder.get(folderId);
        if (!bucket) {
          bucket = [];
          doneByFolder.set(folderId, bucket);
        }
        bucket.push(entry);
      }
    }
    // Sort each done bucket by timestamp descending (newest first).
    for (const [, entries] of doneByFolder) {
      entries.sort((a, b) => b.timestamp - a.timestamp);
    }
  }

  // Auto-expand only for revealSessionId (one-shot navigation).
  // currentSessionId does NOT auto-expand — that's handled by a one-time
  // useEffect in the sidebar so users can still manually collapse.
  const autoExpandIds = new Set<string>();
  // Done subsections to force open for this one-shot reveal only. NEVER
  // persisted — preserves the user's manual collapse preference.
  const forceOpenDoneFolderIds = new Set<string>();
  if (revealSessionId) {
    const fid = membership[revealSessionId];
    if (fid && folderIds.has(fid)) {
      if (collapseState[fid]) {
        autoExpandIds.add(fid);
      }
      // If the revealed session is a done child (not active/starred), force its
      // folder open AND its done subsection open so the conversation is visible.
      const revealed = allEntries.find((e) => e.id === revealSessionId);
      if (revealed && !revealed.isActive && !revealed.isStarred && !revealed.isDeleted) {
        autoExpandIds.add(fid);
        forceOpenDoneFolderIds.add(fid);
      }
    }
  }

  // Sort within each folder: starred first, then preserve original order
  for (const [, entries] of byFolder) {
    entries.sort((a, b) => {
      const aStarred = a.isStarred ? 1 : 0;
      const bStarred = b.isStarred ? 1 : 0;
      return bStarred - aStarred;
    });
  }

  // Sort folders by createdAt ascending
  const sortedFolders = [...folders].sort((a, b) => a.createdAt - b.createdAt);

  // Build result
  const result: SidebarListEntry[] = [];

  // 1. Starred unfiled sessions
  const starredUnfiled: AgentSessionSidebarEntry[] = [];
  const nonStarredUnfiled: AgentSessionSidebarEntry[] = [];
  for (const entry of unfiled) {
    if (entry.isStarred) {
      starredUnfiled.push(entry);
    } else {
      nonStarredUnfiled.push(entry);
    }
  }
  for (const entry of starredUnfiled) {
    result.push({ type: 'session', id: entry.id, entry });
  }

  // 2. Folders
  for (const folder of sortedFolders) {
    const children = byFolder.get(folder.id) ?? [];
    const totalLiveChildren = allChildCounts.get(folder.id) ?? 0;
    if (children.length === 0 && totalLiveChildren > 0) {
      continue;
    }
    const isCollapsed = autoExpandIds.has(folder.id) ? false : Boolean(collapseState[folder.id]);

    result.push({
      type: 'folder-header',
      id: `folder:${folder.id}`,
      folder,
      childCount: children.length,
      isCollapsed,
    });

    if (!isCollapsed) {
      for (const entry of children) {
        result.push({ type: 'session', id: entry.id, entry });
      }

      // Done subsection (collapsed by default) beneath the active children.
      const doneChildren = doneByFolder.get(folder.id) ?? [];
      const doneCount = doneChildren.length;
      if (doneCount > 0) {
        const persisted = doneCollapseState[folder.id];
        const doneIsCollapsed = forceOpenDoneFolderIds.has(folder.id)
          ? false
          : persisted === undefined
            ? true
            : persisted;

        result.push({
          type: 'done-subheader',
          id: `done:${folder.id}`,
          folderId: folder.id,
          folderName: folder.name,
          doneCount,
          isCollapsed: doneIsCollapsed,
        });

        if (!doneIsCollapsed) {
          for (const entry of doneChildren) {
            result.push({ type: 'session', id: entry.id, entry, isMutedDone: true });
          }
        }
      }
    }
  }

  // 3. Non-starred unfiled sessions (original order preserved)
  for (const entry of nonStarredUnfiled) {
    result.push({ type: 'session', id: entry.id, entry });
  }

  return result;
}
