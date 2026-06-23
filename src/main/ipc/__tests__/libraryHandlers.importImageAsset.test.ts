import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppSettings } from "@shared/types";
import { logger } from "@core/logger";
import { MAX_IMAGE_FILE_SIZE_BYTES } from "@shared/markdownImageAssets";

const registeredHandlers = new Map<
  string,
  (event: unknown, request: unknown) => unknown
>();
const mockLibraryBroadcasterBroadcast = vi.fn();

vi.mock("../utils/registerHandler", () => ({
  registerHandler: vi.fn(
    (
      channel: string,
      handler: (event: unknown, request: unknown) => unknown,
    ) => {
      registeredHandlers.set(channel, handler);
    },
  ),
}));

vi.mock("../../utils/broadcastHelpers", () => ({
  broadcastToAllWindows: vi.fn(),
}));

vi.mock("../../services/libraryBroadcaster", () => ({
  libraryBroadcaster: {
    broadcast: (...args: unknown[]) => mockLibraryBroadcasterBroadcast(...args),
    start: vi.fn(),
    stop: vi.fn(),
  },
}));

vi.mock("../../services/sharedSkillMutationService", () => ({
  sharedSkillMutationService: {
    writeManagedSkillFile: vi.fn(),
    attachManagedWriteObserver: vi.fn(),
  },
}));

