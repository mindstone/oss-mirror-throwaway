import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  buildLiveApiKeysOutputPath,
  captureLiveApiKeys,
  parseLiveApiCliArgs,
} from "../capture-live-api-keys";
import { fingerprintValue } from "../eval/capture-keys";

const tempDirs: string[] = [];
const actualRepoEnvPath = buildLiveApiKeysOutputPath(process.cwd());

function makeTempDir(prefix = "capture-live-api-keys-test-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function liveEnvPath(repoRoot: string): string {
  return buildLiveApiKeysOutputPath(repoRoot);
}

function writeEvalsKeysEnv(repoRoot: string, contents: string): void {
  const keysEnvDir = path.join(repoRoot, "evals", "configs", ".local");
  fs.mkdirSync(keysEnvDir, { recursive: true });
  fs.writeFileSync(path.join(keysEnvDir, "keys.env"), contents, "utf8");
}

function assertNotActualRepoEnvPath(target: fs.PathLike): void {
  const resolvedPath = path.resolve(String(target));
  if (resolvedPath === actualRepoEnvPath) {
    throw new Error(
      `Non-hermetic capture-live-api-keys test attempted to use the real repo ${path.basename(actualRepoEnvPath)}. Pass an explicit temp repoRoot.`,
    );
  }
}

function makeLogger(): {
  logs: string[];
  errors: string[];
  logger: { log: (message: string) => void; error: (message: string) => void };
} {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    logger: {
      log: (message: string) => {
        logs.push(message);
      },
      error: (message: string) => {
        errors.push(message);
      },
    },
  };
}

