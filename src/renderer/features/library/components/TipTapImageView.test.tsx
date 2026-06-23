// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TipTapImageView } from "./TipTapImageView";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

 
vi.mock("lucide-react", async () => {
  const ReactLocal = await vi.importActual<typeof import("react")>("react");
  const createIcon = (name: string) => (props: Record<string, unknown>) =>
    ReactLocal.createElement("svg", { "data-icon": name, ...props });
  return {
    Trash2: createIcon("trash-2"),
    Copy: createIcon("copy"),
    Download: createIcon("download"),
  };
});

 
vi.mock("./TipTapImageView.module.css", () => ({
  default: new Proxy({} as Record<string, string>, {
    get: (_t, k: string) => `mock-${k}`,
  }),
}));

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
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe("TipTapImageView", () => {
  let mounted: Mounted | null = null;
  let mockDeleteNode: ReturnType<typeof vi.fn>;
  let mockReadFileBase64: ReturnType<typeof vi.fn>;
  let mockDeleteItem: ReturnType<typeof vi.fn>;
  let mockEditor: any;
  let mockRevokeObjectURL: ReturnType<typeof vi.fn>;
  let mockCreateObjectURL: ReturnType<typeof vi.fn>;
  let updateHandler: (() => void) | null;

  beforeEach(() => {
    mockDeleteNode = vi.fn();
    mockReadFileBase64 = vi.fn().mockResolvedValue("iVBORw0KGgo=");
    mockDeleteItem = vi.fn();
    updateHandler = null;

    mockEditor = {
      isEditable: true,
      isDestroyed: false,
      on: vi.fn((event: string, handler: () => void) => {
        if (event === "update") {
          updateHandler = handler;
        }
      }),
      off: vi.fn(),
    };

    window.libraryApi = {
      readFileBase64: mockReadFileBase64,
      deleteItem: mockDeleteItem,
    } as any;

    mockCreateObjectURL = vi.fn().mockReturnValue("blob:fake-url");
    mockRevokeObjectURL = vi.fn();
    global.URL.createObjectURL = mockCreateObjectURL as any;
    global.URL.revokeObjectURL = mockRevokeObjectURL as any;
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  const createProps = (
    src: string,
    isEditable = true,
    extensionOptions: Record<string, unknown> = {},
  ) => {
    mockEditor.isEditable = isEditable;

    return {
      node: { attrs: { src, alt: "Test image" } },
      extension: {
        options: { documentPath: "/test/doc.md", ...extensionOptions },
      },
      editor: mockEditor,
      deleteNode: mockDeleteNode,
    };
  };

  const renderComponent = (
    src: string,
    isEditable = true,
    extensionOptions: Record<string, unknown> = {},
  ) => {
    const props: any = createProps(src, isEditable, extensionOptions);

    mounted = mount(<TipTapImageView {...props} />);
    return mounted;
  };

  it.each([
    "javascript:alert(1)",
    " BlOb:https://example.com/image.png",
    "\tfile:///Users/example/secret.png",
  ])("renders a neutral placeholder for blocked scheme %s", (src) => {
    renderComponent(src);
    const errorPlaceholder = document.querySelector(
      '[data-testid="image-error-placeholder"]',
    );
    expect(errorPlaceholder).not.toBeNull();
    const img = document.querySelector('[data-testid="rendered-image"]');
    expect(img).toBeNull();
    expect(mockReadFileBase64).not.toHaveBeenCalled();
  });

  it("renders a neutral placeholder for vbscript with padding and mixed case", () => {
    renderComponent('   vbScript:msgbox("hello")');
    expect(
      document.querySelector('[data-testid="image-error-placeholder"]'),
    ).not.toBeNull();
    expect(mockReadFileBase64).not.toHaveBeenCalled();
  });

  it("renders a neutral placeholder for disallowed data URIs", () => {
    renderComponent("data:image/svg+xml;base64,PHN2Zz4=");
    expect(
      document.querySelector('[data-testid="image-error-placeholder"]'),
    ).not.toBeNull();
    expect(mockReadFileBase64).not.toHaveBeenCalled();
  });

  it("renders an image directly for allowed data URIs", () => {
    renderComponent("data:image/png;base64,iVBORw0KGgo=");
    const img = document.querySelector('[data-testid="rendered-image"]');
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
  });

  it("renders allowed data URIs without base64 markers and trims leading whitespace", () => {
    renderComponent("  data:image/png,%89PNG");
    const img = document.querySelector('[data-testid="rendered-image"]');
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("data:image/png,%89PNG");
    expect(mockReadFileBase64).not.toHaveBeenCalled();
  });

  it("renders padded http URLs without passing whitespace to the browser", () => {
    renderComponent("\thttps://example.com/image.png");
    const img = document.querySelector('[data-testid="rendered-image"]');
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("https://example.com/image.png");
    expect(mockReadFileBase64).not.toHaveBeenCalled();
  });

  it.each([
    "ftp://example.com/image.png",
    "mailto:test@example.com",
    "custom-scheme:image.png",
  ])(
    "renders a neutral placeholder for unsupported scheme %s without IPC",
    (src) => {
      renderComponent(src);
      expect(
        document.querySelector('[data-testid="image-error-placeholder"]'),
      ).not.toBeNull();
      expect(mockReadFileBase64).not.toHaveBeenCalled();
    },
  );

  it("loads local images using libraryApi and creates object URL", async () => {
    renderComponent("./local.png");

    expect(
      document.querySelector('[data-testid="image-loading-placeholder"]'),
    ).not.toBeNull();

    // Wait for effect to resolve
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(
      document.querySelector('[data-testid="rendered-image"]'),
    ).not.toBeNull();

    expect(mockReadFileBase64).toHaveBeenCalledWith({
      target: "./local.png",
      basePath: "/test/doc.md",
    });

    expect(mockCreateObjectURL).toHaveBeenCalled();
  });

  it("opens the image context menu on right-click of a loaded image", async () => {
    renderComponent("./local.png");

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const img = document.querySelector(
      '[data-testid="rendered-image"]',
    ) as HTMLElement;
    expect(img).not.toBeNull();
    expect(
      document.querySelector('[data-testid="image-context-menu"]'),
    ).toBeNull();

    act(() => {
      img.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          clientX: 12,
          clientY: 34,
        }),
      );
    });

    expect(
      document.querySelector('[data-testid="image-context-menu"]'),
    ).not.toBeNull();
  });

  it("shows an error for unsupported local image formats without creating an object URL", async () => {
    renderComponent("./vector.svg");

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(
      document.querySelector('[data-testid="image-error-placeholder"]'),
    ).not.toBeNull();
    expect(mockReadFileBase64).not.toHaveBeenCalled();
    expect(mockCreateObjectURL).not.toHaveBeenCalled();
  });

  it.each([
    ["rebel://library/folder/local.png", "folder/local.png"],
    ["library://folder/local.png", "folder/local.png"],
    ["workspace://folder/local.png", "folder/local.png"],
  ])(
    "loads library protocol image %s using the extracted path",
    async (src, expectedPath) => {
      renderComponent(src);

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(mockReadFileBase64).toHaveBeenCalledWith({
        target: expectedPath,
        basePath: "/test/doc.md",
      });
      expect(mockCreateObjectURL).toHaveBeenCalled();
    },
  );

  it("revokes object URL on unmount", async () => {
    renderComponent("./local.png");

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    mounted?.unmount();
    mounted = null;

    expect(mockRevokeObjectURL).toHaveBeenCalledWith("blob:fake-url");
  });

  it("revokes the previous object URL when the source changes", async () => {
    mockCreateObjectURL
      .mockReturnValueOnce("blob:first-url")
      .mockReturnValueOnce("blob:second-url");

    renderComponent("./first.png");

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(
      document
        .querySelector('[data-testid="rendered-image"]')
        ?.getAttribute("src"),
    ).toBe("blob:first-url");

    const nextProps: any = createProps("./second.png");
    act(() => {
      mounted?.root.render(<TipTapImageView {...nextProps} />);
    });

    expect(mockRevokeObjectURL).toHaveBeenCalledWith("blob:first-url");

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(
      document
        .querySelector('[data-testid="rendered-image"]')
        ?.getAttribute("src"),
    ).toBe("blob:second-url");
  });

  it("shows remove button when editable and calls deleteNode on click", async () => {
    renderComponent("data:image/png;base64,iVBORw0KGgo=");

    const removeBtn = document.querySelector(
      '[data-testid="remove-image-button"]',
    ) as HTMLButtonElement;
    expect(removeBtn).not.toBeNull();

    act(() => {
      removeBtn.click();
    });

    expect(mockDeleteNode).toHaveBeenCalled();
    expect(mockDeleteItem).not.toHaveBeenCalled();
  });

  it("calls onImageMutation after remove when provided", () => {
    const onImageMutation = vi.fn();
    renderComponent("data:image/png;base64,iVBORw0KGgo=", true, {
      onImageMutation,
    });

    const removeBtn = document.querySelector(
      '[data-testid="remove-image-button"]',
    ) as HTMLButtonElement;

    act(() => {
      removeBtn.click();
    });

    expect(mockDeleteNode).toHaveBeenCalled();
    expect(onImageMutation).toHaveBeenCalled();
  });

  it("does not delete if the editor becomes read-only before activation", () => {
    renderComponent("data:image/png;base64,iVBORw0KGgo=");

    const removeBtn = document.querySelector(
      '[data-testid="remove-image-button"]',
    ) as HTMLButtonElement;

    act(() => {
      mockEditor.isEditable = false;
      removeBtn.click();
    });

    expect(mockDeleteNode).not.toHaveBeenCalled();
  });

  it("does not show remove button when not editable", () => {
    renderComponent("data:image/png;base64,iVBORw0KGgo=", false);

    const removeBtn = document.querySelector(
      '[data-testid="remove-image-button"]',
    );
    expect(removeBtn).toBeNull();
  });

  it("reacts to editability changes without remounting", () => {
    renderComponent("data:image/png;base64,iVBORw0KGgo=");

    expect(
      document.querySelector('[data-testid="remove-image-button"]'),
    ).not.toBeNull();

    act(() => {
      mockEditor.isEditable = false;
      updateHandler?.();
    });

    expect(
      document.querySelector('[data-testid="remove-image-button"]'),
    ).toBeNull();

    act(() => {
      mockEditor.isEditable = true;
      updateHandler?.();
    });

    expect(
      document.querySelector('[data-testid="remove-image-button"]'),
    ).not.toBeNull();
  });

  it("calls deleteNode on Enter key press on remove button", () => {
    renderComponent("data:image/png;base64,iVBORw0KGgo=");

    const removeBtn = document.querySelector(
      '[data-testid="remove-image-button"]',
    ) as HTMLButtonElement;

    act(() => {
      removeBtn.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });

    expect(mockDeleteNode).toHaveBeenCalled();
  });

  it("calls deleteNode on Space key press on remove button", () => {
    renderComponent("data:image/png;base64,iVBORw0KGgo=");

    const removeBtn = document.querySelector(
      '[data-testid="remove-image-button"]',
    ) as HTMLButtonElement;

    act(() => {
      removeBtn.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: " ", bubbles: true }),
      );
    });

    expect(mockDeleteNode).toHaveBeenCalled();
  });
});
