/**
 * TipTap Image NodeView Component
 *
 * Renders images inside the TipTap editor with support for:
 * - Local file loading via `readFileBase64` IPC (relative + absolute paths)
 * - Canonical `rebel://library/` paths, plus legacy-readable `library://` and `workspace://`
 * - External URLs (http/https) and safe data URIs rendered directly
 * - Loading placeholder, error fallback, and loaded image states
 * - Node removal affordance
 *
 * Part of FOX-2790 Stage 2: replaces the basic `<img>` tag from Stage 1
 * with actual image loading from the filesystem.
 * Updated in Stage 1 of markdown editor images plan to support UI/removal and strict URL guards.
 */

import { useCallback, useState, useEffect, useRef } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import type { ReactNodeViewProps } from "@tiptap/react";
import { NodeViewWrapper } from "@tiptap/react";
import { Trash2 } from "lucide-react";
import { ImageContextMenu } from "@renderer/components/ImageContextMenu";
import { useImageContextMenu } from "@renderer/components/useImageContextMenu";
import {
  extractLibraryPath,
  getLibraryProtocol,
} from "@rebel/shared/utils/libraryUrls";
import { findBlockedUrlScheme } from "@rebel/shared/utils/urlSchemePolicy";
import {
  isAllowedDataUrlMimeType,
  isAllowedImageMimeType,
} from "@shared/markdownImageAssets";
import styles from "./TipTapImageView.module.css";

/** Dangerous URL schemes that must never be rendered as image sources. */
function isDangerousScheme(src: string): boolean {
  const trimmed = src.trimStart();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("vbscript:")) return true;
  return findBlockedUrlScheme(trimmed) !== null;
}

/** Check if a URL is an external HTTP(S) or data URI that the browser can load directly. */
function isExternalUrl(src: string): boolean {
  const lower = src.trimStart().toLowerCase();
  return (
    lower.startsWith("http://") ||
    lower.startsWith("https://") ||
    lower.startsWith("data:")
  );
}

function isWindowsDrivePath(src: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(src);
}

function hasUnsupportedScheme(src: string): boolean {
  const trimmed = src.trimStart();
  if (isWindowsDrivePath(trimmed)) return false;

  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
  if (!schemeMatch) return false;

  const scheme = schemeMatch[1].toLowerCase();
  if (scheme === "http" || scheme === "https" || scheme === "data")
    return false;
  return getLibraryProtocol(trimmed) === null;
}

/** Derive MIME type from file extension for object URL construction. */
function mimeTypeFromExtension(filePath: string): string | null {
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (!ext || ext === filePath.toLowerCase()) return null;
  const mimeTypes: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
  };
  return mimeTypes[ext] ?? null;
}

