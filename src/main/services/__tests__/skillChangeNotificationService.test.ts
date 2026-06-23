import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@shared/types";
import { sharedSkillMutationService } from "../sharedSkillMutationService";
import { skillChangeNotificationService } from "../skillChangeNotificationService";
import * as spaceService from "../spaceService";
import * as settingsStore from "@core/services/settingsStore";
import * as atomicFs from "../../utils/atomicFs";

const { mockWarn, mockError, mockDebug, mockTrackMainEvent, mockAnonymousId, mockGetCurrentUser } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
  mockError: vi.fn(),
  mockDebug: vi.fn(),
  mockTrackMainEvent: vi.fn(),
  mockAnonymousId: vi.fn(() => "anon-test-id"),
  mockGetCurrentUser: vi.fn(),
}));

vi.mock("@core/logger", () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: mockWarn,
    error: mockError,
    debug: mockDebug,
  }),
}));

vi.mock("../spaceService");
vi.mock("@core/services/settingsStore");
vi.mock('@core/currentUserProvider', () => ({
  getCurrentUserProvider: () => ({ getCurrentUser: mockGetCurrentUser }),
  setCurrentUserProviderFactory: vi.fn(),
}));
vi.mock("../../analytics", () => ({
  getOrGenerateAnonymousId: mockAnonymousId,
  trackMainEvent: mockTrackMainEvent,
}));
vi.mock("@core/broadcastService", () => ({
  getBroadcastService: () => ({ sendToAllWindows: vi.fn(), sendToFocusedWindow: vi.fn() }),
}));

type MockScannedSpace = Awaited<
  ReturnType<typeof spaceService.scanSpaces>
>[number];

function makeMockSpace(overrides: Partial<MockScannedSpace>): MockScannedSpace {
  return {
    name: "Team Space",
    path: "team-space",
    absolutePath: "/tmp/team-space",
    type: "team",
    isSymlink: false,
    hasReadme: true,
    sharing: "restricted",
    ...overrides,
  } as MockScannedSpace;
}