beforeAll(() => {
  const originalExistsSync = fs.existsSync.bind(fs);
  vi.spyOn(fs, "existsSync").mockImplementation((target) => {
    assertNotActualRepoEnvPath(target);
    return originalExistsSync(target);
  });
});

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      continue;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe("capture-live-api-keys", () => {
  it("renders TEST-prefixed live API keys and the legacy Claude alias", () => {
    const repoRoot = makeTempDir();
    const { logger } = makeLogger();

    const result = captureLiveApiKeys({
      appSettings: {
        claude: { apiKey: "anthropic-live-key" },
        providerKeys: {
          openai: "openai-live-key",
          openrouter: "openrouter-live-key",
          google: "google-key-ignored",
          together: "together-key-ignored",
          cerebras: "cerebras-key-ignored",
        },
      },
      repoRoot,
      logger,
    });

    expect(result.envFileContents).toBe(
      [
        "TEST_ANTHROPIC_API_KEY=anthropic-live-key",
        "TEST_CLAUDE_API_KEY=anthropic-live-key",
        "TEST_OPENAI_API_KEY=openai-live-key",
        "TEST_OPENROUTER_API_KEY=openrouter-live-key",
      ].join("\n") + "\n",
    );
    expect(result.envFileContents).not.toContain("GOOGLE_API_KEY");
    expect(result.envFileContents).not.toContain("TOGETHER_API_KEY");
    expect(result.envFileContents).not.toContain("CEREBRAS_API_KEY");
  });

  it("omits absent keys", () => {
    const repoRoot = makeTempDir();
    const { logger } = makeLogger();

    const result = captureLiveApiKeys({
      appSettings: {
        claude: { apiKey: "anthropic-live-key" },
        providerKeys: {},
      },
      repoRoot,
      logger,
    });

    expect(result.envFileContents).toBe(
      [
        "TEST_ANTHROPIC_API_KEY=anthropic-live-key",
        "TEST_CLAUDE_API_KEY=anthropic-live-key",
      ].join("\n") + "\n",
    );
    expect(
      result.preview.find((entry) => entry.key === "TEST_OPENAI_API_KEY")
        ?.disposition,
    ).toBe("preserved (managed, no captured value)");
    expect(
      result.preview.find((entry) => entry.key === "TEST_OPENROUTER_API_KEY")
        ?.disposition,
    ).toBe("preserved (managed, no captured value)");
  });

  it("dry-run preview shows fingerprints and never logs raw key values", () => {
    const repoRoot = makeTempDir();
    // Neutral, deliberately NON-`sk-`-shaped fake so the sk-* test-token drift
    // guard stays green; this test asserts the value is NEVER logged, so its
    // shape is irrelevant to what's under test.
    const rawKey = "fake-anthropic-live-secret-DO-NOT-LOG";
    const { logger, logs, errors } = makeLogger();

    captureLiveApiKeys({
      appSettings: {
        claude: { apiKey: rawKey },
        providerKeys: { openai: "fake-openai-live-secret-DO-NOT-LOG" },
      },
      repoRoot,
      logger,
    });

    const allLines = [...logs, ...errors];
    expect(
      logs.some((line) =>
        line.includes(`insert (${fingerprintValue(rawKey)})`),
      ),
    ).toBe(true);
    expect(
      logs.some((line) =>
        line.includes(
          "TEST_OPENROUTER_API_KEY: preserved (managed, no captured value)",
        ),
      ),
    ).toBe(true);
    expect(allLines.some((line) => line.includes(rawKey))).toBe(false);
    expect(
      allLines.some((line) =>
        line.includes("fake-openai-live-secret-DO-NOT-LOG"),
      ),
    ).toBe(false);
  });

  it("--apply=false writes no file", () => {
    const repoRoot = makeTempDir();
    const { logger } = makeLogger();
    const parsed = parseLiveApiCliArgs(["--apply=false"]);

    const result = captureLiveApiKeys({
      apply: parsed.apply,
      appSettings: {
        claude: { apiKey: "anthropic-live-key" },
      },
      repoRoot,
      logger,
    });

    expect(result.wroteFile).toBe(false);
    expect(fs.existsSync(buildLiveApiKeysOutputPath(repoRoot))).toBe(false);
  });

  it("preserves unmanaged assignments and comments containing KEY= text", () => {
    const repoRoot = makeTempDir();
    const outputPath = liveEnvPath(repoRoot);
    fs.writeFileSync(
      outputPath,
      [
        "# TEST_OPENAI_API_KEY=comment-only",
        "TEST_ELEVENLABS_API_KEY=eleven-existing",
      ].join("\n") + "\n",
      "utf8",
    );
    const { logger } = makeLogger();

    captureLiveApiKeys({
      apply: true,
      appSettings: { providerKeys: { openai: "openai-live-key" } },
      repoRoot,
      logger,
    });

    expect(fs.readFileSync(outputPath, "utf8")).toBe(
      [
        "# TEST_OPENAI_API_KEY=comment-only",
        "TEST_ELEVENLABS_API_KEY=eleven-existing",
        "TEST_OPENAI_API_KEY=openai-live-key",
      ].join("\n") + "\n",
    );
  });

  it("preserves managed keys that have no captured value", () => {
    const repoRoot = makeTempDir();
    const outputPath = liveEnvPath(repoRoot);
    fs.writeFileSync(
      outputPath,
      "TEST_ANTHROPIC_API_KEY=oauth-era-anthropic\n",
      "utf8",
    );
    const { logger } = makeLogger();

    const result = captureLiveApiKeys({
      apply: true,
      appSettings: { providerKeys: {} },
      repoRoot,
      logger,
    });

    expect(fs.readFileSync(outputPath, "utf8")).toBe(
      "TEST_ANTHROPIC_API_KEY=oauth-era-anthropic\n",
    );
    expect(
      result.preview.find((entry) => entry.key === "TEST_ANTHROPIC_API_KEY")
        ?.disposition,
    ).toBe("preserved (managed, no captured value)");
  });

  it("fills empty managed assignments without --force", () => {
    const repoRoot = makeTempDir();
    const outputPath = liveEnvPath(repoRoot);
    fs.writeFileSync(outputPath, "TEST_OPENAI_API_KEY=\n", "utf8");
    const { logger } = makeLogger();

    captureLiveApiKeys({
      apply: true,
      appSettings: { providerKeys: { openai: "openai-live-key" } },
      repoRoot,
      logger,
    });

    expect(fs.readFileSync(outputPath, "utf8")).toBe(
      "TEST_OPENAI_API_KEY=openai-live-key\n",
    );
  });

  it("requires --force to change an existing non-empty managed value", () => {
    const repoRoot = makeTempDir();
    const outputPath = liveEnvPath(repoRoot);
    fs.writeFileSync(outputPath, "TEST_OPENAI_API_KEY=old-live-key\n", "utf8");
    const { logger } = makeLogger();

    expect(() =>
      captureLiveApiKeys({
        apply: true,
        appSettings: { providerKeys: { openai: "new-live-key" } },
        repoRoot,
        logger,
      }),
    ).toThrow(
      new RegExp(
        `TEST_OPENAI_API_KEY.*${fingerprintValue("old-live-key")}.*${fingerprintValue("new-live-key")}.*--force`,
      ),
    );
    expect(fs.readFileSync(outputPath, "utf8")).toBe(
      "TEST_OPENAI_API_KEY=old-live-key\n",
    );

    captureLiveApiKeys({
      apply: true,
      force: true,
      appSettings: { providerKeys: { openai: "new-live-key" } },
      repoRoot,
      logger,
    });
    expect(fs.readFileSync(outputPath, "utf8")).toBe(
      "TEST_OPENAI_API_KEY=new-live-key\n",
    );
  });

  it("preserves export prefix and line position when updating with --force", () => {
    const repoRoot = makeTempDir();
    const outputPath = liveEnvPath(repoRoot);
    fs.writeFileSync(
      outputPath,
      "before=value\nexport TEST_OPENAI_API_KEY=old-live-key\nafter=value\n",
      "utf8",
    );
    const { logger } = makeLogger();

    captureLiveApiKeys({
      apply: true,
      force: true,
      appSettings: { providerKeys: { openai: "new-live-key" } },
      repoRoot,
      logger,
    });

    expect(fs.readFileSync(outputPath, "utf8")).toBe(
      "before=value\nexport TEST_OPENAI_API_KEY=new-live-key\nafter=value\n",
    );
  });

  it("fails closed on duplicate managed keys without --force", () => {
    const repoRoot = makeTempDir();
    const outputPath = liveEnvPath(repoRoot);
    fs.writeFileSync(
      outputPath,
      "TEST_OPENAI_API_KEY=one\nTEST_OPENAI_API_KEY=two\n",
      "utf8",
    );
    const { logger } = makeLogger();

    expect(() =>
      captureLiveApiKeys({
        apply: true,
        appSettings: { providerKeys: { openai: "new-live-key" } },
        repoRoot,
        logger,
      }),
    ).toThrow(/duplicate managed key.*TEST_OPENAI_API_KEY/i);
  });

  it("fails closed on duplicate managed keys even with --force", () => {
    const repoRoot = makeTempDir();
    const outputPath = liveEnvPath(repoRoot);
    fs.writeFileSync(
      outputPath,
      "TEST_OPENAI_API_KEY=one\nTEST_OPENAI_API_KEY=two\n",
      "utf8",
    );
    const { logger } = makeLogger();

    expect(() =>
      captureLiveApiKeys({
        apply: true,
        force: true,
        appSettings: { providerKeys: { openai: "new-live-key" } },
        repoRoot,
        logger,
      }),
    ).toThrow(/duplicate managed key.*TEST_OPENAI_API_KEY/i);
  });

  it("preserves CRLF endings in existing files", () => {
    const repoRoot = makeTempDir();
    const outputPath = liveEnvPath(repoRoot);
    fs.writeFileSync(
      outputPath,
      "TEST_ELEVENLABS_API_KEY=eleven\r\nTEST_OPENAI_API_KEY=\r\n",
      "utf8",
    );
    const { logger } = makeLogger();

    captureLiveApiKeys({
      apply: true,
      appSettings: { providerKeys: { openai: "openai-live-key" } },
      repoRoot,
      logger,
    });

    expect(fs.readFileSync(outputPath, "utf8")).toBe(
      "TEST_ELEVENLABS_API_KEY=eleven\r\nTEST_OPENAI_API_KEY=openai-live-key\r\n",
    );
  });

  it("preserves comment and assignment order while filling managed values", () => {
    const repoRoot = makeTempDir();
    const outputPath = liveEnvPath(repoRoot);
    fs.writeFileSync(
      outputPath,
      [
        "# header",
        "TEST_ELEVENLABS_API_KEY=eleven",
        "",
        "TEST_OPENAI_API_KEY=",
        "# footer",
      ].join("\n") + "\n",
      "utf8",
    );
    const { logger } = makeLogger();

    captureLiveApiKeys({
      apply: true,
      appSettings: { providerKeys: { openai: "openai-live-key" } },
      repoRoot,
      logger,
    });

    expect(fs.readFileSync(outputPath, "utf8")).toBe(
      [
        "# header",
        "TEST_ELEVENLABS_API_KEY=eleven",
        "",
        "TEST_OPENAI_API_KEY=openai-live-key",
        "# footer",
      ].join("\n") + "\n",
    );
  });

  it("is byte-identical on a second apply with the same captured values", () => {
    const repoRoot = makeTempDir();
    const outputPath = liveEnvPath(repoRoot);
    fs.writeFileSync(
      outputPath,
      "# local\nTEST_ELEVENLABS_API_KEY=eleven\n",
      "utf8",
    );
    const { logger } = makeLogger();

    const firstRun = captureLiveApiKeys({
      apply: true,
      appSettings: { providerKeys: { openai: "openai-live-key" } },
      repoRoot,
      logger,
    });
    const firstContents = fs.readFileSync(outputPath, "utf8");
    const secondRun = captureLiveApiKeys({
      apply: true,
      appSettings: { providerKeys: { openai: "openai-live-key" } },
      repoRoot,
      logger,
    });
    const secondContents = fs.readFileSync(outputPath, "utf8");

    expect(firstRun.wroteFile).toBe(true);
    expect(secondRun.wroteFile).toBe(false);
    expect(secondContents).toBe(firstContents);
    expect(
      secondRun.preview.find((entry) => entry.key === "TEST_OPENAI_API_KEY")
        ?.disposition,
    ).toBe("unchanged");
  });

  it("preserves duplicate unmanaged assignments without failing", () => {
    const repoRoot = makeTempDir();
    const outputPath = liveEnvPath(repoRoot);
    fs.writeFileSync(
      outputPath,
      "TEST_ELEVENLABS_API_KEY=one\nTEST_ELEVENLABS_API_KEY=two\n",
      "utf8",
    );
    const { logger } = makeLogger();

    captureLiveApiKeys({
      apply: true,
      appSettings: { providerKeys: { openai: "openai-live-key" } },
      repoRoot,
      logger,
    });

    expect(fs.readFileSync(outputPath, "utf8")).toBe(
      [
        "TEST_ELEVENLABS_API_KEY=one",
        "TEST_ELEVENLABS_API_KEY=two",
        "TEST_OPENAI_API_KEY=openai-live-key",
      ].join("\n") + "\n",
    );
  });

  it("adds a separator before appending to a file without a trailing newline", () => {
    const repoRoot = makeTempDir();
    const outputPath = liveEnvPath(repoRoot);
    fs.writeFileSync(outputPath, "TEST_ELEVENLABS_API_KEY=eleven", "utf8");
    const { logger } = makeLogger();

    captureLiveApiKeys({
      apply: true,
      appSettings: { providerKeys: { openai: "openai-live-key" } },
      repoRoot,
      logger,
    });

    expect(fs.readFileSync(outputPath, "utf8")).toBe(
      "TEST_ELEVENLABS_API_KEY=eleven\nTEST_OPENAI_API_KEY=openai-live-key\n",
    );
  });

  it("uses CRLF endings for appended managed inserts in CRLF files", () => {
    const repoRoot = makeTempDir();
    const outputPath = liveEnvPath(repoRoot);
    fs.writeFileSync(outputPath, "TEST_ELEVENLABS_API_KEY=eleven\r\n", "utf8");
    const { logger } = makeLogger();

    captureLiveApiKeys({
      apply: true,
      appSettings: {
        providerKeys: {
          openai: "openai-live-key",
          openrouter: "openrouter-live-key",
        },
      },
      repoRoot,
      logger,
    });

    expect(fs.readFileSync(outputPath, "utf8")).toBe(
      [
        "TEST_ELEVENLABS_API_KEY=eleven",
        "TEST_OPENAI_API_KEY=openai-live-key",
        "TEST_OPENROUTER_API_KEY=openrouter-live-key",
      ].join("\r\n") + "\r\n",
    );
  });

  it("preserves export prefix when filling an empty managed assignment", () => {
    const repoRoot = makeTempDir();
    const outputPath = liveEnvPath(repoRoot);
    fs.writeFileSync(outputPath, "export TEST_OPENAI_API_KEY=\n", "utf8");
    const { logger } = makeLogger();

    captureLiveApiKeys({
      apply: true,
      appSettings: { providerKeys: { openai: "openai-live-key" } },
      repoRoot,
      logger,
    });

    expect(fs.readFileSync(outputPath, "utf8")).toBe(
      "export TEST_OPENAI_API_KEY=openai-live-key\n",
    );
  });

  it("recognizes export-tab assignments for empty-fill and force-update", () => {
    const repoRoot = makeTempDir();
    const outputPath = liveEnvPath(repoRoot);
    fs.writeFileSync(
      outputPath,
      "export\tTEST_OPENAI_API_KEY=\nexport\tTEST_OPENROUTER_API_KEY=old-live-key\n",
      "utf8",
    );
    const { logger } = makeLogger();

    captureLiveApiKeys({
      apply: true,
      force: true,
      appSettings: {
        providerKeys: {
          openai: "openai-live-key",
          openrouter: "new-live-key",
        },
      },
      repoRoot,
      logger,
    });

    expect(fs.readFileSync(outputPath, "utf8")).toBe(
      "export\tTEST_OPENAI_API_KEY=openai-live-key\nexport\tTEST_OPENROUTER_API_KEY=new-live-key\n",
    );
  });

  it("preserves equals signs in inserted and force-updated values", () => {
    const repoRoot = makeTempDir();
    const outputPath = liveEnvPath(repoRoot);
    fs.writeFileSync(
      outputPath,
      "TEST_OPENROUTER_API_KEY=old-live-key\n",
      "utf8",
    );
    const { logger } = makeLogger();

    captureLiveApiKeys({
      apply: true,
      force: true,
      appSettings: {
        providerKeys: {
          openai: "base64==",
          openrouter: "https://example.test/path?token=a=b==",
        },
      },
      repoRoot,
      logger,
    });

    expect(fs.readFileSync(outputPath, "utf8")).toBe(
      [
        "TEST_OPENROUTER_API_KEY=https://example.test/path?token=a=b==",
        "TEST_OPENAI_API_KEY=base64==",
      ].join("\n") + "\n",
    );
  });

  it("appends multiple missing managed keys in sorted order", () => {
    const repoRoot = makeTempDir();
    const outputPath = liveEnvPath(repoRoot);
    fs.writeFileSync(outputPath, "TEST_ELEVENLABS_API_KEY=eleven\n", "utf8");
    const { logger } = makeLogger();

    captureLiveApiKeys({
      apply: true,
      appSettings: {
        claude: { apiKey: "anthropic-live-key" },
        providerKeys: {
          openai: "openai-live-key",
          openrouter: "openrouter-live-key",
        },
      },
      repoRoot,
      logger,
    });

    expect(fs.readFileSync(outputPath, "utf8")).toBe(
      [
        "TEST_ELEVENLABS_API_KEY=eleven",
        "TEST_ANTHROPIC_API_KEY=anthropic-live-key",
        "TEST_CLAUDE_API_KEY=anthropic-live-key",
        "TEST_OPENAI_API_KEY=openai-live-key",
        "TEST_OPENROUTER_API_KEY=openrouter-live-key",
      ].join("\n") + "\n",
    );
  });

  it("is byte-identical on a second apply with a gnarly CRLF fixture", () => {
    const repoRoot = makeTempDir();
    const outputPath = liveEnvPath(repoRoot);
    fs.writeFileSync(
      outputPath,
      [
        "# TEST_OPENAI_API_KEY=comment-only",
        "export\tTEST_OPENAI_API_KEY=",
        "",
        "UNMANAGED=one",
        "export TEST_CLAUDE_API_KEY=old-claude-key",
        "TEST_ELEVENLABS_API_KEY=eleven",
      ].join("\r\n") + "\r\n",
      "utf8",
    );
    const { logger } = makeLogger();
    const appSettings = {
      claude: { apiKey: "anthropic-live-key" },
      providerKeys: {
        openai: "openai-live-key",
        openrouter: "openrouter=with=query",
      },
    };

    captureLiveApiKeys({
      apply: true,
      force: true,
      appSettings,
      repoRoot,
      logger,
    });
    const firstContents = fs.readFileSync(outputPath, "utf8");
    const secondRun = captureLiveApiKeys({
      apply: true,
      force: true,
      appSettings,
      repoRoot,
      logger,
    });

    expect(secondRun.wroteFile).toBe(false);
    expect(fs.readFileSync(outputPath, "utf8")).toBe(firstContents);
    expect(firstContents).toBe(
      [
        "# TEST_OPENAI_API_KEY=comment-only",
        "export\tTEST_OPENAI_API_KEY=openai-live-key",
        "",
        "UNMANAGED=one",
        "export TEST_CLAUDE_API_KEY=anthropic-live-key",
        "TEST_ELEVENLABS_API_KEY=eleven",
        "TEST_ANTHROPIC_API_KEY=anthropic-live-key",
        "TEST_OPENROUTER_API_KEY=openrouter=with=query",
      ].join("\r\n") + "\r\n",
    );
  });

  it("falls back to evals keys.env for providers absent from app settings, with a managed marker", () => {
    const repoRoot = makeTempDir();
    writeEvalsKeysEnv(repoRoot, "ANTHROPIC_API_KEY=fallback-anthropic-key\n");
    const { logger, logs } = makeLogger();

    const result = captureLiveApiKeys({
      apply: true,
      // OAuth-auth shape: no claude.apiKey in app settings.
      appSettings: { providerKeys: { openai: "openai-live-key" } },
      repoRoot,
      logger,
    });

    expect(fs.readFileSync(liveEnvPath(repoRoot), "utf8")).toBe(
      [
        "TEST_ANTHROPIC_API_KEY=fallback-anthropic-key # source: evals keys.env",
        "TEST_CLAUDE_API_KEY=fallback-anthropic-key # source: evals keys.env",
        "TEST_OPENAI_API_KEY=openai-live-key",
      ].join("\n") + "\n",
    );
    expect(result.capturedCount).toBe(3);
    expect(
      logs.some(
        (line) =>
          line.includes("evals/configs/.local/keys.env") &&
          line.includes("TEST_ANTHROPIC_API_KEY"),
      ),
    ).toBe(true);
    expect(logs.some((line) => line.includes("fallback-anthropic-key"))).toBe(
      false,
    );
  });

  it("is idempotent across re-captures of a fallback-sourced value", () => {
    const repoRoot = makeTempDir();
    writeEvalsKeysEnv(repoRoot, "ANTHROPIC_API_KEY=fallback-anthropic-key\n");
    const { logger } = makeLogger();
    const appSettings = { providerKeys: {} };

    const firstRun = captureLiveApiKeys({
      apply: true,
      appSettings,
      repoRoot,
      logger,
    });
    const secondRun = captureLiveApiKeys({
      apply: true,
      appSettings,
      repoRoot,
      logger,
    });

    expect(firstRun.wroteFile).toBe(true);
    expect(secondRun.wroteFile).toBe(false);
    expect(
      secondRun.preview.find((entry) => entry.key === "TEST_ANTHROPIC_API_KEY")
        ?.disposition,
    ).toBe("unchanged");
  });

  it("prefers the app-settings key over the evals keys.env fallback", () => {
    const repoRoot = makeTempDir();
    writeEvalsKeysEnv(repoRoot, "ANTHROPIC_API_KEY=fallback-anthropic-key\n");
    const { logger } = makeLogger();

    captureLiveApiKeys({
      apply: true,
      appSettings: { claude: { apiKey: "settings-anthropic-key" } },
      repoRoot,
      logger,
    });

    const contents = fs.readFileSync(liveEnvPath(repoRoot), "utf8");
    expect(contents).toContain(
      "TEST_ANTHROPIC_API_KEY=settings-anthropic-key\n",
    );
    expect(contents).not.toContain("source: evals keys.env");
  });

  it("treats a missing evals keys.env as no captured value", () => {
    const repoRoot = makeTempDir();
    const { logger } = makeLogger();

    const result = captureLiveApiKeys({
      appSettings: { providerKeys: {} },
      repoRoot,
      logger,
    });

    expect(
      result.preview.find((entry) => entry.key === "TEST_ANTHROPIC_API_KEY")
        ?.disposition,
    ).toBe("preserved (managed, no captured value)");
  });

  it("dry-run conflict reports force-required disposition without throwing or writing", () => {
    const repoRoot = makeTempDir();
    const outputPath = liveEnvPath(repoRoot);
    fs.writeFileSync(outputPath, "TEST_OPENAI_API_KEY=old-live-key\n", "utf8");
    const { logger } = makeLogger();

    const result = captureLiveApiKeys({
      appSettings: { providerKeys: { openai: "new-live-key" } },
      repoRoot,
      logger,
    });

    expect(result.wroteFile).toBe(false);
    expect(fs.readFileSync(outputPath, "utf8")).toBe(
      "TEST_OPENAI_API_KEY=old-live-key\n",
    );
    expect(
      result.preview.find((entry) => entry.key === "TEST_OPENAI_API_KEY")
        ?.disposition,
    ).toBe("update (requires --force)");
  });
});
