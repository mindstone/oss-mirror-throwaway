// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangeEvent } from "react";
import {
  act,
  flushAsync,
  renderHook,
} from "@renderer/test-utils/hookTestHarness";
import { useMarkdownImageImport } from "../useMarkdownImageImport";

type FakeChain = {
  focus: ReturnType<typeof vi.fn>;
  insertContentAt: ReturnType<typeof vi.fn>;
  setTextSelection: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
};

function createFakeEditor() {
  const chain = {} as FakeChain;
  chain.focus = vi.fn(() => chain);
  chain.insertContentAt = vi.fn(() => chain);
  chain.setTextSelection = vi.fn(() => chain);
  chain.run = vi.fn(() => true);

  return {
    editor: {
      isEditable: true,
      isDestroyed: false,
      state: {
        selection: { from: 5 },
        doc: {
          content: { size: 100 },
          resolve: vi.fn(() => ({
            index: (): number => 0,
            parent: {
              canReplaceWith: (): boolean => true,
            },
          })),
        },
      },
      schema: {
        nodes: {
          image: { name: "image" },
        },
      },
      chain: vi.fn(() => chain),
    },
    chain,
  };
}

function createPngFile(name = "photo.png", type = "image/png") {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type });
}

describe("useMarkdownImageImport", () => {
  let importImageAsset: ReturnType<typeof vi.fn>;
  let persistCurrentContentNow: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let showToast: ReturnType<typeof vi.fn<(options: { title: string }) => void>>;

  beforeEach(() => {
    importImageAsset = vi.fn().mockResolvedValue({
      relativeMarkdownPath: "./doc-md.assets/photo.png",
    });
    persistCurrentContentNow = vi.fn().mockResolvedValue(undefined);
    showToast = vi.fn();
    window.libraryApi = {
      importImageAsset,
    } as unknown as Window["libraryApi"];
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("imports a valid image, inserts a TipTap image node, and persists immediately", async () => {
    const { editor, chain } = createFakeEditor();
    const { result } = renderHook(() =>
      useMarkdownImageImport({
        documentPath: "doc.md",
        editor: editor as never,
        isEditing: true,
        persistCurrentContentNow,
        showToast,
      }),
    );

    await act(async () => {
      await result.current.importFiles([createPngFile("Project Photo.png")]);
    });

    expect(importImageAsset).toHaveBeenCalledWith({
      documentPath: "doc.md",
      fileName: "Project Photo.png",
      mimeType: "image/png",
      base64Data: expect.any(String),
    });
    expect(chain.insertContentAt).toHaveBeenCalledWith(5, {
      type: "image",
      attrs: {
        src: "./doc-md.assets/photo.png",
        alt: "Project-Photo",
      },
    });
    expect(chain.setTextSelection).toHaveBeenCalledWith(6);
    expect(persistCurrentContentNow).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith({ title: "Image added" });
  });

  it("imports multiple images sequentially at the provided drop position", async () => {
    const { editor, chain } = createFakeEditor();
    importImageAsset
      .mockResolvedValueOnce({ relativeMarkdownPath: "./doc-md.assets/one.png" })
      .mockResolvedValueOnce({ relativeMarkdownPath: "./doc-md.assets/two.png" });
    const { result } = renderHook(() =>
      useMarkdownImageImport({
        documentPath: "doc.md",
        editor: editor as never,
        isEditing: true,
        persistCurrentContentNow,
        showToast,
      }),
    );

    await act(async () => {
      await result.current.importFiles(
        [createPngFile("one.png"), createPngFile("two.png")],
        { insertAt: 20 },
      );
    });

    expect(chain.insertContentAt).toHaveBeenNthCalledWith(1, 20, {
      type: "image",
      attrs: { src: "./doc-md.assets/one.png", alt: "one" },
    });
    expect(chain.insertContentAt).toHaveBeenNthCalledWith(2, 21, {
      type: "image",
      attrs: { src: "./doc-md.assets/two.png", alt: "two" },
    });
    expect(persistCurrentContentNow).toHaveBeenCalledTimes(2);
    expect(showToast).toHaveBeenCalledWith({ title: "Images added" });
  });

  it("rejects paste/drop batches above the image count cap before IPC", async () => {
    const { editor } = createFakeEditor();
    const { result } = renderHook(() =>
      useMarkdownImageImport({
        documentPath: "doc.md",
        editor: editor as never,
        isEditing: true,
        persistCurrentContentNow,
        showToast,
      }),
    );

    await act(async () => {
      await result.current.importFiles([
        createPngFile("1.png"),
        createPngFile("2.png"),
        createPngFile("3.png"),
        createPngFile("4.png"),
        createPngFile("5.png"),
        createPngFile("6.png"),
      ]);
    });

    expect(importImageAsset).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith({ title: "Add up to 5 images at a time." });
  });

  it("rejects unsupported file types before IPC", async () => {
    const { editor } = createFakeEditor();
    const { result } = renderHook(() =>
      useMarkdownImageImport({
        documentPath: "doc.md",
        editor: editor as never,
        isEditing: true,
        persistCurrentContentNow,
        showToast,
      }),
    );

    await act(async () => {
      await result.current.importFiles([
        createPngFile("vector.svg", "image/svg+xml"),
      ]);
    });

    expect(importImageAsset).not.toHaveBeenCalled();
    expect(persistCurrentContentNow).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith({
      title: "Choose a PNG, JPEG, GIF, or WebP image.",
    });
  });

  it("does not insert into a document that changed while the asset was being imported", async () => {
    const { editor, chain } = createFakeEditor();
    let resolveImport: (value: {
      relativeMarkdownPath: string;
    }) => void = () => {};
    importImageAsset.mockReturnValue(
      new Promise((resolve) => {
        resolveImport = resolve;
      }),
    );

    const { result, rerender } = renderHook(
      (props: { documentPath: string }) =>
        useMarkdownImageImport({
          documentPath: props.documentPath,
          editor: editor as never,
          isEditing: true,
          persistCurrentContentNow,
          showToast,
        }),
      { initialProps: { documentPath: "doc.md" } },
    );

    let importPromise = Promise.resolve();
    act(() => {
      importPromise = result.current.importFiles([createPngFile()]);
    });
    await flushAsync();

    rerender({ documentPath: "other.md" });

    await act(async () => {
      resolveImport({ relativeMarkdownPath: "./doc-md.assets/photo.png" });
      await importPromise;
    });

    expect(chain.insertContentAt).not.toHaveBeenCalled();
    expect(persistCurrentContentNow).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith({
      title:
        "Image copied, but the document changed before it could be inserted.",
    });
  });

  it("does not copy an asset if the document changes while the file is being encoded", async () => {
    const { editor } = createFakeEditor();
    let resolveArrayBuffer: (value: ArrayBuffer) => void = () => {};
    const delayedFile = {
      name: "photo.png",
      type: "image/png",
      size: 4,
      arrayBuffer: vi.fn(
        () =>
          new Promise<ArrayBuffer>((resolve) => {
            resolveArrayBuffer = resolve;
          }),
      ),
    } as unknown as File;

    const { result, rerender } = renderHook(
      (props: { documentPath: string }) =>
        useMarkdownImageImport({
          documentPath: props.documentPath,
          editor: editor as never,
          isEditing: true,
          persistCurrentContentNow,
          showToast,
        }),
      { initialProps: { documentPath: "doc.md" } },
    );

    let importPromise = Promise.resolve();
    act(() => {
      importPromise = result.current.importFiles([delayedFile]);
    });
    await flushAsync();

    rerender({ documentPath: "other.md" });

    await act(async () => {
      resolveArrayBuffer(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer);
      await importPromise;
    });

    expect(importImageAsset).not.toHaveBeenCalled();
    expect(persistCurrentContentNow).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith({
      title: "Document changed before the image could be added.",
    });
  });

  it("does not persist or report success if TipTap insertion fails", async () => {
    const { editor, chain } = createFakeEditor();
    chain.run.mockReturnValue(false);
    const { result } = renderHook(() =>
      useMarkdownImageImport({
        documentPath: "doc.md",
        editor: editor as never,
        isEditing: true,
        persistCurrentContentNow,
        showToast,
      }),
    );

    await act(async () => {
      await result.current.importFiles([createPngFile()]);
    });

    expect(importImageAsset).toHaveBeenCalled();
    expect(persistCurrentContentNow).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith({
      title: "Image copied, but it could not be inserted.",
    });
    expect(showToast).not.toHaveBeenCalledWith({ title: "Image added" });
  });

  it("skips insertion when no schema-valid image position exists", async () => {
    const { editor, chain } = createFakeEditor();
    editor.state.doc.resolve = vi.fn(() => ({
      index: (): number => 0,
      parent: {
        canReplaceWith: (): boolean => false,
      },
    }));
    const { result } = renderHook(() =>
      useMarkdownImageImport({
        documentPath: "doc.md",
        editor: editor as never,
        isEditing: true,
        persistCurrentContentNow,
        showToast,
      }),
    );

    await act(async () => {
      await result.current.importFiles([createPngFile()]);
    });

    expect(importImageAsset).toHaveBeenCalled();
    expect(chain.insertContentAt).not.toHaveBeenCalled();
    expect(persistCurrentContentNow).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith({
      title: "Image copied, but it could not be inserted.",
    });
  });

  it("imports from file input changes and resets the input value for same-file reselect", async () => {
    const { editor } = createFakeEditor();
    const { result } = renderHook(() =>
      useMarkdownImageImport({
        documentPath: "doc.md",
        editor: editor as never,
        isEditing: true,
        persistCurrentContentNow,
        showToast,
      }),
    );
    const input = document.createElement("input");
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [createPngFile()],
    });
    input.value = "C:\\fakepath\\photo.png";

    await act(async () => {
      result.current.fileInputProps.onChange({
        currentTarget: input,
      } as ChangeEvent<HTMLInputElement>);
      await flushAsync();
    });

    expect(importImageAsset).toHaveBeenCalled();
    expect(input.value).toBe("");
  });

  it("surfaces strict persistence failures after insertion", async () => {
    const { editor, chain } = createFakeEditor();
    persistCurrentContentNow.mockRejectedValue(
      new Error("Unable to save file changes."),
    );
    const { result } = renderHook(() =>
      useMarkdownImageImport({
        documentPath: "doc.md",
        editor: editor as never,
        isEditing: true,
        persistCurrentContentNow,
        showToast,
      }),
    );

    await act(async () => {
      await result.current.importFiles([createPngFile()]);
    });

    expect(chain.insertContentAt).toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith({
      title: "Unable to save file changes.",
    });
  });
});
