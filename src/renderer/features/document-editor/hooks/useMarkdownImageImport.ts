import { useCallback, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import type { Editor } from "@tiptap/core";
import {
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_IMAGE_FILE_SIZE_BYTES,
  MAX_BATCH_IMAGE_COUNT,
  MAX_BATCH_IMAGE_SIZE_BYTES,
  isAllowedImageMimeType,
  sanitizeAssetIdentifier,
} from "@shared/markdownImageAssets";

type ShowToast = (options: { title: string }) => void;

type ImportImageAssetResult = {
  relativeMarkdownPath: string;
};

export interface UseMarkdownImageImportOptions {
  documentPath: string | null;
  editor: Editor | null;
  isEditing: boolean;
  persistCurrentContentNow: () => Promise<void>;
  showToast?: ShowToast;
}

export interface UseMarkdownImageImportResult {
  canImportImages: boolean;
  isImportingImage: boolean;
  fileInputProps: {
    accept: string;
    multiple: false;
    disabled: boolean;
    onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  };
  importFiles: (
    files: FileList | File[],
    options?: { insertAt?: number },
  ) => Promise<void>;
}

const IMAGE_ACCEPT = ALLOWED_IMAGE_MIME_TYPES.join(",");

function getFileStem(fileName: string): string {
  const lastDotIndex = fileName.lastIndexOf(".");
  return lastDotIndex > 0 ? fileName.slice(0, lastDotIndex) : fileName;
}

function getImageAltText(fileName: string): string {
  return sanitizeAssetIdentifier(getFileStem(fileName), "");
}

function canInsertNodeAt(editor: Editor, position: number, nodeTypeName: string): boolean {
  const nodeType = editor.schema.nodes[nodeTypeName];
  if (!nodeType) return false;

  const doc = editor.state.doc;
  if (position < 0 || position > doc.content.size) return false;

  try {
    const $pos = doc.resolve(position);
    return $pos.parent.canReplaceWith($pos.index(), $pos.index(), nodeType);
  } catch {
    return false;
  }
}

function findNearestValidInsertPosition(
  editor: Editor,
  requestedPosition: number,
  nodeTypeName: string,
): number | null {
  const maxPosition = editor.state.doc.content.size;
  const clampedPosition = Math.max(0, Math.min(requestedPosition, maxPosition));

  for (let offset = 0; offset <= maxPosition; offset += 1) {
    const before = clampedPosition - offset;
    if (before >= 0 && canInsertNodeAt(editor, before, nodeTypeName)) {
      return before;
    }

    const after = clampedPosition + offset;
    if (after !== before && after <= maxPosition && canInsertNodeAt(editor, after, nodeTypeName)) {
      return after;
    }
  }

  return null;
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function useMarkdownImageImport({
  documentPath,
  editor,
  isEditing,
  persistCurrentContentNow,
  showToast,
}: UseMarkdownImageImportOptions): UseMarkdownImageImportResult {
  const [isImportingImage, setIsImportingImage] = useState(false);
  const latestRef = useRef({
    documentPath,
    editor,
    isEditing,
    persistCurrentContentNow,
  });
  latestRef.current = {
    documentPath,
    editor,
    isEditing,
    persistCurrentContentNow,
  };
  const importGenerationRef = useRef(0);

  const canImportImages = Boolean(
    documentPath &&
    editor &&
    isEditing &&
    editor.isEditable &&
    !editor.isDestroyed,
  );

  const importFiles = useCallback(
    async (
      filesInput: FileList | File[],
      options?: { insertAt?: number },
    ) => {
      const files = Array.from(filesInput);
      if (files.length === 0) return;

      const snapshot = latestRef.current;
      const activeEditor = snapshot.editor;
      const activeDocumentPath = snapshot.documentPath;
      if (
        !activeDocumentPath ||
        !activeEditor ||
        !snapshot.isEditing ||
        !activeEditor.isEditable ||
        activeEditor.isDestroyed
      ) {
        showToast?.({
          title: "Open a markdown document in edit mode to add images.",
        });
        return;
      }

      if (files.length > MAX_BATCH_IMAGE_COUNT) {
        showToast?.({ title: "Add up to 5 images at a time." });
        return;
      }

      const aggregateSize = files.reduce((sum, file) => sum + file.size, 0);
      if (aggregateSize > MAX_BATCH_IMAGE_SIZE_BYTES) {
        showToast?.({ title: "That batch is too large. Keep it under 20 MB." });
        return;
      }

      const unsupportedFile = files.find((file) => !isAllowedImageMimeType(file.type));
      if (unsupportedFile) {
        showToast?.({ title: "Choose a PNG, JPEG, GIF, or WebP image." });
        return;
      }

      const emptyFile = files.find((file) => file.size === 0);
      if (emptyFile) {
        showToast?.({ title: "That image is empty." });
        return;
      }

      const oversizedFile = files.find((file) => file.size > MAX_IMAGE_FILE_SIZE_BYTES);
      if (oversizedFile) {
        showToast?.({ title: "That image is too large. Keep it under 10 MB." });
        return;
      }

      const generation = importGenerationRef.current + 1;
      importGenerationRef.current = generation;
      let nextInsertAt = options?.insertAt ?? activeEditor.state.selection.from;
      const isCurrentImportTarget = () => {
        const latest = latestRef.current;
        return (
          importGenerationRef.current === generation &&
          latest.documentPath === activeDocumentPath &&
          latest.editor === activeEditor &&
          latest.isEditing &&
          !activeEditor.isDestroyed &&
          activeEditor.isEditable
        );
      };

      setIsImportingImage(true);
      try {
        for (const file of files) {
          const mimeType = file.type;
          if (!isAllowedImageMimeType(mimeType)) return;

          const base64Data = await fileToBase64(file);
          if (!isCurrentImportTarget()) {
            showToast?.({
              title: "Document changed before the image could be added.",
            });
            return;
          }

          const result = (await window.libraryApi.importImageAsset({
            documentPath: activeDocumentPath,
            fileName: file.name,
            mimeType,
            base64Data,
          })) as ImportImageAssetResult;

          if (!isCurrentImportTarget()) {
            showToast?.({
              title:
                "Image copied, but the document changed before it could be inserted.",
            });
            return;
          }

          const safeInsertAt = findNearestValidInsertPosition(
            activeEditor,
            nextInsertAt,
            "image",
          );
          if (safeInsertAt === null) {
            showToast?.({
              title: "Image copied, but it could not be inserted.",
            });
            return;
          }

          const inserted = activeEditor
            .chain()
            .focus()
            .insertContentAt(safeInsertAt, {
              type: "image",
              attrs: {
                src: result.relativeMarkdownPath,
                alt: getImageAltText(file.name),
              },
            })
            .setTextSelection(safeInsertAt + 1)
            .run();
          if (!inserted) {
            showToast?.({
              title: "Image copied, but it could not be inserted.",
            });
            return;
          }

          nextInsertAt = safeInsertAt + 1;
          await latestRef.current.persistCurrentContentNow();
        }

        showToast?.({ title: files.length === 1 ? "Image added" : "Images added" });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Could not add image.";
        showToast?.({ title: message });
      } finally {
        if (importGenerationRef.current === generation) {
          setIsImportingImage(false);
        }
      }
    },
    [showToast],
  );

  const fileInputProps = useMemo(
    () => ({
      accept: IMAGE_ACCEPT,
      multiple: false as const,
      disabled: !canImportImages || isImportingImage,
      onChange: (event: ChangeEvent<HTMLInputElement>) => {
        const { files } = event.currentTarget;
        if (files) {
          void importFiles(files);
        }
        event.currentTarget.value = "";
      },
    }),
    [canImportImages, importFiles, isImportingImage],
  );

  return {
    canImportImages,
    isImportingImage,
    fileInputProps,
    importFiles,
  };
}