vi.mock("../../services/skillChangeNotificationService", () => ({
  skillChangeNotificationService: {
    attachManagedWriteObserver: vi.fn(),
    listNotifications: vi.fn().mockResolvedValue([]),
    dismissNotification: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock('@core/currentUserProvider', () => ({
  getCurrentUserProvider: () => ({
    getCurrentUser: vi.fn().mockReturnValue({ id: "user-1" }),
  }),
  setCurrentUserProviderFactory: vi.fn(),
}));

vi.mock('@core/rebelAuth', () => ({
  getRebelAuthProvider: () => ({
      getAuthState: vi.fn(() => ({ isAuthenticated: false, user: null, isLoading: false })),
      onAuthStateChange: vi.fn(() => () => {}),
      getAccessToken: vi.fn(async () => null),
      invalidateAccessToken: vi.fn(),
      initializeAuth: vi.fn(async () => ({ isAuthenticated: false, user: null, isLoading: false })),
      setPostLoginCallback: vi.fn(),
      getCachedAuthConfig: vi.fn(() => null),
      requestAuthConfigRefresh: vi.fn(async () => {}),
      clearCachedProviderKey: vi.fn(),
      getSharedDriveConfig: vi.fn(() => null),
      getSubscriptionState: vi.fn(() => null),
      getManagedAllowanceResetsAt: vi.fn(() => undefined),
      refreshLicenseTier: vi.fn(),
  }),
  setRebelAuthProvider: vi.fn(),
  NULL_REBEL_AUTH_PROVIDER: {},
}));


const { registerLibraryHandlers } = await import("../libraryHandlers");

// A valid 1x1 transparent PNG base64
const VALID_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

describe("libraryHandlers import-image-asset", () => {
  let workspaceRoot = "";
  let settings: AppSettings;

  beforeEach(async () => {
    vi.clearAllMocks();
    registeredHandlers.clear();

    vi.spyOn(logger, "info");
    vi.spyOn(logger, "error");
    vi.spyOn(logger, "warn");
    vi.spyOn(logger, "debug");

    workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "library-import-image-"),
    );
    settings = { coreDirectory: workspaceRoot } as unknown as AppSettings;

    registerLibraryHandlers({
      getSettings: () => settings,
      getSettingsStore: () => ({ store: settings }),
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("successfully imports a valid image", async () => {
    const handler = registeredHandlers.get("library:import-image-asset");
    expect(handler).toBeDefined();

    // Create target markdown file
    const docPath = "notes/meeting-notes.md";
    const absoluteDocPath = path.resolve(workspaceRoot, docPath);
    await fs.mkdir(path.dirname(absoluteDocPath), { recursive: true });
    await fs.writeFile(absoluteDocPath, "# Notes", "utf8");

    const result = (await handler!(
      {},
      {
        documentPath: docPath,
        fileName: "test photo.png",
        mimeType: "image/png",
        base64Data: VALID_PNG_BASE64,
      },
    )) as any;

    expect(result.fileName).toBe("test-photo.png");
    expect(result.mimeType).toBe("image/png");
    expect(result.relativeMarkdownPath).toBe(
      "./meeting-notes-md.assets/test-photo.png",
    );

    // Verify file written to disk
    const writtenPath = path.join(
      workspaceRoot,
      "notes",
      "meeting-notes-md.assets",
      "test-photo.png",
    );
    const stat = await fs.stat(writtenPath);
    expect(stat.isFile()).toBe(true);
    expect(result.sizeBytes).toBe(stat.size);

    // Verify broadcast
    expect(mockLibraryBroadcasterBroadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        affectsTree: true,
        changedPath: "notes/meeting-notes-md.assets/test-photo.png",
      }),
      "user",
    );

    // Verify logger hygiene
    assertLogHygiene([
      workspaceRoot,
      absoluteDocPath,
      VALID_PNG_BASE64,
      "base64Data",
    ]);
  });

  it("handles collisions without overwriting", async () => {
    const handler = registeredHandlers.get("library:import-image-asset");
    const docPath = "doc.md";
    await fs.writeFile(path.join(workspaceRoot, docPath), "content", "utf8");

    // First import
    await handler!(
      {},
      {
        documentPath: docPath,
        fileName: "photo.png",
        mimeType: "image/png",
        base64Data: VALID_PNG_BASE64,
      },
    );

    // Second import with same name
    const result2 = (await handler!(
      {},
      {
        documentPath: docPath,
        fileName: "photo.png",
        mimeType: "image/png",
        base64Data: VALID_PNG_BASE64,
      },
    )) as any;

    expect(result2.fileName).toBe("photo-2.png");
    expect(result2.relativeMarkdownPath).toBe("./doc-md.assets/photo-2.png");
  });

  it("rejects missing or non-markdown document", async () => {
    const handler = registeredHandlers.get("library:import-image-asset");

    // Missing doc
    await expect(
      handler!(
        {},
        {
          documentPath: "missing.md",
          fileName: "photo.png",
          mimeType: "image/png",
          base64Data: VALID_PNG_BASE64,
        },
      ),
    ).rejects.toThrow("Target markdown document does not exist.");

    // Not a markdown file
    const txtPath = "notes.txt";
    await fs.writeFile(path.join(workspaceRoot, txtPath), "text", "utf8");
    await expect(
      handler!(
        {},
        {
          documentPath: txtPath,
          fileName: "photo.png",
          mimeType: "image/png",
          base64Data: VALID_PNG_BASE64,
        },
      ),
    ).rejects.toThrow("Target document is not a markdown file.");
  });

  it("rejects invalid base64 and magic bytes mismatch", async () => {
    const handler = registeredHandlers.get("library:import-image-asset");
    const docPath = "doc.md";
    await fs.writeFile(path.join(workspaceRoot, docPath), "content", "utf8");

    await expect(
      handler!(
        {},
        {
          documentPath: docPath,
          fileName: "photo.png",
          mimeType: "image/png",
          base64Data: "invalid base 64!",
        },
      ),
    ).rejects.toThrow("Malformed base64 payload.");

    // Valid base64 but not PNG magic bytes
    const textBase64 = Buffer.from("short").toString("base64");
    await expect(
      handler!(
        {},
        {
          documentPath: docPath,
          fileName: "photo.png",
          mimeType: "image/png",
          base64Data: textBase64,
        },
      ),
    ).rejects.toThrow("Image content is too short.");

    const fakeImageBase64 = Buffer.from(
      "just some text content longer",
    ).toString("base64");
    await expect(
      handler!(
        {},
        {
          documentPath: docPath,
          fileName: "photo.png",
          mimeType: "image/png",
          base64Data: fakeImageBase64,
        },
      ),
    ).rejects.toThrow("Image content does not match the declared MIME type.");

    await expect(
      handler!(
        {},
        {
          documentPath: docPath,
          fileName: "photo.png",
          mimeType: "image/png",
          base64Data: "//==",
        },
      ),
    ).rejects.toThrow("Non-canonical base64 payload.");
  });

  it("rejects oversized payloads before decode", async () => {
    const handler = registeredHandlers.get("library:import-image-asset");
    const docPath = "doc.md";
    await fs.writeFile(path.join(workspaceRoot, docPath), "content", "utf8");

    const oversizedBase64 = "A".repeat(
      Math.ceil((MAX_IMAGE_FILE_SIZE_BYTES + 1) / 3) * 4,
    );

    await expect(
      handler!(
        {},
        {
          documentPath: docPath,
          fileName: "photo.png",
          mimeType: "image/png",
          base64Data: oversizedBase64,
        },
      ),
    ).rejects.toThrow("Image exceeds maximum allowed size.");
  });

  it("rejects empty and Windows reserved image file names", async () => {
    const handler = registeredHandlers.get("library:import-image-asset");
    const docPath = "doc.md";
    await fs.writeFile(path.join(workspaceRoot, docPath), "content", "utf8");

    await expect(
      handler!(
        {},
        {
          documentPath: docPath,
          fileName: ".png",
          mimeType: "image/png",
          base64Data: VALID_PNG_BASE64,
        },
      ),
    ).rejects.toThrow("Image file name is required.");

    await expect(
      handler!(
        {},
        {
          documentPath: docPath,
          fileName: "CON.png",
          mimeType: "image/png",
          base64Data: VALID_PNG_BASE64,
        },
      ),
    ).rejects.toThrow("Image file name is reserved.");

    await expect(
      fs.stat(path.join(workspaceRoot, "doc-md.assets")),
    ).rejects.toThrow();
    expect(mockLibraryBroadcasterBroadcast).not.toHaveBeenCalled();
  });

  it("rejects a symlinked assets directory without writing outside the workspace", async () => {
    const handler = registeredHandlers.get("library:import-image-asset");
    const docPath = "doc.md";
    const externalAssetTarget = await fs.mkdtemp(
      path.join(os.tmpdir(), "library-import-image-external-assets-"),
    );
    await fs.writeFile(path.join(workspaceRoot, docPath), "content", "utf8");

    try {
      await fs.symlink(
        externalAssetTarget,
        path.join(workspaceRoot, "doc-md.assets"),
        "dir",
      );
    } catch {
      await fs.rm(externalAssetTarget, { recursive: true, force: true });
      return;
    }

    try {
      await expect(
        handler!(
          {},
          {
            documentPath: docPath,
            fileName: "photo.png",
            mimeType: "image/png",
            base64Data: VALID_PNG_BASE64,
          },
        ),
      ).rejects.toThrow("Target assets path cannot be a symlink.");

      await expect(
        fs.stat(path.join(externalAssetTarget, "photo.png")),
      ).rejects.toThrow();
      assertLogHygiene([workspaceRoot, externalAssetTarget, VALID_PNG_BASE64]);
    } finally {
      await fs.rm(externalAssetTarget, { recursive: true, force: true });
    }
  });

  it("fails loudly when the intended assets path already exists as a file", async () => {
    const handler = registeredHandlers.get("library:import-image-asset");
    const docPath = "doc.md";
    await fs.writeFile(path.join(workspaceRoot, docPath), "content", "utf8");
    await fs.writeFile(
      path.join(workspaceRoot, "doc-md.assets"),
      "not a directory",
      "utf8",
    );

    await expect(
      handler!(
        {},
        {
          documentPath: docPath,
          fileName: "photo.png",
          mimeType: "image/png",
          base64Data: VALID_PNG_BASE64,
        },
      ),
    ).rejects.toThrow("Target assets path exists but is not a directory.");
  });

  it("rejects path traversal attempts", async () => {
    const handler = registeredHandlers.get("library:import-image-asset");
    const outsidePath = path.join(os.tmpdir(), "outside-markdown-image-doc.md");

    await expect(
      handler!(
        {},
        {
          documentPath: "../outside.md",
          fileName: "photo.png",
          mimeType: "image/png",
          base64Data: VALID_PNG_BASE64,
        },
      ),
    ).rejects.toThrow(
      "Access to paths outside the workspace directory is not permitted.",
    );

    await expect(
      handler!(
        {},
        {
          documentPath: outsidePath,
          fileName: "photo.png",
          mimeType: "image/png",
          base64Data: VALID_PNG_BASE64,
        },
      ),
    ).rejects.toThrow(
      "Access to paths outside the workspace directory is not permitted.",
    );

    assertLogHygiene([workspaceRoot, outsidePath, VALID_PNG_BASE64]);
  });

  it("supports documents opened via a workspace symlink target path", async () => {
    const handler = registeredHandlers.get("library:import-image-asset");
    const externalSpace = await fs.mkdtemp(
      path.join(os.tmpdir(), "library-import-image-linked-space-"),
    );
    const symlinkPath = path.join(workspaceRoot, "linked-space");
    const externalDocPath = path.join(externalSpace, "notes.md");
    await fs.writeFile(externalDocPath, "content", "utf8");

    try {
      await fs.symlink(externalSpace, symlinkPath, "dir");
    } catch {
      await fs.rm(externalSpace, { recursive: true, force: true });
      return;
    }

    try {
      const result = (await handler!(
        {},
        {
          documentPath: externalDocPath,
          fileName: "photo.png",
          mimeType: "image/png",
          base64Data: VALID_PNG_BASE64,
        },
      )) as any;

      expect(result.assetPath).toBe("linked-space/notes-md.assets/photo.png");
      await expect(
        fs.stat(path.join(externalSpace, "notes-md.assets", "photo.png")),
      ).resolves.toBeDefined();
      assertLogHygiene([externalDocPath, externalSpace, VALID_PNG_BASE64]);
    } finally {
      await fs.rm(externalSpace, { recursive: true, force: true });
    }
  });

  it("does not log raw payloads or absolute paths on successful import", async () => {
    const handler = registeredHandlers.get("library:import-image-asset");
    const docPath = "secure/doc.md";
    const absoluteDocPath = path.join(workspaceRoot, docPath);
    await fs.mkdir(path.dirname(absoluteDocPath), { recursive: true });
    await fs.writeFile(absoluteDocPath, "content", "utf8");

    await handler!(
      {},
      {
        documentPath: docPath,
        fileName: "payload.png",
        mimeType: "image/png",
        base64Data: VALID_PNG_BASE64,
      },
    );

    assertLogHygiene([
      workspaceRoot,
      absoluteDocPath,
      path.join(workspaceRoot, "secure", "doc-md.assets", "payload.png"),
      VALID_PNG_BASE64,
      "base64Data",
    ]);
  });
});

function assertLogHygiene(forbiddenFragments: string[]): void {
  const calls = [
    ...(logger.info as unknown as ReturnType<typeof vi.fn>).mock.calls,
    ...(logger.warn as unknown as ReturnType<typeof vi.fn>).mock.calls,
    ...(logger.error as unknown as ReturnType<typeof vi.fn>).mock.calls,
    ...(logger.debug as unknown as ReturnType<typeof vi.fn>).mock.calls,
  ];
  const serializedLogs = JSON.stringify(calls);
  for (const fragment of forbiddenFragments) {
    expect(serializedLogs).not.toContain(fragment);
  }
}