describe("skillChangeNotificationService", () => {
  let workspaceDir: string;
  let sharedSpaceDir: string;
  let sharedSkillPath: string;

  beforeEach(async () => {
    sharedSkillMutationService.clearTrackedHashes();
    (
      skillChangeNotificationService as unknown as {
        lastPruneTimestamp: number;
      }
    ).lastPruneTimestamp = 0;
    workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "skill-change-notifications-"),
    );
    sharedSpaceDir = path.join(workspaceDir, "team-space");
    sharedSkillPath = path.join(
      sharedSpaceDir,
      "skills",
      "operations",
      "demo-skill",
      "SKILL.md",
    );

    await fs.mkdir(path.dirname(sharedSkillPath), { recursive: true });
    await fs.writeFile(sharedSkillPath, "---\ndescription: Demo skill\n---\n\nInitial content\n", "utf8");
    await fs.writeFile(
      path.join(sharedSpaceDir, "README.md"),
      "# Team Space",
      "utf8",
    );

    vi.mocked(settingsStore.getSettings).mockReturnValue({
      coreDirectory: workspaceDir,
      spaces: [
        {
          name: "Team Space",
          path: "team-space",
          type: "team",
          isSymlink: false,
          sharing: "restricted",
          createdAt: Date.now(),
        },
      ],
    } as AppSettings);

    vi.mocked(spaceService.scanSpaces).mockImplementation(async () => [
      makeMockSpace({
        absolutePath: sharedSpaceDir,
      }),
    ]);
    vi.mocked(spaceService.readSpaceReadmeFrontmatter).mockResolvedValue({
      rebel_space_description: "Team space",
      sharing: "restricted",
    });
    vi.mocked(spaceService.getSpaceDisplayName).mockImplementation(
      (space: { displayName?: string; name: string }) => {
        return space.displayName ?? space.name;
      },
    );

    skillChangeNotificationService.attachManagedWriteObserver();
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.resetAllMocks();
    mockWarn.mockReset();
    mockError.mockReset();
    mockDebug.mockReset();
    mockTrackMainEvent.mockReset();
    mockAnonymousId.mockReset();
    mockAnonymousId.mockReturnValue("anon-test-id");
  });

  it("tracks shared skill creation with creator and skill metadata", async () => {
    const newSkillPath = path.join(
      sharedSpaceDir,
      "skills",
      "sales",
      "post-demo-followup",
      "SKILL.md",
    );

    await sharedSkillMutationService.writeManagedSkillFile(
      newSkillPath,
      "---\ntitle: Post Demo Followup\n---\n\nVersion one\n",
      workspaceDir,
      {
        kind: "human",
        user: {
          id: "alice",
          name: "Alice",
          email: "alice@example.com",
          image: null,
        },
      },
    );

    expect(mockTrackMainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        anonymousId: "anon-test-id",
        userId: "alice",
        event: "Skill Created",
        properties: expect.objectContaining({
          skillId: "team-space/skills/sales/post-demo-followup/SKILL.md",
          skillPath: "team-space/skills/sales/post-demo-followup/SKILL.md",
          skillSlug: "post-demo-followup",
          skillTitle: "Post Demo Followup",
          skillScope: "shared",
          source: "shared_skill_write",
          actorKind: "human",
          creatorId: "alice",
          creatorEmail: "alice@example.com",
          creatorName: "Alice",
          user_id: "alice",
          user_email: "alice@example.com",
          email: "alice@example.com",
        }),
      }),
    );
  });

  it("tracks agent-created shared skills even when there is no user for notifications", async () => {
    const newSkillPath = path.join(
      sharedSpaceDir,
      "skills",
      "operations",
      "agent-created-skill",
      "SKILL.md",
    );

    await sharedSkillMutationService.writeManagedSkillFile(
      newSkillPath,
      "---\ndescription: Agent-created skill\n---\n\nVersion one\n",
      workspaceDir,
      {
        kind: "agent",
        user: null,
      },
    );

    expect(mockTrackMainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        anonymousId: "anon-test-id",
        event: "Skill Created",
        properties: expect.objectContaining({
          skillId: "team-space/skills/operations/agent-created-skill/SKILL.md",
          skillSlug: "agent-created-skill",
          skillTitle: "Agent Created Skill",
          actorKind: "agent",
          creatorId: "rebel",
          creatorEmail: null,
        }),
      }),
    );
    expect(mockTrackMainEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        event: "Skill Created",
        userId: expect.any(String),
      }),
    );
    await expect(skillChangeNotificationService.listNotifications()).resolves.toHaveLength(0);
  });

  it("creates a notification for the previous human editor", async () => {
    mockGetCurrentUser.mockReturnValue({
      id: "alice",
      name: "Alice",
      email: "alice@example.com",
      image: null,
    });

    await sharedSkillMutationService.writeManagedSkillFile(
      sharedSkillPath,
      "---\ndescription: Demo skill\n---\n\nVersion one\n",
      workspaceDir,
      {
        kind: "human",
        user: {
          id: "alice",
          name: "Alice",
          email: "alice@example.com",
          image: null,
        },
      },
    );

    await sharedSkillMutationService.writeManagedSkillFile(
      sharedSkillPath,
      "---\ndescription: Demo skill\n---\n\nVersion two\n",
      workspaceDir,
      {
        kind: "human",
        user: { id: "bob", name: "Bob", email: "bob@example.com", image: null },
      },
    );

    const notifications =
      await skillChangeNotificationService.listNotifications();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      skillName: "demo-skill",
      actorLabel: "Bob",
      recipientReason: "previous_editor",
      skillWorkspacePath: "team-space/skills/operations/demo-skill/SKILL.md",
    });
  });

  it("tracks the responsible human through agent edits", async () => {
    await sharedSkillMutationService.writeManagedSkillFile(
      sharedSkillPath,
      "---\ndescription: Demo skill\n---\n\nVersion one\n",
      workspaceDir,
      {
        kind: "human",
        user: {
          id: "alice",
          name: "Alice",
          email: "alice@example.com",
          image: null,
        },
      },
    );

    await sharedSkillMutationService.writeManagedSkillFile(
      sharedSkillPath,
      "---\ndescription: Demo skill\n---\n\nVersion two\n",
      workspaceDir,
      {
        kind: "agent",
        user: { id: "bob", name: "Bob", email: "bob@example.com", image: null },
      },
    );

    mockGetCurrentUser.mockReturnValue({
      id: "bob",
      name: "Bob",
      email: "bob@example.com",
      image: null,
    });

    await sharedSkillMutationService.writeManagedSkillFile(
      sharedSkillPath,
      "---\ndescription: Demo skill\n---\n\nVersion three\n",
      workspaceDir,
      {
        kind: "human",
        user: {
          id: "charlie",
          name: "Charlie",
          email: "charlie@example.com",
          image: null,
        },
      },
    );

    const notifications =
      await skillChangeNotificationService.listNotifications();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      actorLabel: "Charlie",
      recipientReason: "previous_editor",
    });
  });

  it("dismisses notifications", async () => {
    mockGetCurrentUser.mockReturnValue({
      id: "alice",
      name: "Alice",
      email: "alice@example.com",
      image: null,
    });

    await sharedSkillMutationService.writeManagedSkillFile(
      sharedSkillPath,
      "---\ndescription: Demo skill\n---\n\nVersion one\n",
      workspaceDir,
      {
        kind: "human",
        user: {
          id: "alice",
          name: "Alice",
          email: "alice@example.com",
          image: null,
        },
      },
    );

    await sharedSkillMutationService.writeManagedSkillFile(
      sharedSkillPath,
      "---\ndescription: Demo skill\n---\n\nVersion two\n",
      workspaceDir,
      {
        kind: "human",
        user: { id: "bob", name: "Bob", email: "bob@example.com", image: null },
      },
    );

    const notifications =
      await skillChangeNotificationService.listNotifications();
    expect(notifications).toHaveLength(1);

    const dismissed = await skillChangeNotificationService.dismissNotification(
      notifications[0]!.id,
      notifications[0]!.spacePath,
    );
    expect(dismissed).toBe(true);

    const afterDismiss =
      await skillChangeNotificationService.listNotifications();
    expect(afterDismiss).toHaveLength(0);
  });

  it("updates the same unread notification instead of creating duplicates", async () => {
    mockGetCurrentUser.mockReturnValue({
      id: "alice",
      name: "Alice",
      email: "alice@example.com",
      image: null,
    });

    await sharedSkillMutationService.writeManagedSkillFile(
      sharedSkillPath,
      "---\ndescription: Demo skill\n---\n\nVersion one\n",
      workspaceDir,
      {
        kind: "human",
        user: {
          id: "alice",
          name: "Alice",
          email: "alice@example.com",
          image: null,
        },
      },
    );

    await sharedSkillMutationService.writeManagedSkillFile(
      sharedSkillPath,
      "---\ndescription: Demo skill\n---\n\nVersion two\n",
      workspaceDir,
      {
        kind: "human",
        user: { id: "bob", name: "Bob", email: "bob@example.com", image: null },
      },
    );

    const firstPass = await skillChangeNotificationService.listNotifications();
    expect(firstPass).toHaveLength(1);

    await sharedSkillMutationService.writeManagedSkillFile(
      sharedSkillPath,
      "---\ndescription: Demo skill\n---\n\nVersion three\n",
      workspaceDir,
      {
        kind: "human",
        user: { id: "bob", name: "Bob", email: "bob@example.com", image: null },
      },
    );

    const secondPass = await skillChangeNotificationService.listNotifications();
    expect(secondPass).toHaveLength(1);
    expect(secondPass[0]!.id).toBe(firstPass[0]!.id);
    expect(secondPass[0]!.actorLabel).toBe("Bob");
    expect(secondPass[0]!.updatedAt).toBeGreaterThanOrEqual(
      firstPass[0]!.updatedAt,
    );
  });

  it("lists and dismisses notifications written through source-backed spaces", async () => {
    const sourceSharedDir = path.join(workspaceDir, "source-team-space");
    const sourceSkillPath = path.join(
      sourceSharedDir,
      "skills",
      "operations",
      "demo-skill",
      "SKILL.md",
    );
    await fs.mkdir(path.dirname(sourceSkillPath), { recursive: true });
    await fs.writeFile(
      path.join(sourceSharedDir, "README.md"),
      "# Team Space Source",
      "utf8",
    );

    vi.mocked(spaceService.scanSpaces).mockImplementation(async () => [
      makeMockSpace({
        absolutePath: sharedSpaceDir,
        sourcePath: sourceSharedDir,
      }),
    ]);

    mockGetCurrentUser.mockReturnValue({
      id: "alice",
      name: "Alice",
      email: "alice@example.com",
      image: null,
    });

    await sharedSkillMutationService.writeManagedSkillFile(
      sourceSkillPath,
      "---\ndescription: Demo skill\n---\n\nVersion one\n",
      workspaceDir,
      {
        kind: "human",
        user: {
          id: "alice",
          name: "Alice",
          email: "alice@example.com",
          image: null,
        },
      },
    );

    await sharedSkillMutationService.writeManagedSkillFile(
      sourceSkillPath,
      "---\ndescription: Demo skill\n---\n\nVersion two\n",
      workspaceDir,
      {
        kind: "human",
        user: { id: "bob", name: "Bob", email: "bob@example.com", image: null },
      },
    );

    const notifications =
      await skillChangeNotificationService.listNotifications();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.spacePath).toBe("team-space");

    const dismissed = await skillChangeNotificationService.dismissNotification(
      notifications[0]!.id,
      notifications[0]!.spacePath,
    );
    expect(dismissed).toBe(true);
  });

  it("dedupes duplicate logical notifications across roots and dismisses all siblings together", async () => {
    const sourceSharedDir = path.join(workspaceDir, "source-team-space");
    const sourceNotificationsDir = path.join(
      sourceSharedDir,
      ".rebel",
      "history",
      "skill-notifications",
    );
    const logicalNotificationsDir = path.join(
      sharedSpaceDir,
      ".rebel",
      "history",
      "skill-notifications",
    );
    await fs.mkdir(sourceNotificationsDir, { recursive: true });
    await fs.mkdir(logicalNotificationsDir, { recursive: true });
    await fs.writeFile(
      path.join(sourceSharedDir, "README.md"),
      "# Team Space Source",
      "utf8",
    );

    vi.mocked(spaceService.scanSpaces).mockImplementation(async () => [
      makeMockSpace({
        absolutePath: sharedSpaceDir,
        sourcePath: sourceSharedDir,
      }),
    ]);
    mockGetCurrentUser.mockReturnValue({
      id: "alice",
      name: "Alice",
      email: "alice@example.com",
      image: null,
    });

    const olderRecord = {
      rebelSkillNotification: 1 as const,
      id: "11111111-1111-4111-8111-111111111111",
      skillName: "demo-skill",
      skillWorkspacePath: "team-space/skills/operations/demo-skill/SKILL.md",
      spacePath: "team-space",
      recipientUserId: "alice",
      recipientEmail: "alice@example.com",
      recipientReason: "previous_editor" as const,
      actorLabel: "Bob",
      actorKind: "human" as const,
      createdAt: 100,
      updatedAt: 200,
    };
    const newerRecord = {
      ...olderRecord,
      id: "22222222-2222-4222-8222-222222222222",
      actorLabel: "Charlie",
      createdAt: 300,
      updatedAt: 400,
    };

    await fs.writeFile(
      path.join(logicalNotificationsDir, `${olderRecord.id}.json`),
      JSON.stringify(olderRecord, null, 2),
      "utf8",
    );
    await fs.writeFile(
      path.join(sourceNotificationsDir, `${newerRecord.id}.json`),
      JSON.stringify(newerRecord, null, 2),
      "utf8",
    );

    const notifications =
      await skillChangeNotificationService.listNotifications();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      id: newerRecord.id,
      actorLabel: "Charlie",
      skillWorkspacePath: newerRecord.skillWorkspacePath,
    });

    const dismissed = await skillChangeNotificationService.dismissNotification(
      notifications[0]!.id,
      notifications[0]!.spacePath,
    );
    expect(dismissed).toBe(true);

    await expect(
      skillChangeNotificationService.listNotifications(),
    ).resolves.toHaveLength(0);

    const oldStored = JSON.parse(
      await fs.readFile(
        path.join(logicalNotificationsDir, `${olderRecord.id}.json`),
        "utf8",
      ),
    ) as { dismissedAt?: number };
    const newStored = JSON.parse(
      await fs.readFile(
        path.join(sourceNotificationsDir, `${newerRecord.id}.json`),
        "utf8",
      ),
    ) as { dismissedAt?: number };
    expect(typeof oldStored.dismissedAt).toBe("number");
    expect(typeof newStored.dismissedAt).toBe("number");
  });

  it("keeps trusted creator fallback notifications for legacy skills without edit history", async () => {
    mockGetCurrentUser.mockReturnValue({
      id: "alice",
      name: "Alice",
      email: "alice@example.com",
      image: null,
    });

    await fs.writeFile(
      sharedSkillPath,
      [
        "---",
        "description: Demo skill",
        "author: Alice",
        "author_id: alice",
        "author_email: alice@example.com",
        "author_source: created",
        "---",
        "",
        "Version one",
        "",
      ].join("\n"),
      "utf8",
    );

    await sharedSkillMutationService.writeManagedSkillFile(
      sharedSkillPath,
      "---\ndescription: Demo skill\nauthor: Alice\nauthor_id: alice\nauthor_email: alice@example.com\nauthor_source: created\n---\n\nVersion two\n",
      workspaceDir,
      {
        kind: "human",
        user: { id: "bob", name: "Bob", email: "bob@example.com", image: null },
      },
    );

    const notifications =
      await skillChangeNotificationService.listNotifications();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      actorLabel: "Bob",
      recipientReason: "creator_fallback",
    });
  });

  it("skips creator fallback notifications when authorship metadata is untrusted", async () => {
    mockGetCurrentUser.mockReturnValue({
      id: "alice",
      name: "Alice",
      email: "alice@example.com",
      image: null,
    });

    await fs.writeFile(
      sharedSkillPath,
      [
        "---",
        "description: Demo skill",
        "author: Alice",
        "author_id: alice",
        "author_email: alice@example.com",
        "---",
        "",
        "Version one",
        "",
      ].join("\n"),
      "utf8",
    );

    await sharedSkillMutationService.writeManagedSkillFile(
      sharedSkillPath,
      "---\ndescription: Demo skill\nauthor: Alice\nauthor_id: alice\nauthor_email: alice@example.com\n---\n\nVersion two\n",
      workspaceDir,
      {
        kind: "human",
        user: { id: "bob", name: "Bob", email: "bob@example.com", image: null },
      },
    );

    await expect(
      skillChangeNotificationService.listNotifications(),
    ).resolves.toHaveLength(0);
  });

  it("skips creator fallback notifications when authorship was inferred via migration", async () => {
    mockGetCurrentUser.mockReturnValue({
      id: "alice",
      name: "Alice",
      email: "alice@example.com",
      image: null,
    });

    await fs.writeFile(
      sharedSkillPath,
      [
        "---",
        "description: Demo skill",
        "author: Alice",
        "author_id: alice",
        "author_email: alice@example.com",
        "author_source: migrated",
        "---",
        "",
        "Version one",
        "",
      ].join("\n"),
      "utf8",
    );

    await sharedSkillMutationService.writeManagedSkillFile(
      sharedSkillPath,
      "---\ndescription: Demo skill\nauthor: Alice\nauthor_id: alice\nauthor_email: alice@example.com\nauthor_source: migrated\n---\n\nVersion two\n",
      workspaceDir,
      {
        kind: "human",
        user: { id: "bob", name: "Bob", email: "bob@example.com", image: null },
      },
    );

    await expect(
      skillChangeNotificationService.listNotifications(),
    ).resolves.toHaveLength(0);
  });

  it("skips previous_editor notifications when only legacy last_modified_by_* metadata is present", async () => {
    // Regression: FOX-3052. Pre-fix, `resolveRecipientCandidate` fell back to
    // `last_modified_by_id/email` when `last_responsible_human_*` was absent.
    // That routed notifications based on untrusted inherited metadata and
    // could pair a userId from one source with an email from another,
    // producing mixed-identity records that matched unrelated users via
    // `matchesRecipient`'s OR-match.
    mockGetCurrentUser.mockReturnValue({
      id: "alice",
      name: "Alice",
      email: "alice@example.com",
      image: null,
    });

    await fs.writeFile(
      sharedSkillPath,
      [
        "---",
        "description: Demo skill",
        // Legacy skill: mismatched last_modified_by_id and last_modified_by_email
        // (the exact scenario that produced Frankenstein recipients pre-fix).
        "last_modified_by_id: ghost-user",
        "last_modified_by_email: unrelated@example.com",
        "---",
        "",
        "Legacy content",
        "",
      ].join("\n"),
      "utf8",
    );

    await sharedSkillMutationService.writeManagedSkillFile(
      sharedSkillPath,
      "---\ndescription: Demo skill\n---\n\nVersion two\n",
      workspaceDir,
      {
        kind: "human",
        user: { id: "bob", name: "Bob", email: "bob@example.com", image: null },
      },
    );

    await expect(
      skillChangeNotificationService.listNotifications(),
    ).resolves.toHaveLength(0);
  });

  it("heals stale mixed-identity recipient fields on the next managed write", async () => {
    // Regression: FOX-3052. Records written by the pre-fix code path could
    // persist with `recipientUserId` and `recipientEmail` belonging to
    // different people. On the next managed write for the same skill, the
    // existing record must be refreshed with the freshly resolved, coherent
    // identity rather than carrying the old mixed fields forward.
    const notificationsDir = path.join(
      sharedSpaceDir,
      ".rebel",
      "history",
      "skill-notifications",
    );
    await fs.mkdir(notificationsDir, { recursive: true });

    const staleId = "99999999-9999-4999-8999-999999999999";
    const staleRecord = {
      rebelSkillNotification: 1 as const,
      id: staleId,
      skillName: "demo-skill",
      skillWorkspacePath: "team-space/skills/operations/demo-skill/SKILL.md",
      spacePath: "team-space",
      // Frankenstein identity: id belongs to alice, email belongs to an
      // unrelated user. Pre-fix write path could produce this.
      recipientUserId: "alice",
      recipientEmail: "unrelated@example.com",
      recipientReason: "previous_editor" as const,
      actorLabel: "Previous Actor",
      actorKind: "human" as const,
      createdAt: 100,
      updatedAt: 200,
    };
    await fs.writeFile(
      path.join(notificationsDir, `${staleId}.json`),
      JSON.stringify(staleRecord, null, 2),
      "utf8",
    );

    // Set up the skill with coherent last_responsible_human_* metadata so the
    // next managed write resolves a clean recipient for alice.
    await fs.writeFile(
      sharedSkillPath,
      [
        "---",
        "description: Demo skill",
        "last_responsible_human_id: alice",
        "last_responsible_human_email: alice@example.com",
        "---",
        "",
        "Current content",
        "",
      ].join("\n"),
      "utf8",
    );

    // Bob edits the skill. Previous editor (from frontmatter) is alice.
    await sharedSkillMutationService.writeManagedSkillFile(
      sharedSkillPath,
      "---\ndescription: Demo skill\n---\n\nBob's edit\n",
      workspaceDir,
      {
        kind: "human",
        user: { id: "bob", name: "Bob", email: "bob@example.com", image: null },
      },
    );

    const stored = JSON.parse(
      await fs.readFile(
        path.join(notificationsDir, `${staleId}.json`),
        "utf8",
      ),
    ) as {
      recipientUserId: string | null;
      recipientEmail: string | null;
    };

    expect(stored.recipientUserId).toBe("alice");
    expect(stored.recipientEmail).toBe("alice@example.com");

    // The unrelated user must no longer see this notification.
    mockGetCurrentUser.mockReturnValue({
      id: "unrelated",
      name: "Unrelated",
      email: "unrelated@example.com",
      image: null,
    });
    await expect(
      skillChangeNotificationService.listNotifications(),
    ).resolves.toHaveLength(0);

    // The intended recipient (alice) still sees it.
    mockGetCurrentUser.mockReturnValue({
      id: "alice",
      name: "Alice",
      email: "alice@example.com",
      image: null,
    });
    const forAlice = await skillChangeNotificationService.listNotifications();
    expect(forAlice).toHaveLength(1);
    expect(forAlice[0]?.id).toBe(staleId);
  });

  it("prefers recipient user id over mismatched email on stale records", async () => {
    const notificationsDir = path.join(
      sharedSpaceDir,
      ".rebel",
      "history",
      "skill-notifications",
    );
    await fs.mkdir(notificationsDir, { recursive: true });

    const staleId = "88888888-8888-4888-8888-888888888888";
    await fs.writeFile(
      path.join(notificationsDir, `${staleId}.json`),
      JSON.stringify(
        {
          rebelSkillNotification: 1,
          id: staleId,
          skillName: "demo-skill",
          skillWorkspacePath: "team-space/skills/operations/demo-skill/SKILL.md",
          spacePath: "team-space",
          recipientUserId: "bob",
          recipientEmail: "alice@example.com",
          recipientReason: "previous_editor",
          actorLabel: "Charlie",
          actorKind: "human",
          createdAt: 100,
          updatedAt: 200,
        },
        null,
        2,
      ),
      "utf8",
    );

    mockGetCurrentUser.mockReturnValue({
      id: "alice",
      name: "Alice",
      email: "alice@example.com",
      image: null,
    });
    await expect(
      skillChangeNotificationService.listNotifications(),
    ).resolves.toHaveLength(0);

    mockGetCurrentUser.mockReturnValue({
      id: "bob",
      name: "Bob",
      email: "bob@example.com",
      image: null,
    });
    const forBob = await skillChangeNotificationService.listNotifications();
    expect(forBob).toHaveLength(1);
    expect(forBob[0]?.id).toBe(staleId);
  });

  it("does not route notifications through stale previous-editor email after an incomplete human write", async () => {
    await fs.writeFile(
      sharedSkillPath,
      [
        "---",
        "description: Demo skill",
        "last_responsible_human_by: Alice",
        "last_responsible_human_id: alice",
        "last_responsible_human_email: alice@example.com",
        "---",
        "",
        "Version one",
        "",
      ].join("\n"),
      "utf8",
    );

    await sharedSkillMutationService.writeManagedSkillFile(
      sharedSkillPath,
      "---\ndescription: Demo skill\n---\n\nVersion two\n",
      workspaceDir,
      {
        kind: "human",
        user: {
          id: "bob",
          name: "Bob",
          email: "",
          image: null,
        },
      },
    );

    mockGetCurrentUser.mockReturnValue({
      id: "alice",
      name: "Alice",
      email: "alice@example.com",
      image: null,
    });
    const aliceNotification =
      await skillChangeNotificationService.listNotifications();
    expect(aliceNotification).toHaveLength(1);
    expect(aliceNotification[0]?.actorLabel).toBe("Bob");
    await expect(
      skillChangeNotificationService.dismissNotification(
        aliceNotification[0]!.id,
        aliceNotification[0]!.spacePath,
      ),
    ).resolves.toBe(true);

    await sharedSkillMutationService.writeManagedSkillFile(
      sharedSkillPath,
      "---\ndescription: Demo skill\n---\n\nVersion three\n",
      workspaceDir,
      {
        kind: "human",
        user: {
          id: "charlie",
          name: "Charlie",
          email: "charlie@example.com",
          image: null,
        },
      },
    );

    await expect(
      skillChangeNotificationService.listNotifications(),
    ).resolves.toHaveLength(0);

    mockGetCurrentUser.mockReturnValue({
      id: "bob",
      name: "Bob",
      email: "bob@example.com",
      image: null,
    });
    await expect(
      skillChangeNotificationService.listNotifications(),
    ).resolves.toHaveLength(0);
  });

  it("prunes dismissed notifications older than 30 days when a later dismissal triggers cleanup", async () => {
    let currentTime = new Date("2026-03-28T09:00:00.000Z").getTime();
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => currentTime);
    const advanceClockByHours = (hours: number) => {
      currentTime += hours * 60 * 60 * 1000;
    };

    const waitForFileRemoval = async (filePath: string): Promise<void> => {
      for (let attempt = 0; attempt < 25; attempt += 1) {
        try {
          await fs.access(filePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return;
          }
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      throw new Error(`Timed out waiting for ${filePath} to be removed`);
    };

    mockGetCurrentUser.mockReturnValue({
      id: "alice",
      name: "Alice",
      email: "alice@example.com",
      image: null,
    });

    const notificationsDir = path.join(
      sharedSpaceDir,
      ".rebel",
      "history",
      "skill-notifications",
    );
    const aliceActor = {
      kind: "human" as const,
      user: {
        id: "alice",
        name: "Alice",
        email: "alice@example.com",
        image: null,
      },
    };
    const bobActor = {
      kind: "human" as const,
      user: { id: "bob", name: "Bob", email: "bob@example.com", image: null },
    };
    const createNotification = async (skillName: string) => {
      const nextSkillPath = path.join(
        sharedSpaceDir,
        "skills",
        "operations",
        skillName,
        "SKILL.md",
      );
      await fs.mkdir(path.dirname(nextSkillPath), { recursive: true });

      await sharedSkillMutationService.writeManagedSkillFile(
        nextSkillPath,
        "---\ndescription: Demo skill\n---\n\nVersion one\n",
        workspaceDir,
        aliceActor,
      );

      await sharedSkillMutationService.writeManagedSkillFile(
        nextSkillPath,
        "---\ndescription: Demo skill\n---\n\nVersion two\n",
        workspaceDir,
        bobActor,
      );

      const notifications =
        await skillChangeNotificationService.listNotifications();
      expect(notifications).toHaveLength(1);
      return notifications[0]!;
    };

    const oldNotification = await createNotification("old-demo-skill");
    expect(
      await skillChangeNotificationService.dismissNotification(
        oldNotification.id,
        oldNotification.spacePath,
      ),
    ).toBe(true);

    advanceClockByHours(2);

    const recentNotification = await createNotification("recent-demo-skill");
    expect(
      await skillChangeNotificationService.dismissNotification(
        recentNotification.id,
        recentNotification.spacePath,
      ),
    ).toBe(true);

    // Let fire-and-forget prune from the dismiss above settle before manipulating files.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const oldNotificationPath = path.join(
      notificationsDir,
      `${oldNotification.id}.json`,
    );
    const recentNotificationPath = path.join(
      notificationsDir,
      `${recentNotification.id}.json`,
    );
    const oldRecord = JSON.parse(
      await fs.readFile(oldNotificationPath, "utf8"),
    ) as Record<string, unknown>;
    const staleDismissedAt = Date.now() - 31 * 24 * 60 * 60 * 1000;

    await fs.writeFile(
      oldNotificationPath,
      JSON.stringify(
        {
          ...oldRecord,
          dismissedAt: staleDismissedAt,
          updatedAt: staleDismissedAt,
        },
        null,
        2,
      ),
      "utf8",
    );

    await expect(fs.access(oldNotificationPath)).resolves.toBeUndefined();
    await expect(fs.access(recentNotificationPath)).resolves.toBeUndefined();

    advanceClockByHours(2);

    const triggerNotification = await createNotification("trigger-demo-skill");
    expect(
      await skillChangeNotificationService.dismissNotification(
        triggerNotification.id,
        triggerNotification.spacePath,
      ),
    ).toBe(true);

    await waitForFileRemoval(oldNotificationPath);

    await expect(fs.access(recentNotificationPath)).resolves.toBeUndefined();
    nowSpy.mockRestore();
  });

  it("dismisses notification when spacePath doesn't match any current space", async () => {
    mockGetCurrentUser.mockReturnValue({
      id: "alice",
      name: "Alice",
      email: "alice@example.com",
      image: null,
    });

    await sharedSkillMutationService.writeManagedSkillFile(
      sharedSkillPath,
      "---\ndescription: Demo skill\n---\n\nVersion one\n",
      workspaceDir,
      {
        kind: "human",
        user: {
          id: "alice",
          name: "Alice",
          email: "alice@example.com",
          image: null,
        },
      },
    );

    await sharedSkillMutationService.writeManagedSkillFile(
      sharedSkillPath,
      "---\ndescription: Demo skill\n---\n\nVersion two\n",
      workspaceDir,
      {
        kind: "human",
        user: { id: "bob", name: "Bob", email: "bob@example.com", image: null },
      },
    );

    const notifications =
      await skillChangeNotificationService.listNotifications();
    expect(notifications).toHaveLength(1);

    // Simulate space rename: scanSpaces still returns the same physical path
    // but the space.path has changed — dismiss uses the OLD spacePath from the notification
    const dismissed = await skillChangeNotificationService.dismissNotification(
      notifications[0]!.id,
      "old-team-space", // stale path that no longer matches any space.path
    );
    expect(dismissed).toBe(true);

    const afterDismiss =
      await skillChangeNotificationService.listNotifications();
    expect(afterDismiss).toHaveLength(0);
  });

  it("dismisses notification when spacePath is omitted", async () => {
    mockGetCurrentUser.mockReturnValue({
      id: "alice",
      name: "Alice",
      email: "alice@example.com",
      image: null,
    });

    await sharedSkillMutationService.writeManagedSkillFile(
      sharedSkillPath,
      "---\ndescription: Demo skill\n---\n\nVersion one\n",
      workspaceDir,
      {
        kind: "human",
        user: {
          id: "alice",
          name: "Alice",
          email: "alice@example.com",
          image: null,
        },
      },
    );

    await sharedSkillMutationService.writeManagedSkillFile(
      sharedSkillPath,
      "---\ndescription: Demo skill\n---\n\nVersion two\n",
      workspaceDir,
      {
        kind: "human",
        user: { id: "bob", name: "Bob", email: "bob@example.com", image: null },
      },
    );

    const notifications =
      await skillChangeNotificationService.listNotifications();
    expect(notifications).toHaveLength(1);

    const dismissed = await skillChangeNotificationService.dismissNotification(
      notifications[0]!.id,
    );
    expect(dismissed).toBe(true);

    const afterDismiss =
      await skillChangeNotificationService.listNotifications();
    expect(afterDismiss).toHaveLength(0);
  });

  it("listNotifications returns current space path, not stale record path", async () => {
    mockGetCurrentUser.mockReturnValue({
      id: "alice",
      name: "Alice",
      email: "alice@example.com",
      image: null,
    });

    // Write a notification record directly with a stale spacePath
    const notificationsDir = path.join(
      sharedSpaceDir,
      ".rebel",
      "history",
      "skill-notifications",
    );
    await fs.mkdir(notificationsDir, { recursive: true });

    const staleRecord = {
      rebelSkillNotification: 1 as const,
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      skillName: "demo-skill",
      skillWorkspacePath:
        "old-team-space/skills/operations/demo-skill/SKILL.md",
      spacePath: "old-team-space",
      recipientUserId: "alice",
      recipientEmail: "alice@example.com",
      recipientReason: "previous_editor" as const,
      actorLabel: "Bob",
      actorKind: "human" as const,
      createdAt: 100,
      updatedAt: 200,
    };
    await fs.writeFile(
      path.join(notificationsDir, `${staleRecord.id}.json`),
      JSON.stringify(staleRecord, null, 2),
      "utf8",
    );

    const notifications =
      await skillChangeNotificationService.listNotifications();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      spacePath: "team-space",
      skillWorkspacePath:
        "team-space/skills/operations/demo-skill/SKILL.md",
    });
  });

  it("auto-dismisses notifications where skill file no longer exists", async () => {
    mockGetCurrentUser.mockReturnValue({
      id: "alice",
      name: "Alice",
      email: "alice@example.com",
      image: null,
    });

    await sharedSkillMutationService.writeManagedSkillFile(
      sharedSkillPath,
      "---\ndescription: Demo skill\n---\n\nVersion one\n",
      workspaceDir,
      {
        kind: "human",
        user: {
          id: "alice",
          name: "Alice",
          email: "alice@example.com",
          image: null,
        },
      },
    );

    await sharedSkillMutationService.writeManagedSkillFile(
      sharedSkillPath,
      "---\ndescription: Demo skill\n---\n\nVersion two\n",
      workspaceDir,
      {
        kind: "human",
        user: { id: "bob", name: "Bob", email: "bob@example.com", image: null },
      },
    );

    // Verify notification exists before deleting skill
    let notifications =
      await skillChangeNotificationService.listNotifications();
    expect(notifications).toHaveLength(1);
    const notificationId = notifications[0]!.id;

    // Delete the skill file from disk
    await fs.unlink(sharedSkillPath);

    // listNotifications should auto-dismiss and return empty
    notifications = await skillChangeNotificationService.listNotifications();
    expect(notifications).toHaveLength(0);

    // Verify the notification JSON file has dismissedAt set
    const notificationsDir = path.join(
      sharedSpaceDir,
      ".rebel",
      "history",
      "skill-notifications",
    );
    const notificationFile = path.join(
      notificationsDir,
      `${notificationId}.json`,
    );
    const stored = JSON.parse(
      await fs.readFile(notificationFile, "utf8"),
    ) as { dismissedAt?: number };
    expect(typeof stored.dismissedAt).toBe("number");
  });

  it("does not auto-dismiss when fs.access fails with non-ENOENT error", async () => {
    mockGetCurrentUser.mockReturnValue({
      id: "alice",
      name: "Alice",
      email: "alice@example.com",
      image: null,
    });

    await sharedSkillMutationService.writeManagedSkillFile(
      sharedSkillPath,
      "---\ndescription: Demo skill\n---\n\nVersion one\n",
      workspaceDir,
      {
        kind: "human",
        user: {
          id: "alice",
          name: "Alice",
          email: "alice@example.com",
          image: null,
        },
      },
    );

    await sharedSkillMutationService.writeManagedSkillFile(
      sharedSkillPath,
      "---\ndescription: Demo skill\n---\n\nVersion two\n",
      workspaceDir,
      {
        kind: "human",
        user: { id: "bob", name: "Bob", email: "bob@example.com", image: null },
      },
    );

    // Mock fs.access to throw EACCES instead of ENOENT
    const originalAccess = fs.access;
    const accessSpy = vi.spyOn(fs, "access").mockImplementation(
      async (filePath, ...args) => {
        const fileStr = typeof filePath === "string" ? filePath : filePath.toString();
        if (fileStr.includes("SKILL.md")) {
          const error = new Error("Permission denied") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
        return originalAccess(filePath, ...args);
      },
    );

    // Notification should still be returned (fail closed — assume file exists)
    const notifications =
      await skillChangeNotificationService.listNotifications();
    expect(notifications).toHaveLength(1);

    accessSpy.mockRestore();
  });

  it("dismiss via fallback scan also dismisses siblings", async () => {
    mockGetCurrentUser.mockReturnValue({
      id: "alice",
      name: "Alice",
      email: "alice@example.com",
      image: null,
    });

    // Manually create two notification records with the same skillWorkspacePath
    const notificationsDir = path.join(
      sharedSpaceDir,
      ".rebel",
      "history",
      "skill-notifications",
    );
    await fs.mkdir(notificationsDir, { recursive: true });

    const baseRecord = {
      rebelSkillNotification: 1 as const,
      skillName: "demo-skill",
      skillWorkspacePath: "team-space/skills/operations/demo-skill/SKILL.md",
      spacePath: "team-space",
      recipientUserId: "alice",
      recipientEmail: "alice@example.com",
      recipientReason: "previous_editor" as const,
      actorKind: "human" as const,
      createdAt: 100,
      updatedAt: 200,
    };

    const record1 = {
      ...baseRecord,
      id: "11111111-1111-4111-8111-111111111111",
      actorLabel: "Bob",
    };
    const record2 = {
      ...baseRecord,
      id: "22222222-2222-4222-8222-222222222222",
      actorLabel: "Charlie",
      createdAt: 300,
      updatedAt: 400,
    };

    await fs.writeFile(
      path.join(notificationsDir, `${record1.id}.json`),
      JSON.stringify(record1, null, 2),
      "utf8",
    );
    await fs.writeFile(
      path.join(notificationsDir, `${record2.id}.json`),
      JSON.stringify(record2, null, 2),
      "utf8",
    );

    // Dismiss using a stale spacePath (fallback scan will activate)
    const dismissed = await skillChangeNotificationService.dismissNotification(
      record1.id,
      "old-team-space", // doesn't match current space.path
    );
    expect(dismissed).toBe(true);

    // Both should be dismissed (siblings with same skillWorkspacePath)
    const stored1 = JSON.parse(
      await fs.readFile(
        path.join(notificationsDir, `${record1.id}.json`),
        "utf8",
      ),
    ) as { dismissedAt?: number };
    const stored2 = JSON.parse(
      await fs.readFile(
        path.join(notificationsDir, `${record2.id}.json`),
        "utf8",
      ),
    ) as { dismissedAt?: number };

    expect(typeof stored1.dismissedAt).toBe("number");
    expect(typeof stored2.dismissedAt).toBe("number");
  });

  it("emits FileLocation for newly created notifications", async () => {
    mockGetCurrentUser.mockReturnValue({
      id: "alice",
      name: "Alice",
      email: "alice@example.com",
      image: null,
    });

    await sharedSkillMutationService.writeManagedSkillFile(
      sharedSkillPath,
      "---\ndescription: Demo skill\n---\n\nVersion one\n",
      workspaceDir,
      {
        kind: "human",
        user: {
          id: "alice",
          name: "Alice",
          email: "alice@example.com",
          image: null,
        },
      },
    );

    await sharedSkillMutationService.writeManagedSkillFile(
      sharedSkillPath,
      "---\ndescription: Demo skill\n---\n\nVersion two\n",
      workspaceDir,
      {
        kind: "human",
        user: { id: "bob", name: "Bob", email: "bob@example.com", image: null },
      },
    );

    const notifications = await skillChangeNotificationService.listNotifications();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.location).toMatchObject({
      kind: "in-space",
      workspaceRelativePath: "team-space/skills/operations/demo-skill/SKILL.md",
      fileName: "SKILL.md",
    });
  });

  it("refuses to persist notifications when fileLocationFromSkillTarget degrades to legacy-missing-location", async () => {
    const event = {
      target: {
        absolutePath: "",
        relativePath: "",
        sharing: "restricted" as const,
        spaceName: "",
        spacePath: "",
        spaceAbsolutePath: sharedSpaceDir,
        shape: "file" as const,
      },
      previousContent: [
        "---",
        "last_responsible_human_id: alice",
        "last_responsible_human_email: alice@example.com",
        "---",
        "Previous content",
      ].join("\n"),
      nextContent: "Updated content",
      actor: {
        kind: "human" as const,
        user: {
          id: "bob",
          name: "Bob",
          email: "bob@example.com",
          image: null,
        },
      },
    };

    await (
      skillChangeNotificationService as unknown as {
        onManagedSharedSkillWrite: (input: typeof event) => Promise<void>;
      }
    ).onManagedSharedSkillWrite(event);

    const notificationsDir = path.join(
      sharedSpaceDir,
      ".rebel",
      "history",
      "skill-notifications",
    );
    await expect(fs.readdir(notificationsDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(mockError).toHaveBeenCalledWith(
      { target: event.target },
      "Refusing to persist skill change notification with legacy-missing-location variant — fails Invariant #14",
    );
  });

  it("projects missing persisted notification location on read", async () => {
    mockGetCurrentUser.mockReturnValue({
      id: "alice",
      name: "Alice",
      email: "alice@example.com",
      image: null,
    });

    const notificationsDir = path.join(
      sharedSpaceDir,
      ".rebel",
      "history",
      "skill-notifications",
    );
    await fs.mkdir(notificationsDir, { recursive: true });

    const recordWithoutLocation = {
      rebelSkillNotification: 1 as const,
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      skillName: "demo-skill",
      skillWorkspacePath: "team-space/skills/operations/demo-skill/SKILL.md",
      spacePath: "team-space",
      recipientUserId: "alice",
      recipientEmail: "alice@example.com",
      recipientReason: "previous_editor" as const,
      actorLabel: "Bob",
      actorKind: "human" as const,
      createdAt: 100,
      updatedAt: 200,
    };
    await fs.writeFile(
      path.join(notificationsDir, `${recordWithoutLocation.id}.json`),
      JSON.stringify(recordWithoutLocation, null, 2),
      "utf8",
    );

    const notifications = await skillChangeNotificationService.listNotifications();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.location).toMatchObject({
      kind: "in-space",
      workspaceRelativePath: "team-space/skills/operations/demo-skill/SKILL.md",
      fileName: "SKILL.md",
    });
  });

  it("does not write notification records during read-time location projection", async () => {
    mockGetCurrentUser.mockReturnValue({
      id: "alice",
      name: "Alice",
      email: "alice@example.com",
      image: null,
    });

    const writeAtomicSpy = vi.spyOn(atomicFs, "writeFileAtomic");
    const notificationsDir = path.join(
      sharedSpaceDir,
      ".rebel",
      "history",
      "skill-notifications",
    );
    await fs.mkdir(notificationsDir, { recursive: true });

    const recordWithoutLocation = {
      rebelSkillNotification: 1 as const,
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      skillName: "demo-skill",
      skillWorkspacePath: "team-space/skills/operations/demo-skill/SKILL.md",
      spacePath: "team-space",
      recipientUserId: "alice",
      recipientEmail: "alice@example.com",
      recipientReason: "previous_editor" as const,
      actorLabel: "Bob",
      actorKind: "human" as const,
      createdAt: 100,
      updatedAt: 200,
    };
    await fs.writeFile(
      path.join(notificationsDir, `${recordWithoutLocation.id}.json`),
      JSON.stringify(recordWithoutLocation, null, 2),
      "utf8",
    );

    const notifications = await skillChangeNotificationService.listNotifications();
    expect(notifications).toHaveLength(1);
    expect(writeAtomicSpy).not.toHaveBeenCalled();
  });

  it("recomputes read-time notification location from current space paths instead of trusting stale stored location", async () => {
    mockGetCurrentUser.mockReturnValue({
      id: "alice",
      name: "Alice",
      email: "alice@example.com",
      image: null,
    });

    vi.mocked(spaceService.scanSpaces).mockImplementation(async () => [
      makeMockSpace({
        path: "renamed-team-space",
        absolutePath: sharedSpaceDir,
      }),
    ]);

    const notificationsDir = path.join(
      sharedSpaceDir,
      ".rebel",
      "history",
      "skill-notifications",
    );
    await fs.mkdir(notificationsDir, { recursive: true });

    const recordWithStaleLocation = {
      rebelSkillNotification: 1 as const,
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      skillName: "demo-skill",
      skillWorkspacePath: "team-space/skills/operations/demo-skill/SKILL.md",
      spacePath: "team-space",
      location: {
        kind: "in-space" as const,
        spaceName: "Team Space",
        spaceWorkspacePath: "team-space",
        spaceRelativePath: "skills/operations/demo-skill/SKILL.md",
        workspaceRelativePath: "team-space/skills/operations/demo-skill/SKILL.md",
        fileName: "SKILL.md",
        absolutePath: path.join(
          workspaceDir,
          "team-space",
          "skills",
          "operations",
          "demo-skill",
          "SKILL.md",
        ),
      },
      recipientUserId: "alice",
      recipientEmail: "alice@example.com",
      recipientReason: "previous_editor" as const,
      actorLabel: "Bob",
      actorKind: "human" as const,
      createdAt: 100,
      updatedAt: 200,
    };
    await fs.writeFile(
      path.join(notificationsDir, `${recordWithStaleLocation.id}.json`),
      JSON.stringify(recordWithStaleLocation, null, 2),
      "utf8",
    );

    const notifications = await skillChangeNotificationService.listNotifications();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      spacePath: "renamed-team-space",
      location: {
        kind: "in-space",
        spaceWorkspacePath: "renamed-team-space",
        workspaceRelativePath:
          "renamed-team-space/skills/operations/demo-skill/SKILL.md",
      },
    });
  });

  it("keeps non-empty skillName when notifications include FileLocation", async () => {
    mockGetCurrentUser.mockReturnValue({
      id: "alice",
      name: "Alice",
      email: "alice@example.com",
      image: null,
    });

    await sharedSkillMutationService.writeManagedSkillFile(
      sharedSkillPath,
      "---\ndescription: Demo skill\n---\n\nVersion one\n",
      workspaceDir,
      {
        kind: "human",
        user: {
          id: "alice",
          name: "Alice",
          email: "alice@example.com",
          image: null,
        },
      },
    );

    await sharedSkillMutationService.writeManagedSkillFile(
      sharedSkillPath,
      "---\ndescription: Demo skill\n---\n\nVersion two\n",
      workspaceDir,
      {
        kind: "human",
        user: { id: "bob", name: "Bob", email: "bob@example.com", image: null },
      },
    );

    const notifications = await skillChangeNotificationService.listNotifications();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.skillName.trim().length).toBeGreaterThan(0);
  });
});
