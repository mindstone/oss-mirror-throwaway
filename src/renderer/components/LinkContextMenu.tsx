import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  FileText,
  FolderOpen,
  Copy,
  ExternalLink,
  Link,
  Folder,
  Globe,
} from 'lucide-react';
import { generateShareLink, type ShareLinkResult } from '@core/navigation';
import { rendererDesktopSpaceResolver } from '@renderer/contexts/desktopSpaceResolverRenderer';
import { isPreviewablePath } from '@renderer/utils/documentUtils';
import { formatLibraryUrl } from '@shared/navigation/urlParser';
import styles from './LinkContextMenu.module.css';

const canPreviewInDrawer = (filePath: string): boolean => {
  if (filePath.endsWith('/')) return false;
  return isPreviewablePath(filePath);
};

export type LinkContextMenuTarget = {
  x: number;
  y: number;
  /** Workspace-relative path (decoded from rebel://library/ / library:// URL) */
  relativePath: string;
  /** The original rebel://library/, library://, or workspace:// URL */
  libraryUrl: string;
  /** Resolved full/absolute path */
  fullPath: string | null;
  /** Whether this is a folder link */
  isFolder: boolean;
};

export type LinkContextMenuProps = {
  target: LinkContextMenuTarget | null;
  onClose: () => void;
  showToast?: (options: { title: string }) => void;
  /** Open file in the Document Preview Drawer */
  onOpenInPreview?: (filePath: string) => void;
  /** Open file/folder in the Library view */
  onOpenInLibrary?: (filePath: string, isFolder: boolean) => void;
  /**
   * Cloud origin (e.g. `https://cloud.getrebel.com`). When set, the menu adds
   * a "Copy web link" action that copies the `/app/open?u=<rebel>` launcher
   * URL — useful for sharing with recipients who don't have Rebel installed.
   */
  cloudBaseUrl?: string;
};

