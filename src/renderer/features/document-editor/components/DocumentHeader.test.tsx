// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentHeader } from "./DocumentHeader";
import type { FileCategory } from "@renderer/utils/documentUtils";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

 
vi.mock("@renderer/components/ui", () => ({
  Tooltip: ({
    children,
    content,
  }: {
    children: React.ReactNode;
    content?: React.ReactNode;
  }) => (
    <span data-tooltip-content={typeof content === "string" ? content : undefined}>
      {children}
    </span>
  ),
  IconButton: React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & { children?: React.ReactNode }>(
    (props, ref) => <button ref={ref} {...props} />,
  ),
}));

 
vi.mock("lucide-react", async () => {
  const ReactLocal = await vi.importActual<typeof import("react")>("react");
  const createIcon = (name: string) => (props: Record<string, unknown>) =>
    ReactLocal.createElement("svg", { "data-icon": name, ...props });
  return {
    X: createIcon("X"),
    Copy: createIcon("Copy"),
    Lock: createIcon("Lock"),
    Globe: createIcon("Globe"),
    MoreHorizontal: createIcon("MoreHorizontal"),
    FolderOpen: createIcon("FolderOpen"),
    Folder: createIcon("Folder"),
    Download: createIcon("Download"),
    FileText: createIcon("FileText"),
    Link: createIcon("Link"),
    ExternalLink: createIcon("ExternalLink"),
    PenLine: createIcon("PenLine"),
    FolderInput: createIcon("FolderInput"),
    Trash2: createIcon("Trash2"),
    Maximize2: createIcon("Maximize2"),
    Minimize2: createIcon("Minimize2"),
    Globe2: createIcon("Globe2"),
    Check: createIcon("Check"),
    History: createIcon("History"),
    ImagePlus: createIcon("ImagePlus"),
    Loader2: createIcon("Loader2"),
  };
});

type Mounted = {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
};