/** Derive a download-friendly file name from an image source (strips query/hash). */
function fileNameFromPath(src: string): string {
  const withoutQuery = src.split(/[?#]/)[0];
  const segments = withoutQuery.split(/[\\/]/);
  const last = segments[segments.length - 1] || "image";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

type ReadFileBase64Payload = string | {
  base64: string;
  mtimeMs: number;
  size: number;
};

const readFileBase64ToString = (payload: ReadFileBase64Payload): string =>
  typeof payload === "string" ? payload : payload.base64;

export const TipTapImageView = ({
  node,
  extension,
  editor,
  deleteNode,
}: ReactNodeViewProps) => {
  const src: string = node.attrs.src ?? "";
  const alt: string = node.attrs.alt ?? "";

  // Retrieve documentPath directly from the extension instance (O(1), via ReactNodeViewProps)
  const documentPath: string | null = extension?.options?.documentPath ?? null;
  const showToast = extension?.options?.showToast as
    | ((options: { title: string }) => void)
    | null
    | undefined;

  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [isEditable, setIsEditable] = useState(editor.isEditable);

  // Right-click "Copy Image / Save Image As…" wiring (shared with chat + previews).
  // Editor images use document-relative srcs, which the save/copy IPC can't resolve
  // (it resolves relative paths against the workspace root). So we hand the menu the
  // already-fetched bytes as a data URL instead of a file path.
  const { target: contextMenu, open: openContextMenu, close: closeContextMenu } = useImageContextMenu();
  const imageDataRef = useRef<{ dataUrl: string; fileName: string } | null>(null);

  const handleContextMenu = useCallback(
    (event: MouseEvent) => {
      const data = imageDataRef.current;
      if (!data) return;
      openContextMenu(event, { dataUrl: data.dataUrl, fileName: data.fileName });
    },
    [openContextMenu],
  );

  useEffect(() => {
    const syncEditability = () => {
      setIsEditable((current) =>
        current === editor.isEditable ? current : editor.isEditable,
      );
    };
    editor.on("update", syncEditability);
    return () => {
      editor.off("update", syncEditability);
    };
  }, [editor]);

  // External URLs and data URIs can be rendered directly — no IPC needed
  const trimmedSrc = src.trimStart();
  const isDataUrl = trimmedSrc
    ? trimmedSrc.toLowerCase().startsWith("data:")
    : false;
  const isExternal = trimmedSrc ? isExternalUrl(trimmedSrc) : false;
  const isDangerous = trimmedSrc
    ? isDangerousScheme(trimmedSrc) ||
      hasUnsupportedScheme(trimmedSrc) ||
      (isDataUrl && !isAllowedDataUrlMimeType(trimmedSrc))
    : false;

  // Track external image load failures to show error placeholder instead of browser broken-image icon
  const [externalError, setExternalError] = useState(false);

  useEffect(() => {
    setExternalError(false);
  }, [src]);

  const clearObjectUrl = useCallback((updateState = true) => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    if (updateState) {
      setObjectUrl(null);
    }
  }, []);

  useEffect(() => {
    // Any non-local source invalidates the saved bytes used by the right-click menu.
    imageDataRef.current = null;

    if (!trimmedSrc || isExternal || isDangerous) {
      clearObjectUrl();
      setLoading(false);
      return;
    }

    // Guard: library IPC must be available (may be absent in test environments)
    if (!window.libraryApi?.readFileBase64) {
      setError("Image loading isn't available here.");
      setLoading(false);
      return;
    }

    let cancelled = false;
    clearObjectUrl();
    setLoading(true);
    setError(null);

    // Determine the file path to request.
    // Library URLs (`rebel://library/`, `library://`, `workspace://`) need the path extracted.
    // Relative paths need a basePath for resolution.
    const protocolPath =
      getLibraryProtocol(trimmedSrc) !== null
        ? extractLibraryPath(trimmedSrc)
        : null;
    const filePath = protocolPath ?? trimmedSrc;
    const mimeType = mimeTypeFromExtension(filePath);
    if (!mimeType || !isAllowedImageMimeType(mimeType)) {
      setError("Rebel doesn't speak that image format.");
      setLoading(false);
      return;
    }

    const request = documentPath
      ? { target: filePath, basePath: documentPath }
      : filePath;

    window.libraryApi
      .readFileBase64(request)
      .then((base64Payload) => {
        if (cancelled) return;
        try {
          const base64Data = readFileBase64ToString(base64Payload);
          const blob = base64ToBlob(base64Data, mimeType);
          const url = URL.createObjectURL(blob);
          objectUrlRef.current = url;
          setObjectUrl(url);
          // Retain the bytes (as a data URL) so the right-click menu can copy/save
          // without relying on path resolution that the IPC can't do for relative srcs.
          imageDataRef.current = {
            dataUrl: `data:${mimeType};base64,${base64Data}`,
            fileName: fileNameFromPath(filePath),
          };
        } catch {
          setError("Couldn't process that image.");
        }
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load image");
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [trimmedSrc, isExternal, isDangerous, documentPath, clearObjectUrl]);

  // Revoke object URL on unmount or source change
  useEffect(() => {
    return () => {
      clearObjectUrl(false);
    };
  }, [clearObjectUrl]);

  const handleRemoveImage = useCallback(
    (
      event: MouseEvent<HTMLButtonElement> | KeyboardEvent<HTMLButtonElement>,
    ) => {
      event.preventDefault();
      event.stopPropagation();

      if (editor.isDestroyed || !editor.isEditable) return;

      deleteNode();

      const onImageMutation = extension?.options?.onImageMutation as
        | (() => void | Promise<void>)
        | null
        | undefined;
      if (!onImageMutation) return;

      try {
        void Promise.resolve(onImageMutation()).catch((err: unknown) => {
          const errorName = err instanceof Error ? err.name : typeof err;
          console.warn(
            `[TipTapImageView] Image mutation persistence callback failed (${errorName})`,
          );
        });
      } catch (err) {
        const errorName = err instanceof Error ? err.name : typeof err;
        console.warn(
          `[TipTapImageView] Image mutation persistence callback failed (${errorName})`,
        );
      }
    },
    [deleteNode, editor, extension],
  );

  const renderRemoveButton = () => {
    if (!isEditable) return null;
    return (
      <button
        className={styles.removeButton}
        onClick={handleRemoveImage}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            handleRemoveImage(e);
          }
        }}
        aria-label="Remove image"
        title="Remove image"
        type="button"
        data-testid="remove-image-button"
      >
        <Trash2 size={16} />
      </button>
    );
  };

  // --- Render states ---

  // No src or dangerous scheme — render error placeholder
  if (!trimmedSrc || isDangerous) {
    return (
      <NodeViewWrapper as="span" className={styles.wrapper}>
        <span
          className={styles.error}
          title={isDangerous ? "Blocked URL scheme" : "No image source"}
          data-testid="image-error-placeholder"
        >
          {alt || "Image"}
        </span>
        {renderRemoveButton()}
      </NodeViewWrapper>
    );
  }

  // External URL — render a plain <img> tag with error fallback
  if (isExternal) {
    if (externalError) {
      return (
        <NodeViewWrapper as="span" className={styles.wrapper}>
          <span
            className={styles.error}
            title="Failed to load external image"
            data-testid="image-error-placeholder"
          >
            {alt || "Image"}
          </span>
          {renderRemoveButton()}
        </NodeViewWrapper>
      );
    }
    return (
      <NodeViewWrapper as="span" className={styles.wrapper}>
        <img
          src={trimmedSrc}
          alt={alt}
          className={styles.image}
          draggable={false}
          onError={() => setExternalError(true)}
          data-testid="rendered-image"
        />
        {renderRemoveButton()}
      </NodeViewWrapper>
    );
  }

  // Loading state
  if (loading) {
    return (
      <NodeViewWrapper as="span" className={styles.wrapper}>
        <span
          className={styles.loading}
          title={`Loading ${alt || "image"}…`}
          data-testid="image-loading-placeholder"
        >
          {alt || "Loading image…"}
        </span>
        {renderRemoveButton()}
      </NodeViewWrapper>
    );
  }

  // Error state
  if (error || !objectUrl) {
    return (
      <NodeViewWrapper as="span" className={styles.wrapper}>
        <span
          className={styles.error}
          title={error ?? "Failed to load image"}
          data-testid="image-error-placeholder"
        >
          {alt || "Image"}
        </span>
        {renderRemoveButton()}
      </NodeViewWrapper>
    );
  }

  // Success — loaded image
  return (
    <NodeViewWrapper as="span" className={styles.wrapper}>
      <img
        src={objectUrl}
        alt={alt}
        className={styles.image}
        draggable={false}
        onContextMenu={handleContextMenu}
        data-testid="rendered-image"
      />
      {renderRemoveButton()}
      <ImageContextMenu
        target={contextMenu}
        onClose={closeContextMenu}
        showToast={showToast ?? undefined}
      />
    </NodeViewWrapper>
  );
};

TipTapImageView.displayName = "TipTapImageView";