const LinkContextMenuComponent = ({
  target,
  onClose,
  showToast,
  onOpenInPreview,
  onOpenInLibrary,
  cloudBaseUrl,
}: LinkContextMenuProps) => {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [shareLink, setShareLink] = useState<ShareLinkResult | null>(null);

  useEffect(() => {
    if (target) {
      setMenuPos({ x: target.x, y: target.y });
    } else {
      setMenuPos(null);
    }
  }, [target]);

  // Resolve the share link whenever the menu opens on a new target. The
  // resolver looks up whether this file lives in a shareable space so we know
  // to emit `rebel://space/...` (portable) vs. disable sharing for local-only
  // / private-space paths.
  useEffect(() => {
    if (!target) {
      setShareLink(null);
      return;
    }
    // If the file path isn't resolvable to an absolute path, we can't
    // reverse-resolve it to a space. Skip — UI will show disabled state.
    if (!target.fullPath) {
      setShareLink({ ok: false, reason: 'not-in-workspace' });
      return;
    }
    let cancelled = false;
    const resource = target.isFolder
      ? { kind: 'library-folder' as const, absolutePath: target.fullPath }
      : { kind: 'library-file' as const, absolutePath: target.fullPath };
    void generateShareLink(resource, {
      spaceResolver: rendererDesktopSpaceResolver,
      cloudBaseUrl,
    }).then((result) => {
      if (!cancelled) setShareLink(result);
    });
    return () => {
      cancelled = true;
    };
  }, [target, cloudBaseUrl]);

  useLayoutEffect(() => {
    if (!target || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const padding = 8;
    let x = target.x;
    let y = target.y;
    if (x + rect.width + padding > viewportW) {
      x = Math.max(padding, viewportW - rect.width - padding);
    }
    if (y + rect.height + padding > viewportH) {
      y = Math.max(padding, viewportH - rect.height - padding);
    }
    if (!menuPos || x !== menuPos.x || y !== menuPos.y) {
      setMenuPos({ x, y });
    }
  }, [target, menuPos]);

  useEffect(() => {
    if (!target) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('click', onClick, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('click', onClick, true);
    };
  }, [target, onClose]);

  const handleOpenInPreview = useCallback(() => {
    if (!target || target.isFolder) return;
    onOpenInPreview?.(target.relativePath);
    onClose();
  }, [target, onOpenInPreview, onClose]);

  const handleOpenInLibrary = useCallback(() => {
    if (!target) return;
    onOpenInLibrary?.(target.relativePath, target.isFolder);
    onClose();
  }, [target, onOpenInLibrary, onClose]);

  const handleCopyRelativePath = useCallback(async () => {
    if (!target) return;
    try {
      await navigator.clipboard.writeText(target.relativePath);
      showToast?.({ title: 'Relative path copied' });
    } catch (error) {
      console.error('Failed to copy relative path:', error);
      showToast?.({ title: "Couldn't copy that path" });
    }
    onClose();
  }, [target, onClose, showToast]);

  const handleCopyFullPath = useCallback(async () => {
    if (!target?.fullPath) return;
    try {
      await navigator.clipboard.writeText(target.fullPath);
      showToast?.({ title: 'Full path copied' });
    } catch (error) {
      console.error('Failed to copy full path:', error);
      showToast?.({ title: "Couldn't copy that path" });
    }
    onClose();
  }, [target, onClose, showToast]);

  const handleRevealInFinder = useCallback(async () => {
    if (!target) return;
    try {
      await window.appApi.revealPath(target.relativePath);
    } catch (error) {
      console.error('Failed to reveal in file explorer:', error);
      showToast?.({ title: "Couldn't reveal it in your file explorer" });
    }
    onClose();
  }, [target, onClose, showToast]);

  const handleOpenInApp = useCallback(async () => {
    if (!target) return;
    try {
      await window.appApi.openPath(target.fullPath ?? target.relativePath);
    } catch (error) {
      console.error('Failed to open in app:', error);
      showToast?.({ title: "Couldn't open that file" });
    }
    onClose();
  }, [target, onClose, showToast]);

  const handleCopyRebelLink = useCallback(async () => {
    if (!target) return;
    // Prefer the canonical `rebel://space/...` form when available — it
    // actually works when pasted into someone else's Rebel. Fall back to the
    // canonical `rebel://library/` URL even when the original link was legacy
    // and the file is local-only (no shareable space); in that case the copy
    // is useful for self-reference but a
    // recipient with a different workspace won't resolve it.
    const text = shareLink?.ok ? shareLink.rebel : formatLibraryUrl(target.relativePath);
    try {
      await navigator.clipboard.writeText(text);
      showToast?.({
        title: shareLink?.ok ? 'Rebel link copied' : 'Local link copied',
      });
    } catch (error) {
      console.error('Failed to copy Rebel link:', error);
      showToast?.({ title: "Couldn't copy that link" });
    }
    onClose();
  }, [target, shareLink, onClose, showToast]);

  const handleCopyWebLink = useCallback(async () => {
    if (!target || !shareLink?.ok || !shareLink.https) return;
    try {
      await navigator.clipboard.writeText(shareLink.https);
      showToast?.({ title: 'Web link copied' });
    } catch (error) {
      console.error('Failed to copy web link:', error);
      showToast?.({ title: "Couldn't copy that link" });
    }
    onClose();
  }, [target, shareLink, onClose, showToast]);

  // Whether the "Copy web link" option should be visible. Only when:
  //   - cloud is configured (cloudBaseUrl set), AND
  //   - the resource resolved to a shareable space (`shareLink.ok`), AND
  //   - generateShareLink produced an https URL (it does iff cloudBaseUrl was
  //     set when we called it — but kept as a second check for clarity).
  const webLinkAvailable = useMemo(
    () => Boolean(cloudBaseUrl && shareLink?.ok && shareLink.https),
    [cloudBaseUrl, shareLink],
  );

  if (!target) return null;

  const canPreview = !target.isFolder && canPreviewInDrawer(target.relativePath);

  return createPortal(
    <div
      ref={menuRef}
      className={styles.contextMenu}
      style={{ top: menuPos?.y ?? target.y, left: menuPos?.x ?? target.x }}
      onClick={(e) => e.stopPropagation()}
      role="menu"
      data-testid="link-context-menu"
    >
      {/* Navigation actions */}
      <button
        type="button"
        className={styles.contextMenuItem}
        onClick={handleOpenInPreview}
        disabled={!canPreview}
        role="menuitem"
      >
        <FileText size={14} className={styles.contextMenuIcon} />
        <span className={styles.contextMenuLabel}>Open in Document Preview</span>
      </button>
      <button
        type="button"
        className={styles.contextMenuItem}
        onClick={handleOpenInLibrary}
        role="menuitem"
      >
        {target.isFolder ? (
          <Folder size={14} className={styles.contextMenuIcon} />
        ) : (
          <FolderOpen size={14} className={styles.contextMenuIcon} />
        )}
        <span className={styles.contextMenuLabel}>Open in Library</span>
      </button>

      <div className={styles.divider} />

      {/* Copy actions */}
      <button
        type="button"
        className={styles.contextMenuItem}
        onClick={() => void handleCopyRelativePath()}
        role="menuitem"
      >
        <Copy size={14} className={styles.contextMenuIcon} />
        <span className={styles.contextMenuLabel}>Copy relative path</span>
      </button>
      <button
        type="button"
        className={styles.contextMenuItem}
        onClick={() => void handleCopyFullPath()}
        disabled={!target.fullPath}
        role="menuitem"
      >
        <Copy size={14} className={styles.contextMenuIcon} />
        <span className={styles.contextMenuLabel}>Copy full path</span>
      </button>

      <div className={styles.divider} />

      {/* System actions */}
      <button
        type="button"
        className={styles.contextMenuItem}
        onClick={() => void handleRevealInFinder()}
        role="menuitem"
      >
        <ExternalLink size={14} className={styles.contextMenuIcon} />
        <span className={styles.contextMenuLabel}>Reveal in file explorer</span>
      </button>
      <button
        type="button"
        className={styles.contextMenuItem}
        onClick={() => void handleOpenInApp()}
        role="menuitem"
      >
        <ExternalLink size={14} className={styles.contextMenuIcon} />
        <span className={styles.contextMenuLabel}>Open in external app</span>
      </button>

      <div className={styles.divider} />

      {/* Share / protocol links */}
      <button
        type="button"
        className={styles.contextMenuItem}
        onClick={() => void handleCopyRebelLink()}
        role="menuitem"
        title={
          shareLink?.ok
            ? 'Copy a rebel:// link that opens this file in Rebel'
            : "This file isn't in a shareable space — link only works on your machine"
        }
      >
        <Link size={14} className={styles.contextMenuIcon} />
        <span className={styles.contextMenuLabel}>
          {shareLink?.ok ? 'Copy Rebel link' : 'Copy local link'}
        </span>
      </button>
      {webLinkAvailable && (
        <button
          type="button"
          className={styles.contextMenuItem}
          onClick={() => void handleCopyWebLink()}
          role="menuitem"
          title="Copy a web link that opens Rebel if installed, otherwise shows an install page"
        >
          <Globe size={14} className={styles.contextMenuIcon} />
          <span className={styles.contextMenuLabel}>Copy web link</span>
        </button>
      )}
    </div>,
    document.body
  );
};

export const LinkContextMenu = memo(LinkContextMenuComponent);
LinkContextMenu.displayName = 'LinkContextMenu';
