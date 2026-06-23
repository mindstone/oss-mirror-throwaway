import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { captureKeys, fingerprintValue } from "../capture-keys";

const tempDirs: string[] = [];

function makeTempDir(prefix = "capture-keys-test-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeRepoRoot(): string {
  return makeTempDir("capture-keys-repo-");
}

function keysEnvPath(repoRoot: string): string {
  return path.join(repoRoot, "evals", "configs", ".local", "keys.env");
}

function legacyEnvPath(repoRoot: string): string {
  return path.join(repoRoot, "evals", ".env" + ".evals");
}

function writeAppSettings(settings: Record<string, unknown>): string {
  const dir = makeTempDir("capture-keys-settings-");
  const filePath = path.join(dir, "app-settings.json");
  fs.writeFileSync(filePath, JSON.stringify(settings, null, 2), "utf8");
  return filePath;
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

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      continue;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("capture-keys", () => {
  it("maps synthetic app-settings into sorted env lines with full coverage", () => {
    const repoRoot = makeRepoRoot();
    const appSettingsPath = writeAppSettings({
      claude: { apiKey: "anthropic-key" },
      providerKeys: {
        openai: "openai-key",
        google: "google-key",
        together: "together-key",
        cerebras: "cerebras-key",
        openrouter: "openrouter-provider-key",
      },
      openRouter: { oauthToken: "oauth-token-should-not-override" },
      customProviders: [
        { name: "Acme Gateway", apiKey: "acme-key" },
        { name: "Team Blue / EU", apiKey: "team-blue-key" },
      ],
    });
    const { logger } = makeLogger();

    const result = captureKeys({
      apply: true,
      appSettingsPath,
      repoRoot,
      logger,
    });
    const fileContents = fs.readFileSync(keysEnvPath(repoRoot), "utf8");

    expect(result.capturedCount).toBe(8);
    expect(fileContents).toBe(
      [
        "ACME_GATEWAY_API_KEY=acme-key",
        "ANTHROPIC_API_KEY=anthropic-key",
        "CEREBRAS_API_KEY=cerebras-key",
        "GOOGLE_API_KEY=google-key",
        "OPENAI_API_KEY=openai-key",
        "OPENROUTER_API_KEY=openrouter-provider-key",
        "TEAM_BLUE_EU_API_KEY=team-blue-key",
        "TOGETHER_API_KEY=together-key",
      ].join("\n") + "\n",
    );
  });

  it("--apply writes keys.env with 0600 permissions", () => {
    const repoRoot = makeRepoRoot();
    const appSettingsPath = writeAppSettings({
      claude: { apiKey: "anthropic-key" },
    });
    const { logger } = makeLogger();

    captureKeys({ apply: true, appSettingsPath, repoRoot, logger });

    const fileMode = fs.statSync(keysEnvPath(repoRoot)).mode & 0o777;
    expect(fileMode).toBe(0o600);
  });

  it("dry-run does not write and prints present/absent preview", () => {
    const repoRoot = makeRepoRoot();
    const appSettingsPath = writeAppSettings({
      claude: { apiKey: "anthropic-key" },
    });
    const { logger, logs } = makeLogger();

    const result = captureKeys({ appSettingsPath, repoRoot, logger });

    expect(result.wroteFile).toBe(false);
    expect(fs.existsSync(keysEnvPath(repoRoot))).toBe(false);
    expect(logs.some((line) => line.includes("Dry-run preview"))).toBe(true);
    expect(logs.some((line) => line.includes("insert"))).toBe(true);
    expect(
      logs.some((line) =>
        line.includes("preserved (managed, no captured value)"),
      ),
    ).toBe(true);
    expect(logs.some((line) => line.includes("Captured"))).toBe(false);
  });

  it("bails when both legacy and hermetic key files exist", () => {
    const repoRoot = makeRepoRoot();
    const appSettingsPath = writeAppSettings({
      claude: { apiKey: "anthropic-key" },
    });
    const { logger, errors } = makeLogger();
    const outputPath = keysEnvPath(repoRoot);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, "ANTHROPIC_API_KEY=current\n", "utf8");
    fs.writeFileSync(
      legacyEnvPath(repoRoot),
      "ANTHROPIC_API_KEY=legacy\n",
      "utf8",
    );

    const legacyDisplay = ".env" + ".evals";
    const expectedMessage = `Both ${legacyDisplay} (legacy) and evals/configs/.local/keys.env are present. Delete ${legacyDisplay} to proceed.`;

    expect(() => captureKeys({ appSettingsPath, repoRoot, logger })).toThrow(
      expectedMessage,
    );
    expect(errors).toContain(expectedMessage);
  });

  it("uses openRouter.oauthToken fallback when providerKeys.openrouter is absent", () => {
    const repoRoot = makeRepoRoot();
    const appSettingsPath = writeAppSettings({
      openRouter: { oauthToken: "oauth-only-token" },
    });
    const { logger } = makeLogger();

    const result = captureKeys({ appSettingsPath, repoRoot, logger });

    expect(result.envFileContents).toContain(
      "OPENROUTER_API_KEY=oauth-only-token",
    );
  });

  it("does not let openRouter.oauthToken override providerKeys.openrouter", () => {
    const repoRoot = makeRepoRoot();
    const appSettingsPath = writeAppSettings({
      providerKeys: { openrouter: "provider-key" },
      openRouter: { oauthToken: "oauth-token" },
    });
    const { logger } = makeLogger();

    const result = captureKeys({ appSettingsPath, repoRoot, logger });

    expect(result.envFileContents).toContain("OPENROUTER_API_KEY=provider-key");
    expect(result.envFileContents).not.toContain(
      "OPENROUTER_API_KEY=oauth-token",
    );
  });

  it("sanitizes non-trivial custom provider names into env var keys", () => {
    const repoRoot = makeRepoRoot();
    const appSettingsPath = writeAppSettings({
      customProviders: [
        { name: " Team.Blue (EU-West) ", apiKey: "custom-key" },
      ],
    });
    const { logger } = makeLogger();

    const result = captureKeys({ appSettingsPath, repoRoot, logger });

    expect(result.envFileContents).toContain(
      "TEAM_BLUE_EU_WEST_API_KEY=custom-key",
    );
  });

  it("is idempotent when run twice with the same input", () => {
    const repoRoot = makeRepoRoot();
    const appSettingsPath = writeAppSettings({
      claude: { apiKey: "anthropic-key" },
      providerKeys: { openai: "openai-key" },
    });
    const { logger } = makeLogger();

    const firstRun = captureKeys({
      apply: true,
      appSettingsPath,
      repoRoot,
      logger,
    });
    const firstContents = fs.readFileSync(keysEnvPath(repoRoot), "utf8");
    const secondRun = captureKeys({
      apply: true,
      appSettingsPath,
      repoRoot,
      logger,
    });
    const secondContents = fs.readFileSync(keysEnvPath(repoRoot), "utf8");

    expect(firstRun.wroteFile).toBe(true);
    expect(secondRun.wroteFile).toBe(false);
    expect(secondContents).toBe(firstContents);
    expect(
      secondRun.preview.find((entry) => entry.key === "OPENAI_API_KEY")
        ?.disposition,
    ).toBe("unchanged");
  });

  it("writes atomically via tmp path and rename", () => {
    const repoRoot = makeRepoRoot();
    const appSettingsPath = writeAppSettings({
      claude: { apiKey: "anthropic-key" },
    });
    const { logger } = makeLogger();
    const outputPath = keysEnvPath(repoRoot);
    const tempPath = `${outputPath}.tmp.4242`;

    const writeSpy = vi.spyOn(fs, "writeFileSync");
    const renameSpy = vi.spyOn(fs, "renameSync");

    captureKeys({ apply: true, appSettingsPath, repoRoot, logger, pid: 4242 });

    expect(writeSpy).toHaveBeenCalledWith(tempPath, expect.any(String), {
      encoding: "utf8",
      mode: 0o600,
    });
    expect(renameSpy).toHaveBeenCalledWith(tempPath, outputPath);
    expect(fs.existsSync(tempPath)).toBe(false);
    expect(fs.existsSync(outputPath)).toBe(true);
  });

  it("refuses overwrite on mismatch without --force, then allows with --force", () => {
    const repoRoot = makeRepoRoot();
    const appSettingsPath = writeAppSettings({
      claude: { apiKey: "first-key" },
    });
    const { logger } = makeLogger();

    captureKeys({ apply: true, appSettingsPath, repoRoot, logger });
    const firstContents = fs.readFileSync(keysEnvPath(repoRoot), "utf8");

    fs.writeFileSync(
      appSettingsPath,
      JSON.stringify({ claude: { apiKey: "second-key" } }, null, 2),
      "utf8",
    );

    expect(() =>
      captureKeys({ apply: true, appSettingsPath, repoRoot, logger }),
    ).toThrow(
      /Refusing to update existing managed value.*ANTHROPIC_API_KEY.*--force/,
    );
    expect(fs.readFileSync(keysEnvPath(repoRoot), "utf8")).toBe(firstContents);

    captureKeys({
      apply: true,
      force: true,
      appSettingsPath,
      repoRoot,
      logger,
    });
    expect(fs.readFileSync(keysEnvPath(repoRoot), "utf8")).toBe(
      "ANTHROPIC_API_KEY=second-key\n",
    );
  });

  it("preserves unmanaged assignments and comments containing KEY= text", () => {
    const repoRoot = makeRepoRoot();
    const outputPath = keysEnvPath(repoRoot);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(
      outputPath,
      [
        "# OPENAI_API_KEY=comment-only",
        "ELEVENLABS_API_KEY=eleven-existing",
      ].join("\n") + "\n",
      "utf8",
    );
    const appSettingsPath = writeAppSettings({
      providerKeys: { openai: "openai-key" },
    });
    const { logger } = makeLogger();

    captureKeys({ apply: true, appSettingsPath, repoRoot, logger });

    expect(fs.readFileSync(outputPath, "utf8")).toBe(
      [
        "# OPENAI_API_KEY=comment-only",
        "ELEVENLABS_API_KEY=eleven-existing",
        "OPENAI_API_KEY=openai-key",
      ].join("\n") + "\n",
    );
  });

  it("preserves managed keys that have no captured value", () => {
    const repoRoot = makeRepoRoot();
    const outputPath = keysEnvPath(repoRoot);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(
      outputPath,
      "ANTHROPIC_API_KEY=oauth-era-anthropic\n",
      "utf8",
    );
    const appSettingsPath = writeAppSettings({
      providerKeys: {},
    });
    const { logger } = makeLogger();

    const result = captureKeys({
      apply: true,
      appSettingsPath,
      repoRoot,
      logger,
    });

    expect(fs.readFileSync(outputPath, "utf8")).toBe(
      "ANTHROPIC_API_KEY=oauth-era-anthropic\n",
    );
    expect(
      result.preview.find((entry) => entry.key === "ANTHROPIC_API_KEY")
        ?.disposition,
    ).toBe("preserved (managed, no captured value)");
  });

  it("fills empty managed assignments without --force", () => {
    const repoRoot = makeRepoRoot();
    const outputPath = keysEnvPath(repoRoot);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, "OPENAI_API_KEY=\n", "utf8");
    const appSettingsPath = writeAppSettings({
      providerKeys: { openai: "openai-key" },
    });
    const { logger } = makeLogger();

    captureKeys({ apply: true, appSettingsPath, repoRoot, logger });

    expect(fs.readFileSync(outputPath, "utf8")).toBe(
      "OPENAI_API_KEY=openai-key\n",
    );
  });

  it("requires --force to change an existing non-empty managed value", () => {
    const repoRoot = makeRepoRoot();
    const outputPath = keysEnvPath(repoRoot);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, "OPENAI_API_KEY=old-eval-key\n", "utf8");
    const appSettingsPath = writeAppSettings({
      providerKeys: { openai: "new-eval-key" },
    });
    const { logger } = makeLogger();

    expect(() =>
      captureKeys({ apply: true, appSettingsPath, repoRoot, logger }),
    ).toThrow(
      new RegExp(
        `OPENAI_API_KEY.*${fingerprintValue("old-eval-key")}.*${fingerprintValue("new-eval-key")}.*--force`,
      ),
    );
    expect(fs.readFileSync(outputPath, "utf8")).toBe(
      "OPENAI_API_KEY=old-eval-key\n",
    );

    captureKeys({
      apply: true,
      force: true,
      appSettingsPath,
      repoRoot,
      logger,
    });
    expect(fs.readFileSync(outputPath, "utf8")).toBe(
      "OPENAI_API_KEY=new-eval-key\n",
    );
  });

  it("preserves export prefix and line position when updating with --force", () => {
    const repoRoot = makeRepoRoot();
    const outputPath = keysEnvPath(repoRoot);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(
      outputPath,
      "before=value\nexport OPENAI_API_KEY=old-eval-key\nafter=value\n",
      "utf8",
    );
    const appSettingsPath = writeAppSettings({
      providerKeys: { openai: "new-eval-key" },
    });
    const { logger } = makeLogger();

    captureKeys({
      apply: true,
      force: true,
      appSettingsPath,
      repoRoot,
      logger,
    });

    expect(fs.readFileSync(outputPath, "utf8")).toBe(
      "before=value\nexport OPENAI_API_KEY=new-eval-key\nafter=value\n",
    );
  });

  it("fails closed on duplicate managed keys without --force", () => {
    const repoRoot = makeRepoRoot();
    const outputPath = keysEnvPath(repoRoot);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(
      outputPath,
      "OPENAI_API_KEY=one\nOPENAI_API_KEY=two\n",
      "utf8",
    );
    const appSettingsPath = writeAppSettings({
      providerKeys: { openai: "new-eval-key" },
    });
    const { logger } = makeLogger();

    expect(() =>
      captureKeys({ apply: true, appSettingsPath, repoRoot, logger }),
    ).toThrow(/duplicate managed key.*OPENAI_API_KEY/i);
  });

  it("fails closed on duplicate managed keys even with --force", () => {
    const repoRoot = makeRepoRoot();
    const outputPath = keysEnvPath(repoRoot);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(
      outputPath,
      "OPENAI_API_KEY=one\nOPENAI_API_KEY=two\n",
      "utf8",
    );
    const appSettingsPath = writeAppSettings({
      providerKeys: { openai: "new-eval-key" },
    });
    const { logger } = makeLogger();

    expect(() =>
      captureKeys({
        apply: true,
        force: true,
        appSettingsPath,
        repoRoot,
        logger,
      }),
    ).toThrow(/duplicate managed key.*OPENAI_API_KEY/i);
  });

  it("preserves CRLF endings in existing files", () => {
    const repoRoot = makeRepoRoot();
    const outputPath = keysEnvPath(repoRoot);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(
      outputPath,
      "ELEVENLABS_API_KEY=eleven\r\nOPENAI_API_KEY=\r\n",
      "utf8",
    );
    const appSettingsPath = writeAppSettings({
      providerKeys: { openai: "openai-key" },
    });
    const { logger } = makeLogger();

    captureKeys({ apply: true, appSettingsPath, repoRoot, logger });

    expect(fs.readFileSync(outputPath, "utf8")).toBe(
      "ELEVENLABS_API_KEY=eleven\r\nOPENAI_API_KEY=openai-key\r\n",
    );
  });

  it("preserves comment and assignment order while filling managed values", () => {
    const repoRoot = makeRepoRoot();
    const outputPath = keysEnvPath(repoRoot);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(
      outputPath,
      [
        "# header",
        "ELEVENLABS_API_KEY=eleven",
        "",
        "OPENAI_API_KEY=",
        "# footer",
      ].join("\n") + "\n",
      "utf8",
    );
    const appSettingsPath = writeAppSettings({
      providerKeys: { openai: "openai-key" },
    });
    const { logger } = makeLogger();

    captureKeys({ apply: true, appSettingsPath, repoRoot, logger });

    expect(fs.readFileSync(outputPath, "utf8")).toBe(
      [
        "# header",
        "ELEVENLABS_API_KEY=eleven",
        "",
        "OPENAI_API_KEY=openai-key",
        "# footer",
      ].join("\n") + "\n",
    );
  });

  it("is byte-identical on a second apply with the same captured values and unmanaged lines", () => {
    const repoRoot = makeRepoRoot();
    const outputPath = keysEnvPath(repoRoot);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(
      outputPath,
      "# local\nELEVENLABS_API_KEY=eleven\n",
      "utf8",
    );
    const appSettingsPath = writeAppSettings({
      providerKeys: { openai: "openai-key" },
    });
    const { logger } = makeLogger();

    const firstRun = captureKeys({
      apply: true,
      appSettingsPath,
      repoRoot,
      logger,
    });
    const firstContents = fs.readFileSync(outputPath, "utf8");
    const secondRun = captureKeys({
      apply: true,
      appSettingsPath,
      repoRoot,
      logger,
    });
    const secondContents = fs.readFileSync(outputPath, "utf8");

    expect(firstRun.wroteFile).toBe(true);
    expect(secondRun.wroteFile).toBe(false);
    expect(secondContents).toBe(firstContents);
  });

  it("preserves current custom-provider managed keys when this run has no captured value", () => {
    const repoRoot = makeRepoRoot();
    const outputPath = keysEnvPath(repoRoot);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(
      outputPath,
      "ACME_GATEWAY_API_KEY=old-custom-key\n",
      "utf8",
    );
    const appSettingsPath = writeAppSettings({
      customProviders: [{ name: "Acme Gateway" }],
    });
    const { logger } = makeLogger();

    const result = captureKeys({
      apply: true,
      appSettingsPath,
      repoRoot,
      logger,
    });

    expect(fs.readFileSync(outputPath, "utf8")).toBe(
      "ACME_GATEWAY_API_KEY=old-custom-key\n",
    );
    expect(
      result.preview.find((entry) => entry.key === "ACME_GATEWAY_API_KEY")
        ?.disposition,
    ).toBe("preserved (managed, no captured value)");
  });

  it("preserves removed custom-provider keys as unmanaged", () => {
    const repoRoot = makeRepoRoot();
    const outputPath = keysEnvPath(repoRoot);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(
      outputPath,
      "ACME_GATEWAY_API_KEY=old-custom-key\n",
      "utf8",
    );
    const appSettingsPath = writeAppSettings({
      customProviders: [],
    });
    const { logger } = makeLogger();

    const result = captureKeys({
      apply: true,
      appSettingsPath,
      repoRoot,
      logger,
    });

    expect(fs.readFileSync(outputPath, "utf8")).toBe(
      "ACME_GATEWAY_API_KEY=old-custom-key\n",
    );
    expect(
      result.preview.find((entry) => entry.key === "ACME_GATEWAY_API_KEY")
        ?.disposition,
    ).toBe("preserved (not managed)");
  });

  it("preserves duplicate unmanaged assignments without failing", () => {
    const repoRoot = makeRepoRoot();
    const outputPath = keysEnvPath(repoRoot);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(
      outputPath,
      "ELEVENLABS_API_KEY=one\nELEVENLABS_API_KEY=two\n",
      "utf8",
    );
    const appSettingsPath = writeAppSettings({
      providerKeys: { openai: "openai-key" },
    });
    const { logger } = makeLogger();

    captureKeys({ apply: true, appSettingsPath, repoRoot, logger });

    expect(fs.readFileSync(outputPath, "utf8")).toBe(
      [
        "ELEVENLABS_API_KEY=one",
        "ELEVENLABS_API_KEY=two",
        "OPENAI_API_KEY=openai-key",
      ].join("\n") + "\n",
    );
  });

  it("adds a separator before appending to a file without a trailing newline", () => {
    const repoRoot = makeRepoRoot();
    const outputPath = keysEnvPath(repoRoot);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, "ELEVENLABS_API_KEY=eleven", "utf8");
    const appSettingsPath = writeAppSettings({
      providerKeys: { openai: "openai-key" },
    });
    const { logger } = makeLogger();

    captureKeys({ apply: true, appSettingsPath, repoRoot, logger });

    expect(fs.readFileSync(outputPath, "utf8")).toBe(
      "ELEVENLABS_API_KEY=eleven\nOPENAI_API_KEY=openai-key\n",
    );
  });

  it("uses CRLF endings for appended managed inserts in CRLF files", () => {
    const repoRoot = makeRepoRoot();
    const outputPath = keysEnvPath(repoRoot);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, "ELEVENLABS_API_KEY=eleven\r\n", "utf8");
    const appSettingsPath = writeAppSettings({
      providerKeys: {
        openai: "openai-key",
        openrouter: "openrouter-key",
      },
    });
    const { logger } = makeLogger();

    captureKeys({ apply: true, appSettingsPath, repoRoot, logger });

    expect(fs.readFileSync(outputPath, "utf8")).toBe(
      [
        "ELEVENLABS_API_KEY=eleven",
        "OPENAI_API_KEY=openai-key",
        "OPENROUTER_API_KEY=openrouter-key",
      ].join("\r\n") + "\r\n",
    );
  });

  it("preserves export prefix when filling an empty managed assignment", () => {
    const repoRoot = makeRepoRoot();
    const outputPath = keysEnvPath(repoRoot);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, "export OPENAI_API_KEY=\n", "utf8");
    const appSettingsPath = writeAppSettings({
      providerKeys: { openai: "openai-key" },
    });
    const { logger } = makeLogger();

    captureKeys({ apply: true, appSettingsPath, repoRoot, logger });

    expect(fs.readFileSync(outputPath, "utf8")).toBe(
      "export OPENAI_API_KEY=openai-key\n",
    );
  });

  it("recognizes export-tab assignments for empty-fill and force-update", () => {
    const repoRoot = makeRepoRoot();
    const outputPath = keysEnvPath(repoRoot);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(
      outputPath,
      "export\tOPENAI_API_KEY=\nexport\tOPENROUTER_API_KEY=old-eval-key\n",
      "utf8",
    );
    const appSettingsPath = writeAppSettings({
      providerKeys: {
        openai: "openai-key",
        openrouter: "new-eval-key",
      },
    });
    const { logger } = makeLogger();

    captureKeys({
      apply: true,
      force: true,
      appSettingsPath,
      repoRoot,
      logger,
    });

    expect(fs.readFileSync(outputPath, "utf8")).toBe(
      "export\tOPENAI_API_KEY=openai-key\nexport\tOPENROUTER_API_KEY=new-eval-key\n",
    );
  });

  it("preserves equals signs in inserted and force-updated values", () => {
    const repoRoot = makeRepoRoot();
    const outputPath = keysEnvPath(repoRoot);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, "OPENROUTER_API_KEY=old-eval-key\n", "utf8");
    const appSettingsPath = writeAppSettings({
      providerKeys: {
        openai: "base64==",
        openrouter: "https://example.test/path?token=a=b==",
      },
    });
    const { logger } = makeLogger();

    captureKeys({
      apply: true,
      force: true,
      appSettingsPath,
      repoRoot,
      logger,
    });

    expect(fs.readFileSync(outputPath, "utf8")).toBe(
      [
        "OPENROUTER_API_KEY=https://example.test/path?token=a=b==",
        "OPENAI_API_KEY=base64==",
      ].join("\n") + "\n",
    );
  });

  it("appends multiple missing managed keys in sorted order", () => {
    const repoRoot = makeRepoRoot();
    const outputPath = keysEnvPath(repoRoot);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, "ELEVENLABS_API_KEY=eleven\n", "utf8");
    const appSettingsPath = writeAppSettings({
      claude: { apiKey: "anthropic-key" },
      providerKeys: {
        openai: "openai-key",
        openrouter: "openrouter-key",
      },
    });
    const { logger } = makeLogger();

    captureKeys({ apply: true, appSettingsPath, repoRoot, logger });

    expect(fs.readFileSync(outputPath, "utf8")).toBe(
      [
        "ELEVENLABS_API_KEY=eleven",
        "ANTHROPIC_API_KEY=anthropic-key",
        "OPENAI_API_KEY=openai-key",
        "OPENROUTER_API_KEY=openrouter-key",
      ].join("\n") + "\n",
    );
  });

  it("is byte-identical on a second apply with a gnarly CRLF fixture", () => {
    const repoRoot = makeRepoRoot();
    const outputPath = keysEnvPath(repoRoot);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(
      outputPath,
      [
        "# OPENAI_API_KEY=comment-only",
        "export\tOPENAI_API_KEY=",
        "",
        "UNMANAGED=one",
        "export OPENROUTER_API_KEY=old-openrouter-key",
        "ELEVENLABS_API_KEY=eleven",
      ].join("\r\n") + "\r\n",
      "utf8",
    );
    const appSettingsPath = writeAppSettings({
      claude: { apiKey: "anthropic-key" },
      providerKeys: {
        openai: "openai-key",
        openrouter: "openrouter=with=query",
      },
    });
    const { logger } = makeLogger();

    captureKeys({
      apply: true,
      force: true,
      appSettingsPath,
      repoRoot,
      logger,
    });
    const firstContents = fs.readFileSync(outputPath, "utf8");
    const secondRun = captureKeys({
      apply: true,
      force: true,
      appSettingsPath,
      repoRoot,
      logger,
    });

    expect(secondRun.wroteFile).toBe(false);
    expect(fs.readFileSync(outputPath, "utf8")).toBe(firstContents);
    expect(firstContents).toBe(
      [
        "# OPENAI_API_KEY=comment-only",
        "export\tOPENAI_API_KEY=openai-key",
        "",
        "UNMANAGED=one",
        "export OPENROUTER_API_KEY=openrouter=with=query",
        "ELEVENLABS_API_KEY=eleven",
        "ANTHROPIC_API_KEY=anthropic-key",
      ].join("\r\n") + "\r\n",
    );
  });

  it("dry-run conflict reports force-required disposition without throwing or writing", () => {
    const repoRoot = makeRepoRoot();
    const outputPath = keysEnvPath(repoRoot);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, "OPENAI_API_KEY=old-eval-key\n", "utf8");
    const appSettingsPath = writeAppSettings({
      providerKeys: { openai: "new-eval-key" },
    });
    const { logger } = makeLogger();

    const result = captureKeys({ appSettingsPath, repoRoot, logger });

    expect(result.wroteFile).toBe(false);
    expect(fs.readFileSync(outputPath, "utf8")).toBe(
      "OPENAI_API_KEY=old-eval-key\n",
    );
    expect(
      result.preview.find((entry) => entry.key === "OPENAI_API_KEY")
        ?.disposition,
    ).toBe("update (requires --force)");
  });

  it("dry-run preview fingerprints values without logging raw secrets", () => {
    const repoRoot = makeRepoRoot();
    const rawOpenAiKey = "fake-openai-eval-secret-DO-NOT-LOG";
    const rawAnthropicKey = "fake-anthropic-eval-secret-DO-NOT-LOG";
    const appSettingsPath = writeAppSettings({
      claude: { apiKey: rawAnthropicKey },
      providerKeys: { openai: rawOpenAiKey },
    });
    const { logger, logs, errors } = makeLogger();

    captureKeys({ appSettingsPath, repoRoot, logger });

    const allLines = [...logs, ...errors];
    expect(
      logs.some((line) =>
        line.includes(
          `ANTHROPIC_API_KEY: insert (${fingerprintValue(rawAnthropicKey)})`,
        ),
      ),
    ).toBe(true);
    expect(
      logs.some((line) =>
        line.includes(
          `OPENAI_API_KEY: insert (${fingerprintValue(rawOpenAiKey)})`,
        ),
      ),
    ).toBe(true);
    expect(allLines.some((line) => line.includes(rawAnthropicKey))).toBe(false);
    expect(allLines.some((line) => line.includes(rawOpenAiKey))).toBe(false);
  });
});