function mount(ui: React.ReactElement): Mounted {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return {
    container,
    root,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const documentActions = {
  breadcrumbSegments: [],
  enclosingFolderPath: null,
  exporting: null,
  copyFullPath: vi.fn(),
  copyRelativePath: vi.fn(),
  revealInFinder: vi.fn(),
  exportPdf: vi.fn(),
  exportDocx: vi.fn(),
  exportMarkdown: vi.fn(),
  openWithDefaultApp: vi.fn(),
};

describe("DocumentHeader markdown image upload", () => {
  let mounted: Mounted | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders upload controls when markdown image upload is available", () => {
    mounted = mount(
      <DocumentHeader
        fileName="doc.md"
        documentPath="doc.md"
        absolutePath={null}
        fileCategory="text"
        isMarkdownFile
        isEditing
        isDirty={false}
        isSaving={false}
        justSaved={false}
        statusText="Saved"
        documentActions={documentActions}
        content="# Doc"
        onClose={vi.fn()}
        showOpenInBrowser={false}
        onOpenInBrowser={vi.fn()}
        onSave={vi.fn()}
        markdownImageUpload={{
          canUpload: true,
          isUploading: false,
          inputProps: {
            accept: "image/png",
            multiple: false,
            disabled: false,
            onChange: vi.fn(),
          },
        }}
      />,
    );

    expect(
      document.querySelector('[data-testid="markdown-image-upload-button"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="markdown-image-upload-input"]'),
    ).not.toBeNull();
  });

  it("clicks the hidden file input from the visible upload button", () => {
    mounted = mount(
      <DocumentHeader
        fileName="doc.md"
        documentPath="doc.md"
        absolutePath={null}
        fileCategory="text"
        isMarkdownFile
        isEditing
        isDirty={false}
        isSaving={false}
        justSaved={false}
        statusText="Saved"
        documentActions={documentActions}
        content="# Doc"
        onClose={vi.fn()}
        showOpenInBrowser={false}
        onOpenInBrowser={vi.fn()}
        onSave={vi.fn()}
        markdownImageUpload={{
          canUpload: true,
          isUploading: false,
          inputProps: {
            accept: "image/png",
            multiple: false,
            disabled: false,
            onChange: vi.fn(),
          },
        }}
      />,
    );

    const input = document.querySelector(
      '[data-testid="markdown-image-upload-input"]',
    ) as HTMLInputElement;
    const button = document.querySelector(
      '[data-testid="markdown-image-upload-button"]',
    ) as HTMLButtonElement;
    const clickSpy = vi
      .spyOn(input, "click")
      .mockImplementation(() => undefined);

    act(() => {
      button.click();
    });

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    { fileName: "doc.md", isMarkdownFile: true, content: "# Doc" },
    { fileName: "notes.txt", isMarkdownFile: false, content: "Notes" },
    { fileName: "config.json", isMarkdownFile: false, content: "{\"ok\":true}" },
    { fileName: "config.yaml", isMarkdownFile: false, content: "ok: true" },
  ])(
    "does not render preview/edit toggle for editable text files ($fileName)",
    ({ fileName, isMarkdownFile, content }) => {
      mounted = mount(
        <DocumentHeader
          fileName={fileName}
          documentPath={fileName}
          absolutePath={null}
          fileCategory="text"
          isMarkdownFile={isMarkdownFile}
          isEditing
          isDirty={false}
          isSaving={false}
          justSaved={false}
          statusText="Saved"
          documentActions={documentActions}
          content={content}
          onClose={vi.fn()}
          showOpenInBrowser={false}
          onOpenInBrowser={vi.fn()}
          onSave={vi.fn()}
        />,
      );

      expect(
        document.querySelector('[data-testid="document-edit-preview-toggle"]'),
      ).toBeNull();
      expect(
        Array.from(document.querySelectorAll("button")).some((button) => {
          const label = button.textContent?.trim();
          return label === "Preview" || label === "Edit";
        }),
      ).toBe(false);
    },
  );

  it.each([
    { fileName: "report.pdf", fileCategory: "pdf", showOpenInBrowser: false },
    { fileName: "image.png", fileCategory: "image", showOpenInBrowser: false },
    { fileName: "video.mp4", fileCategory: "video", showOpenInBrowser: false },
    { fileName: "audio.mp3", fileCategory: "audio", showOpenInBrowser: false },
    { fileName: "index.html", fileCategory: "html", showOpenInBrowser: true },
  ] satisfies Array<{
    fileName: string;
    fileCategory: FileCategory;
    showOpenInBrowser: boolean;
  }>)(
    "renders preview-only categories without any preview/edit toggle ($fileName)",
    ({ fileName, fileCategory, showOpenInBrowser }) => {
      mounted = mount(
        <DocumentHeader
          fileName={fileName}
          documentPath={fileName}
          absolutePath={null}
          fileCategory={fileCategory}
          isMarkdownFile={false}
          isEditing={false}
          isDirty={false}
          isSaving={false}
          justSaved={false}
          statusText="Saved"
          documentActions={documentActions}
          content={null}
          onClose={vi.fn()}
          showOpenInBrowser={showOpenInBrowser}
          onOpenInBrowser={vi.fn()}
          onSave={vi.fn()}
        />,
      );

      expect(
        document.querySelector('[data-testid="document-edit-preview-toggle"]'),
      ).toBeNull();
      expect(
        Array.from(document.querySelectorAll("button")).some((button) => {
          const label = button.textContent?.trim();
          return label === "Preview" || label === "Edit";
        }),
      ).toBe(false);
    },
  );

  it("cycles focus mode from the header focus button", () => {
    const onToggleKioskMode = vi.fn();
    mounted = mount(
      <DocumentHeader
        fileName="doc.md"
        documentPath="doc.md"
        absolutePath={null}
        fileCategory="text"
        isMarkdownFile
        isEditing
        isDirty={false}
        isSaving={false}
        justSaved={false}
        statusText="Saved"
        documentActions={documentActions}
        content="# Doc"
        onClose={vi.fn()}
        showOpenInBrowser={false}
        onOpenInBrowser={vi.fn()}
        onSave={vi.fn()}
        kioskModeEnabled
        kioskLevel="wide"
        onToggleKioskMode={onToggleKioskMode}
      />,
    );

    const focusButton = document.querySelector(
      '[data-testid="document-focus-toggle"]',
    ) as HTMLButtonElement;
    expect(focusButton).not.toBeNull();
    expect(focusButton.getAttribute("aria-pressed")).toBe("true");

    act(() => {
      focusButton.click();
    });

    expect(onToggleKioskMode).toHaveBeenCalledTimes(1);
  });

  it("updates focus tooltip copy by kiosk state and omits Cmd+Shift+F", () => {
    const scenarios: Array<{
      level: "off" | "wide" | "zen";
      expectedPhrase: string;
      expectedAriaLabel: string;
      expectedButtonLabel: string;
    }> = [
      {
        level: "off",
        expectedPhrase: "Focus document",
        expectedAriaLabel: "Focus document",
        expectedButtonLabel: "Focus",
      },
      {
        level: "wide",
        expectedPhrase: "Enter Zen mode",
        expectedAriaLabel: "Enter Zen mode (hides file list and chrome)",
        expectedButtonLabel: "Zen",
      },
      {
        level: "zen",
        expectedPhrase: "Exit focus",
        expectedAriaLabel: "Exit focus",
        expectedButtonLabel: "Exit",
      },
    ];

    for (const scenario of scenarios) {
      mounted = mount(
        <DocumentHeader
          fileName="doc.md"
          documentPath="doc.md"
          absolutePath={null}
          fileCategory="text"
          isMarkdownFile
          isEditing
          isDirty={false}
          isSaving={false}
          justSaved={false}
          statusText="Saved"
          documentActions={documentActions}
          content="# Doc"
          onClose={vi.fn()}
          showOpenInBrowser={false}
          onOpenInBrowser={vi.fn()}
          onSave={vi.fn()}
          kioskModeEnabled={scenario.level !== "off"}
          kioskLevel={scenario.level}
          onToggleKioskMode={vi.fn()}
        />,
      );

      const focusButton = mounted.container.querySelector(
        '[data-testid="document-focus-toggle"]',
      ) as HTMLButtonElement | null;
      const tooltipContent = focusButton?.parentElement?.getAttribute("data-tooltip-content") ?? "";

      expect(tooltipContent).toContain(scenario.expectedPhrase);
      expect(tooltipContent).not.toContain("Shift+F");
      expect(focusButton?.getAttribute("aria-label")).toBe(scenario.expectedAriaLabel);
      expect(focusButton?.textContent?.trim()).toBe(scenario.expectedButtonLabel);

      mounted.unmount();
      mounted = null;
    }
  });
});
