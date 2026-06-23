import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultCapabilities, setPlatformConfig, type PlatformConfig } from '@core/platform';
import {
  createManagedMcpInstallService,
  defaultSeedTarballLookup,
  DEV_PRE_PUBLISH_SENTINEL_FILENAME,
  InstallEntryPointNotFound,
  InstallPathTooLongError,
  InstallTimeoutError,
  ManagedMcpInstallError,
  UnpinnedPackageSpecError,
  parsePackageSpec,
  type DevPrePublishSentinel,
  type InstallMetadata,
} from '../managedMcpInstallService';
import {
  OFFICE_MCP_PACKAGE_SPEC,
  OFFICE_MCP_SEED_TARBALL_FILENAME,
  MANAGED_INSTALL_SEEDS_SUBDIR,
} from '@shared/sidecar/officePackage';

const errorReporterMocks = vi.hoisted(() => ({
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  captureExceptionWithScope: vi.fn(),
}));

 
vi.mock('@core/errorReporter', () => ({
  getErrorReporter: () => errorReporterMocks,
}));

type ManagedExecFile = NonNullable<
  Parameters<typeof createManagedMcpInstallService>[0]['execFile']
>;

interface ExecFileOptions {
  cwd?: string;
}

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

interface InstalledPackageFixture {
  packageName?: string;
  packageJson?: Record<string, unknown>;
  files?: Record<string, string>;
}

const createLogger = (): Logger =>
  ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }) as unknown as Logger;

const createTestPlatformConfig = (
  appPath: string,
  userDataPath: string,
  isPackaged = false,
): PlatformConfig => ({
  userDataPath,
  appPath,
  tempPath: os.tmpdir(),
  logsPath: path.join(userDataPath, 'logs'),
  homePath: os.homedir(),
  documentsPath: path.join(userDataPath, 'Documents'),
  desktopPath: path.join(userDataPath, 'Desktop'),
  appDataPath: userDataPath,
  version: '0.0.0-test',
  isPackaged,
  platform: process.platform,
  totalMemoryBytes: 8 * 1024 * 1024 * 1024,
  arch: process.arch,
  surface: 'desktop',
  isOss: false,
  capabilities: defaultCapabilities('desktop'),
});

const sha256 = (contents: string | Buffer): string =>
  createHash('sha256').update(contents).digest('hex');

const writeSeedManifest = async (
  seedPath: string,
  packageSpec: string,
  contents: string | Buffer,
  overrideSha?: string,
): Promise<void> => {
  await fs.mkdir(path.dirname(seedPath), { recursive: true });
  await fs.writeFile(
    path.join(path.dirname(seedPath), 'seeds-manifest.json'),
    JSON.stringify(
      {
        version: 1,
        seeds: [
          {
            filename: path.basename(seedPath),
            packageSpec,
            sha256: overrideSha ?? sha256(contents),
            sizeBytes: Buffer.byteLength(contents),
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );
};

const asExecFile = (
  implementation: (
    file: string,
    args: string[],
    options: ExecFileOptions,
    callback: ExecFileCallback
  ) => void
): ManagedExecFile => {
  return implementation as unknown as ManagedExecFile;
};

const createExecFileSuccess = (
  fixture: InstalledPackageFixture = {}
): ManagedExecFile => {
  return asExecFile(async (_file, args, options, callback) => {
    const cwd = options.cwd;
    if (typeof cwd !== 'string') {
      throw new Error('Expected cwd to be defined');
    }

    const spec = args[1];
    if (typeof spec !== 'string') {
      throw new Error('Expected npm install spec argument');
    }

    const parsedSpec = parsePackageSpec(spec);
    const packageName = fixture.packageName ?? parsedSpec.name;
    const packageJson = fixture.packageJson ?? {
      name: packageName,
      version: parsedSpec.version,
      main: 'index.js',
    };
    const files = fixture.files ?? {
      'index.js': 'module.exports = {};\n',
    };

    await fs.writeFile(
      path.join(cwd, 'package.json'),
      JSON.stringify(
        {
          name: 'managed-mcp-test-container',
          version: '1.0.0',
          private: true,
          dependencies: {
            [packageName]: parsedSpec.version,
          },
        },
        null,
        2
      ),
      'utf8'
    );

    const packageDir = path.join(cwd, 'node_modules', ...packageName.split('/'));
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(path.join(packageDir, 'package.json'), JSON.stringify(packageJson, null, 2), 'utf8');

    for (const [relativePath, contents] of Object.entries(files)) {
      const absolutePath = path.join(packageDir, relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, contents, 'utf8');
    }

    callback(null, '', '');
  });
};

const createRecordingExamplePackageInstall = (
  recordedInstallArgs: string[],
  recordedCommandArgs: string[][] = [],
): ManagedExecFile => asExecFile(async (_file, args, options, callback) => {
  recordedCommandArgs.push([...args]);
  const installIdx = args.indexOf('install');
  if (installIdx >= 0 && args[installIdx + 1]) {
    recordedInstallArgs.push(args[installIdx + 1]);
  }
  const cwd = options.cwd;
  if (typeof cwd !== 'string') throw new Error('cwd required');
  const packageDir = path.join(cwd, 'node_modules', 'example-package');
  await fs.mkdir(packageDir, { recursive: true });
  await fs.writeFile(
    path.join(packageDir, 'package.json'),
    JSON.stringify({ name: 'example-package', version: '1.2.3', main: 'index.js' }),
    'utf8',
  );
  await fs.writeFile(path.join(packageDir, 'index.js'), 'module.exports={};\n', 'utf8');
  callback(null, '', '');
});

describe('managedMcpInstallService', () => {
  let userDataPath: string;

  beforeEach(async () => {
    userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-mcp-install-test-'));
    setPlatformConfig(createTestPlatformConfig(userDataPath, userDataPath));
    errorReporterMocks.addBreadcrumb.mockReset();
    errorReporterMocks.captureException.mockReset();
    errorReporterMocks.captureMessage.mockReset();
    errorReporterMocks.captureExceptionWithScope.mockReset();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await fs.rm(userDataPath, { recursive: true, force: true });
  });

  describe('parsePackageSpec', () => {
    it('parses a valid scoped package spec', () => {
      expect(parsePackageSpec('@mindstone/server@1.2.3')).toEqual({
        name: '@mindstone/server',
        version: '1.2.3',
      });
    });

    it('parses a valid unscoped package spec', () => {
      expect(parsePackageSpec('example-package@2.3.4')).toEqual({
        name: 'example-package',
        version: '2.3.4',
      });
    });

    it('throws when the version is missing', () => {
      expect(() => parsePackageSpec('@mindstone/server')).toThrow(UnpinnedPackageSpecError);
    });

    it('throws for an invalid package spec', () => {
      expect(() => parsePackageSpec('@mindstone@1.2.3')).toThrow(UnpinnedPackageSpecError);
    });
  });

  it('installs a package, writes metadata, and resolves the entry point', async () => {
    const service = createManagedMcpInstallService({
      userDataPath,
      npmPath: 'npm',
      logger: createLogger(),
      execFile: createExecFileSuccess({
        packageJson: {
          name: 'example-package',
          version: '1.2.3',
          bin: 'cli.js',
        },
        files: {
          'cli.js': '#!/usr/bin/env node\nconsole.log("ok");\n',
        },
      }),
    });

    const metadata = await service.install({ packageSpec: 'example-package@1.2.3' });

    expect(metadata.packageSpec).toBe('example-package@1.2.3');
    expect(metadata.packageName).toBe('example-package');
    expect(metadata.version).toBe('1.2.3');
    expect(metadata.installRoot).toBe(
      path.join(userDataPath, 'mcp', 'managed-installs', 'example-package@1.2.3')
    );
    expect(metadata.entryPath).toBe(
      path.join(metadata.installRoot, 'node_modules', 'example-package', 'cli.js')
    );
    expect(metadata.metaVersion).toBe(1);
    expect(metadata.platform).toBe(process.platform);
    expect(metadata.nodeVersion).toBe(process.version);
    expect(await fs.readFile(metadata.entryPath, 'utf8')).toContain('console.log("ok")');

    const storedMetadata = JSON.parse(
      await fs.readFile(path.join(metadata.installRoot, '.install-meta.json'), 'utf8')
    ) as InstallMetadata;
    expect(storedMetadata).toEqual(metadata);
  });

  it('is idempotent for an already installed spec', async () => {
    const execFile = vi.fn(
      createExecFileSuccess({
        packageJson: {
          name: 'example-package',
          version: '1.2.3',
          main: 'index.js',
        },
      })
    );

    const service = createManagedMcpInstallService({
      userDataPath,
      npmPath: 'npm',
      logger: createLogger(),
      execFile: execFile as unknown as ManagedExecFile,
    });

    const firstMetadata = await service.install({ packageSpec: 'example-package@1.2.3' });
    const secondMetadata = await service.install({ packageSpec: 'example-package@1.2.3' });

    expect(execFile).toHaveBeenCalledTimes(1);
    expect(secondMetadata).toEqual(firstMetadata);
  });

  describe('seedTarballLookup', () => {
    // The seed lookup lets us ship prebuilt tarballs inside the app bundle so
    // first-launch installs skip the npm registry. The contract: when the
    // lookup returns a path, the install argument becomes `file:<path>` —
    // everything else (entry resolution, metadata shape, install root)
    // stays identical.
    it('uses file:<seed-path> as the install argument when a seed is available', async () => {
      const seedPath = path.join(userDataPath, 'seeds', 'example-package-1.2.3.tgz');
      const seedContents = 'fake-tarball-bytes';
      await fs.mkdir(path.dirname(seedPath), { recursive: true });
      await fs.writeFile(seedPath, seedContents, 'utf8');
      await writeSeedManifest(seedPath, 'example-package@1.2.3', seedContents);
      const recorded: string[] = [];
      const execFile = createRecordingExamplePackageInstall(recorded);

      const service = createManagedMcpInstallService({
        userDataPath,
        npmPath: 'npm',
        logger: createLogger(),
        execFile,
        seedTarballLookup: (spec) =>
          spec === 'example-package@1.2.3' ? seedPath : null,
      });

      const metadata = await service.install({ packageSpec: 'example-package@1.2.3' });

      expect(recorded).toEqual([`file:${seedPath}`]);
      // Critical invariant: seeded install produces identical layout/metadata
      // shape to a registry install. Downstream consumers must not be able
      // to tell the difference.
      expect(metadata.installRoot).toBe(
        path.join(userDataPath, 'mcp', 'managed-installs', 'example-package@1.2.3'),
      );
      expect(metadata.entryPath).toBe(
        path.join(metadata.installRoot, 'node_modules', 'example-package', 'index.js'),
      );
    });

    it('passes --ignore-scripts for seeded installs and registry fallback installs', async () => {
      const packageSpec = 'example-package@1.2.3';
      const seedPath = path.join(userDataPath, 'seeded-seeds', 'example-package-1.2.3.tgz');
      const seedContents = 'fake-tarball-bytes';
      await fs.mkdir(path.dirname(seedPath), { recursive: true });
      await fs.writeFile(seedPath, seedContents, 'utf8');
      await writeSeedManifest(seedPath, packageSpec, seedContents);

      const seededCommandArgs: string[][] = [];
      const seededService = createManagedMcpInstallService({
        userDataPath: path.join(userDataPath, 'seeded-install-root'),
        npmPath: 'npm',
        logger: createLogger(),
        execFile: createRecordingExamplePackageInstall([], seededCommandArgs),
        seedTarballLookup: (spec) => (spec === packageSpec ? seedPath : null),
      });

      await seededService.install({ packageSpec });

      expect(seededCommandArgs).toHaveLength(1);
      expect(seededCommandArgs[0]).toEqual(
        expect.arrayContaining(['install', `file:${seedPath}`, '--ignore-scripts']),
      );

      const fallbackSeedPath = path.join(
        userDataPath,
        'fallback-seeds',
        'example-package-1.2.3.tgz',
      );
      const fallbackSeedContents = 'tampered-tarball-bytes';
      await fs.mkdir(path.dirname(fallbackSeedPath), { recursive: true });
      await fs.writeFile(fallbackSeedPath, fallbackSeedContents, 'utf8');
      await writeSeedManifest(
        fallbackSeedPath,
        packageSpec,
        fallbackSeedContents,
        sha256('original-tarball-bytes'),
      );

      const fallbackCommandArgs: string[][] = [];
      const fallbackService = createManagedMcpInstallService({
        userDataPath: path.join(userDataPath, 'fallback-install-root'),
        npmPath: 'npm',
        logger: createLogger(),
        execFile: createRecordingExamplePackageInstall([], fallbackCommandArgs),
        seedTarballLookup: (spec) => (spec === packageSpec ? fallbackSeedPath : null),
      });

      await fallbackService.install({ packageSpec });

      expect(fallbackCommandArgs).toHaveLength(1);
      expect(fallbackCommandArgs[0]).toEqual(
        expect.arrayContaining(['install', packageSpec, '--ignore-scripts']),
      );
    });

    it('falls back to registry and reports a breadcrumb when a seed sha256 mismatches the manifest', async () => {
      const packageSpec = 'example-package@1.2.3';
      const seedPath = path.join(userDataPath, 'seeds', 'example-package-1.2.3.tgz');
      const seedContents = 'tampered-tarball-bytes';
      const expectedSha = sha256('original-tarball-bytes');
      await fs.mkdir(path.dirname(seedPath), { recursive: true });
      await fs.writeFile(seedPath, seedContents, 'utf8');
      await writeSeedManifest(seedPath, packageSpec, seedContents, expectedSha);

      const logger = createLogger();
      const recorded: string[] = [];
      const execFile = createRecordingExamplePackageInstall(recorded);

      const service = createManagedMcpInstallService({
        userDataPath,
        npmPath: 'npm',
        logger,
        execFile,
        seedTarballLookup: (spec) => (spec === packageSpec ? seedPath : null),
      });

      await service.install({ packageSpec });

      const actualSha = sha256(seedContents);
      expect(recorded).toEqual([packageSpec]);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          packageSpec,
          expectedSha,
          actualSha,
        }),
        expect.stringContaining('integrity verification'),
      );
      expect(errorReporterMocks.addBreadcrumb).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'managed-mcp-install',
          level: 'error',
          data: expect.objectContaining({
            packageSpec,
            expectedSha,
            actualSha,
          }),
        }),
      );
    });

    it('falls back to registry when a seed manifest is missing', async () => {
      const packageSpec = 'example-package@1.2.3';
      const seedPath = path.join(userDataPath, 'seeds', 'example-package-1.2.3.tgz');
      await fs.mkdir(path.dirname(seedPath), { recursive: true });
      await fs.writeFile(seedPath, 'legacy-seed-without-manifest', 'utf8');

      const logger = createLogger();
      const recorded: string[] = [];
      const execFile = createRecordingExamplePackageInstall(recorded);

      const service = createManagedMcpInstallService({
        userDataPath,
        npmPath: 'npm',
        logger,
        execFile,
        seedTarballLookup: (spec) => (spec === packageSpec ? seedPath : null),
      });

      await service.install({ packageSpec });

      expect(recorded).toEqual([packageSpec]);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'managed_install_seeds_manifest_missing',
          packageSpec,
        }),
        expect.stringContaining('manifest missing'),
      );
    });

    it('falls back to registry when the seed is absent from the manifest', async () => {
      const packageSpec = 'example-package@1.2.3';
      const seedPath = path.join(userDataPath, 'seeds', 'example-package-1.2.3.tgz');
      const seedContents = 'fake-tarball-bytes';
      await fs.mkdir(path.dirname(seedPath), { recursive: true });
      await fs.writeFile(seedPath, seedContents, 'utf8');
      await fs.writeFile(
        path.join(path.dirname(seedPath), 'seeds-manifest.json'),
        JSON.stringify({
          version: 1,
          seeds: [
            {
              filename: 'different-package-1.0.0.tgz',
              packageSpec: 'different-package@1.0.0',
              sha256: sha256(seedContents),
              sizeBytes: Buffer.byteLength(seedContents),
            },
          ],
        }),
        'utf8',
      );

      const logger = createLogger();
      const recorded: string[] = [];
      const execFile = createRecordingExamplePackageInstall(recorded);

      const service = createManagedMcpInstallService({
        userDataPath,
        npmPath: 'npm',
        logger,
        execFile,
        seedTarballLookup: (spec) => (spec === packageSpec ? seedPath : null),
      });

      await service.install({ packageSpec });

      expect(recorded).toEqual([packageSpec]);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'managed_install_seed_manifest_entry_missing',
          packageSpec,
        }),
        expect.stringContaining('missing from manifest'),
      );
    });

    it('falls back to the package spec when the seed lookup returns null', async () => {
      const recorded: string[] = [];
      const execFile = createRecordingExamplePackageInstall(recorded);

      const service = createManagedMcpInstallService({
        userDataPath,
        npmPath: 'npm',
        logger: createLogger(),
        execFile,
        seedTarballLookup: () => null,
      });

      await service.install({ packageSpec: 'example-package@1.2.3' });
      expect(recorded).toEqual(['example-package@1.2.3']);
    });

    it('falls back to registry when the seed manifest is not valid JSON', async () => {
      const packageSpec = 'example-package@1.2.3';
      const seedPath = path.join(userDataPath, 'seeds', 'example-package-1.2.3.tgz');
      await fs.mkdir(path.dirname(seedPath), { recursive: true });
      await fs.writeFile(seedPath, 'fake-tarball-bytes', 'utf8');
      await fs.writeFile(
        path.join(path.dirname(seedPath), 'seeds-manifest.json'),
        '{"version": 1, "seeds": [',
        'utf8',
      );

      const logger = createLogger();
      const recorded: string[] = [];
      const execFile = createRecordingExamplePackageInstall(recorded);

      const service = createManagedMcpInstallService({
        userDataPath,
        npmPath: 'npm',
        logger,
        execFile,
        seedTarballLookup: (spec) => (spec === packageSpec ? seedPath : null),
      });

      await service.install({ packageSpec });

      expect(recorded).toEqual([packageSpec]);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'managed_install_seeds_manifest_invalid_json',
          packageSpec,
        }),
        expect.stringContaining('not valid JSON'),
      );
    });

    it('falls back to registry when the seed manifest schema is wrong', async () => {
      const packageSpec = 'example-package@1.2.3';
      const seedPath = path.join(userDataPath, 'seeds', 'example-package-1.2.3.tgz');
      await fs.mkdir(path.dirname(seedPath), { recursive: true });
      await fs.writeFile(seedPath, 'fake-tarball-bytes', 'utf8');
      await fs.writeFile(
        path.join(path.dirname(seedPath), 'seeds-manifest.json'),
        JSON.stringify({ version: 1, seeds: 'not-an-array' }),
        'utf8',
      );

      const logger = createLogger();
      const recorded: string[] = [];
      const execFile = createRecordingExamplePackageInstall(recorded);

      const service = createManagedMcpInstallService({
        userDataPath,
        npmPath: 'npm',
        logger,
        execFile,
        seedTarballLookup: (spec) => (spec === packageSpec ? seedPath : null),
      });

      await service.install({ packageSpec });

      expect(recorded).toEqual([packageSpec]);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'managed_install_seeds_manifest_invalid_schema',
          packageSpec,
        }),
        expect.stringContaining('invalid schema'),
      );
    });

    it('falls back to registry when a manifest entry has a non-hex sha256', async () => {
      const packageSpec = 'example-package@1.2.3';
      const seedPath = path.join(userDataPath, 'seeds', 'example-package-1.2.3.tgz');
      const seedContents = 'fake-tarball-bytes';
      await fs.mkdir(path.dirname(seedPath), { recursive: true });
      await fs.writeFile(seedPath, seedContents, 'utf8');
      await fs.writeFile(
        path.join(path.dirname(seedPath), 'seeds-manifest.json'),
        JSON.stringify({
          version: 1,
          seeds: [
            {
              filename: path.basename(seedPath),
              packageSpec,
              sha256: 'not-a-hex-sha-256',
              sizeBytes: Buffer.byteLength(seedContents),
            },
          ],
        }),
        'utf8',
      );

      const logger = createLogger();
      const recorded: string[] = [];
      const execFile = createRecordingExamplePackageInstall(recorded);

      const service = createManagedMcpInstallService({
        userDataPath,
        npmPath: 'npm',
        logger,
        execFile,
        seedTarballLookup: (spec) => (spec === packageSpec ? seedPath : null),
      });

      await service.install({ packageSpec });

      expect(recorded).toEqual([packageSpec]);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'managed_install_seeds_manifest_invalid_schema',
          packageSpec,
        }),
        expect.stringContaining('invalid schema'),
      );
    });

    it('falls back to registry when a manifest entry filename contains path traversal', async () => {
      // The seed filename comes from the SEEDED_PACKAGE_FILENAMES constant inside
      // the service, so a malicious manifest entry with a traversal-shaped
      // filename can never escape the seeds directory at file-read time. But the
      // matcher compares manifest filename to the actual seed basename, so a
      // traversal-shaped filename simply fails the entry lookup -- assert that
      // fallback still happens cleanly without confusion.
      const packageSpec = 'example-package@1.2.3';
      const seedPath = path.join(userDataPath, 'seeds', 'example-package-1.2.3.tgz');
      const seedContents = 'fake-tarball-bytes';
      await fs.mkdir(path.dirname(seedPath), { recursive: true });
      await fs.writeFile(seedPath, seedContents, 'utf8');
      await fs.writeFile(
        path.join(path.dirname(seedPath), 'seeds-manifest.json'),
        JSON.stringify({
          version: 1,
          seeds: [
            {
              filename: '../etc/passwd',
              packageSpec,
              sha256: sha256(seedContents),
              sizeBytes: Buffer.byteLength(seedContents),
            },
          ],
        }),
        'utf8',
      );

      const logger = createLogger();
      const recorded: string[] = [];
      const execFile = createRecordingExamplePackageInstall(recorded);

      const service = createManagedMcpInstallService({
        userDataPath,
        npmPath: 'npm',
        logger,
        execFile,
        seedTarballLookup: (spec) => (spec === packageSpec ? seedPath : null),
      });

      await service.install({ packageSpec });

      expect(recorded).toEqual([packageSpec]);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'managed_install_seed_manifest_entry_missing',
          packageSpec,
        }),
        expect.stringContaining('missing from manifest'),
      );
    });
  });

  describe('source.localTarball (pre-publish test seam)', () => {
    // Public API extension consumed by scripts/dev-mcp-managed-install.ts.
    // Lets the engineer pre-populate the managed-install slot from a locally
    // built tarball so the same `node <managed-install-path>` spawn path
    // production uses runs the candidate code. Behaviour-fidelity invariant:
    // resulting on-disk layout + metadata are identical to a registry install.

    const createTarballSimulatingExec = (
      installedVersion: string,
      packageName = 'example-package',
    ): ManagedExecFile =>
      asExecFile(async (_file, args, options, callback) => {
        const cwd = options.cwd;
        if (typeof cwd !== 'string') throw new Error('cwd required');
        const installArg = args[args.indexOf('install') + 1];
        if (typeof installArg !== 'string') {
          throw new Error('expected install arg');
        }
        const packageDir = path.join(cwd, 'node_modules', ...packageName.split('/'));
        await fs.mkdir(packageDir, { recursive: true });
        await fs.writeFile(
          path.join(packageDir, 'package.json'),
          JSON.stringify({ name: packageName, version: installedVersion, main: 'index.js' }),
          'utf8',
        );
        await fs.writeFile(path.join(packageDir, 'index.js'), 'module.exports={};\n', 'utf8');
        callback(null, '', '');
      });

    it('uses file:<absolute-path> as the install argument when source.localTarball is provided', async () => {
      const tarballPath = path.join(userDataPath, 'candidate.tgz');
      await fs.writeFile(tarballPath, 'fake-tarball-bytes', 'utf8');
      const recorded: string[] = [];
      const service = createManagedMcpInstallService({
        userDataPath,
        npmPath: 'npm',
        logger: createLogger(),
        execFile: asExecFile(async (_file, args, options, callback) => {
          recorded.push(args[args.indexOf('install') + 1] ?? '');
          const cwd = options.cwd as string;
          const packageDir = path.join(cwd, 'node_modules', 'example-package');
          await fs.mkdir(packageDir, { recursive: true });
          await fs.writeFile(
            path.join(packageDir, 'package.json'),
            JSON.stringify({ name: 'example-package', version: '1.2.3', main: 'index.js' }),
            'utf8',
          );
          await fs.writeFile(path.join(packageDir, 'index.js'), 'module.exports={};\n', 'utf8');
          callback(null, '', '');
        }),
        // Critical invariant: seed lookup is bypassed entirely when the caller
        // supplies a tarball. We can't accidentally fall back to a stale seed.
        seedTarballLookup: () => path.join(userDataPath, 'should-be-ignored.tgz'),
      });

      const metadata = await service.install({
        packageSpec: 'example-package@1.2.3',
        source: { localTarball: tarballPath },
      });

      expect(recorded).toEqual([`file:${tarballPath}`]);
      expect(metadata.installRoot).toBe(
        path.join(userDataPath, 'mcp', 'managed-installs', 'example-package@1.2.3'),
      );
      expect(metadata.entryPath).toBe(
        path.join(metadata.installRoot, 'node_modules', 'example-package', 'index.js'),
      );
    });

    it('writes .install-meta.json that round-trips through getMetadata (steady-state contract)', async () => {
      // This is the critical contract the bash-flow proposal failed — without
      // valid metadata, auto-upgrade treats the slot as invalid and reinstalls
      // from the registry, which 404s pre-publish.
      const tarballPath = path.join(userDataPath, 'candidate.tgz');
      await fs.writeFile(tarballPath, 'fake', 'utf8');
      const service = createManagedMcpInstallService({
        userDataPath,
        npmPath: 'npm',
        logger: createLogger(),
        execFile: createTarballSimulatingExec('0.2.0', '@mindstone/mcp-server-hubspot'),
      });

      const installed = await service.install({
        packageSpec: '@mindstone/mcp-server-hubspot@0.2.0',
        source: { localTarball: tarballPath },
      });

      const roundTripped = await service.getMetadata('@mindstone/mcp-server-hubspot@0.2.0');
      expect(roundTripped).toEqual(installed);
      expect(await service.isInstalled('@mindstone/mcp-server-hubspot@0.2.0')).toBe(true);
    });

    it('preserves production npm flags (--ignore-scripts, --no-audit, --no-fund, --no-progress)', async () => {
      const tarballPath = path.join(userDataPath, 'candidate.tgz');
      await fs.writeFile(tarballPath, 'fake', 'utf8');
      const recordedArgs: string[][] = [];
      const service = createManagedMcpInstallService({
        userDataPath,
        npmPath: 'npm',
        logger: createLogger(),
        execFile: asExecFile(async (_file, args, options, callback) => {
          recordedArgs.push([...args]);
          const cwd = options.cwd as string;
          const packageDir = path.join(cwd, 'node_modules', 'example-package');
          await fs.mkdir(packageDir, { recursive: true });
          await fs.writeFile(
            path.join(packageDir, 'package.json'),
            JSON.stringify({ name: 'example-package', version: '1.2.3', main: 'index.js' }),
            'utf8',
          );
          await fs.writeFile(path.join(packageDir, 'index.js'), 'module.exports={};\n', 'utf8');
          callback(null, '', '');
        }),
      });

      await service.install({
        packageSpec: 'example-package@1.2.3',
        source: { localTarball: tarballPath },
      });

      expect(recordedArgs).toHaveLength(1);
      expect(recordedArgs[0]).toEqual(
        expect.arrayContaining([
          'install',
          `file:${tarballPath}`,
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          '--no-progress',
        ]),
      );
    });

    it('throws ManagedMcpInstallError when the tarball path is not absolute', async () => {
      const service = createManagedMcpInstallService({
        userDataPath,
        npmPath: 'npm',
        logger: createLogger(),
        execFile: createExecFileSuccess(),
      });

      await expect(
        service.install({
          packageSpec: 'example-package@1.2.3',
          source: { localTarball: './relative-path.tgz' },
        }),
      ).rejects.toThrow(/must be an absolute path/);
    });

    it('throws ManagedMcpInstallError when the tarball file does not exist', async () => {
      const service = createManagedMcpInstallService({
        userDataPath,
        npmPath: 'npm',
        logger: createLogger(),
        execFile: createExecFileSuccess(),
      });

      await expect(
        service.install({
          packageSpec: 'example-package@1.2.3',
          source: { localTarball: path.join(userDataPath, 'does-not-exist.tgz') },
        }),
      ).rejects.toThrow(/does not exist or is unreadable/);
    });

    it('throws when the installed tarball version mismatches the spec version (silent-drift guard)', async () => {
      // Engineer packs 0.1.9 into the 0.2.0 slot by accident; the test must
      // refuse rather than produce a green smoke that runs stale code.
      const tarballPath = path.join(userDataPath, 'candidate.tgz');
      await fs.writeFile(tarballPath, 'fake', 'utf8');
      const service = createManagedMcpInstallService({
        userDataPath,
        npmPath: 'npm',
        logger: createLogger(),
        execFile: createTarballSimulatingExec('0.1.9', '@mindstone/mcp-server-hubspot'),
      });

      await expect(
        service.install({
          packageSpec: '@mindstone/mcp-server-hubspot@0.2.0',
          source: { localTarball: tarballPath },
        }),
      ).rejects.toThrow(/version mismatch.*0\.2\.0.*0\.1\.9/);

      // And the install root must not exist after the failure — no half-
      // populated state, no phantom .install-meta.json to confuse auto-upgrade.
      const installRoot = service.getInstallRoot('@mindstone/mcp-server-hubspot@0.2.0');
      await expect(fs.access(installRoot)).rejects.toThrow();
    });

    it('writes a .dev-pre-publish-build.json sentinel beside .install-meta.json', async () => {
      // Sentinel is the safety net for opus Q5: engineer forgets `uninstall`,
      // then ships fixes against a phantom local-build repro. Startup banner
      // (managedMcpAutoUpgrade.scanForDevPrePublishSentinels) reads this file.
      const tarballPath = path.join(userDataPath, 'candidate.tgz');
      await fs.writeFile(tarballPath, 'fake', 'utf8');
      const service = createManagedMcpInstallService({
        userDataPath,
        npmPath: 'npm',
        logger: createLogger(),
        execFile: createTarballSimulatingExec('0.2.0', '@mindstone/mcp-server-hubspot'),
      });

      const metadata = await service.install({
        packageSpec: '@mindstone/mcp-server-hubspot@0.2.0',
        source: { localTarball: tarballPath },
      });

      const sentinelPath = path.join(metadata.installRoot, DEV_PRE_PUBLISH_SENTINEL_FILENAME);
      const sentinelRaw = await fs.readFile(sentinelPath, 'utf8');
      const sentinel = JSON.parse(sentinelRaw) as DevPrePublishSentinel;
      expect(sentinel.source).toBe('pre-publish-test');
      expect(sentinel.tarballPath).toBe(tarballPath);
      expect(sentinel.metaVersion).toBe(1);
      expect(sentinel.installedAt).toBe(metadata.installedAt);
    });

    it('does NOT write a sentinel for normal registry installs', async () => {
      // Negative case: production install path stays unchanged. Only local-
      // tarball installs leave a sentinel; otherwise the banner would fire
      // for every user.
      const service = createManagedMcpInstallService({
        userDataPath,
        npmPath: 'npm',
        logger: createLogger(),
        execFile: createExecFileSuccess({
          packageJson: { name: 'example-package', version: '1.2.3', main: 'index.js' },
        }),
      });

      const metadata = await service.install({ packageSpec: 'example-package@1.2.3' });

      const sentinelPath = path.join(metadata.installRoot, DEV_PRE_PUBLISH_SENTINEL_FILENAME);
      await expect(fs.access(sentinelPath)).rejects.toThrow();
    });

    it('atomically replaces an existing install (force-equivalent semantics)', async () => {
      // Two consecutive iterations of the pre-publish loop must produce two
      // independent installs; the second cannot piggyback on the first's
      // metadata via the dedupe key (we use a force-style key for tarball
      // installs precisely so the engineer's `install` invocation always
      // produces a fresh result).
      const tarballPath = path.join(userDataPath, 'candidate.tgz');
      await fs.writeFile(tarballPath, 'fake', 'utf8');
      const execFileSpy = vi.fn(createTarballSimulatingExec('0.2.0', '@mindstone/mcp-server-hubspot'));
      const service = createManagedMcpInstallService({
        userDataPath,
        npmPath: 'npm',
        logger: createLogger(),
        execFile: execFileSpy as unknown as ManagedExecFile,
      });

      const first = await service.install({
        packageSpec: '@mindstone/mcp-server-hubspot@0.2.0',
        source: { localTarball: tarballPath },
      });
      const second = await service.install({
        packageSpec: '@mindstone/mcp-server-hubspot@0.2.0',
        source: { localTarball: tarballPath },
      });

      expect(execFileSpy).toHaveBeenCalledTimes(2);
      expect(second.installRoot).toBe(first.installRoot);
      // Both metadata blobs are functionally identical (timestamps differ).
      expect(second.entryPath).toBe(first.entryPath);
      expect(second.version).toBe(first.version);
    });
  });

  describe('defaultSeedTarballLookup (resourcesPath / dev fallback)', () => {
    // These tests cover the `process.resourcesPath` (packaged) and stable
    // repo-root dev resolution that the default lookup uses in production.
    // Without coverage here, the `forge.config.cjs` copy step could land seeds
    // in the wrong subdirectory and the install service would silently fall
    // back to the registry — exactly the bug this pipeline exists to prevent.
    let originalResourcesPath: string | undefined;
    let originalCwd: () => string;

    beforeEach(() => {
      originalResourcesPath = (process as unknown as { resourcesPath?: string })
        .resourcesPath;
      originalCwd = process.cwd;
    });

    afterEach(() => {
      if (originalResourcesPath === undefined) {
        delete (process as unknown as { resourcesPath?: string }).resourcesPath;
      } else {
        (process as unknown as { resourcesPath: string }).resourcesPath =
          originalResourcesPath;
      }
      process.cwd = originalCwd;
      vi.unstubAllEnvs();
    });

    it('returns null for unseeded specs (only Office is seeded today)', () => {
      expect(defaultSeedTarballLookup('some-other-package@1.0.0')).toBeNull();
    });

    it('returns null when seeds dir does not exist (forge skipped or not built)', async () => {
      const fakeRoot = path.join(userDataPath, 'fresh-repo-root');
      await fs.mkdir(fakeRoot, { recursive: true });
      await fs.writeFile(
        path.join(fakeRoot, 'package.json'),
        JSON.stringify({ name: 'mindstone-rebel' }),
        'utf8',
      );
      setPlatformConfig(createTestPlatformConfig(fakeRoot, userDataPath));
      expect(defaultSeedTarballLookup(OFFICE_MCP_PACKAGE_SPEC)).toBeNull();
    });

    it('finds the Office seed in the dev path via PlatformConfig.appPath, not process.cwd()', async () => {
      // Build the dev directory layout the seed script would produce.
      const fakeRoot = path.join(userDataPath, 'fake-repo-root');
      await fs.mkdir(fakeRoot, { recursive: true });
      await fs.writeFile(
        path.join(fakeRoot, 'package.json'),
        JSON.stringify({ name: 'mindstone-rebel' }),
        'utf8',
      );
      const seedDir = path.join(fakeRoot, 'dist', MANAGED_INSTALL_SEEDS_SUBDIR);
      await fs.mkdir(seedDir, { recursive: true });
      const seedPath = path.join(seedDir, OFFICE_MCP_SEED_TARBALL_FILENAME);
      // Write a non-empty file so statSync().isFile() returns true.
      await fs.writeFile(seedPath, 'fake-tarball-bytes');

      // cwd is deliberately wrong; appPath anchors lookup to the repo root.
      process.cwd = () => path.join(userDataPath, 'not-the-repo-root');
      setPlatformConfig(createTestPlatformConfig(fakeRoot, userDataPath));
      delete (process as unknown as { resourcesPath?: string }).resourcesPath;

      expect(defaultSeedTarballLookup(OFFICE_MCP_PACKAGE_SPEC)).toBe(seedPath);
    });

    it('finds the Office seed in the packaged path: <resourcesPath>/managed-install-seeds', async () => {
      // Build the layout `forge.config.cjs::packageAfterCopy::Step 6b` produces.
      const resourcesDir = path.join(userDataPath, 'fake-app-resources');
      const seedDir = path.join(resourcesDir, MANAGED_INSTALL_SEEDS_SUBDIR);
      await fs.mkdir(seedDir, { recursive: true });
      const seedPath = path.join(seedDir, OFFICE_MCP_SEED_TARBALL_FILENAME);
      await fs.writeFile(seedPath, 'fake-tarball-bytes');

      (process as unknown as { resourcesPath: string }).resourcesPath =
        resourcesDir;
      setPlatformConfig(createTestPlatformConfig(resourcesDir, userDataPath, true));
      process.cwd = () => path.join(userDataPath, 'not-the-resources-dir');

      const result = defaultSeedTarballLookup(OFFICE_MCP_PACKAGE_SPEC);
      expect(result).toBe(seedPath);
    });

    it('end-to-end: simulating forge copy step lands the tarball where install service finds it', async () => {
      // Black-box test of the full pipeline contract:
      //   1. Seed script puts tarball in `dist/managed-install-seeds/`
      //   2. Forge copies `dist/managed-install-seeds/` → `resources/managed-install-seeds/`
      //   3. Install service's default lookup finds it via process.resourcesPath
      //
      // We exercise (2) and (3) directly with fs.cp to validate the path
      // contract; (1) is tested separately by the seed-script integration test.
      const distSeedDir = path.join(
        userDataPath,
        'repo',
        'dist',
        MANAGED_INSTALL_SEEDS_SUBDIR,
      );
      await fs.mkdir(distSeedDir, { recursive: true });
      const tarballName = OFFICE_MCP_SEED_TARBALL_FILENAME;
      await fs.writeFile(
        path.join(distSeedDir, tarballName),
        'pretend-this-is-a-real-tgz',
      );

      // Simulate Step 6b copy.
      const resourcesDir = path.join(userDataPath, 'app-bundle-resources');
      const resourceSeedDir = path.join(
        resourcesDir,
        MANAGED_INSTALL_SEEDS_SUBDIR,
      );
      await fs.cp(distSeedDir, resourceSeedDir, {
        recursive: true,
        force: true,
      });

      // Verify the file actually got copied (defends against the
      // forge-step ever reaching for the wrong source path).
      const copied = await fs.stat(
        path.join(resourceSeedDir, tarballName),
      );
      expect(copied.isFile()).toBe(true);

      // Then point the install service at the resource dir and confirm it
      // resolves the seed through the packaged resources path.
      (process as unknown as { resourcesPath: string }).resourcesPath =
        resourcesDir;
      setPlatformConfig(createTestPlatformConfig(resourcesDir, userDataPath, true));
      process.cwd = () => path.join(userDataPath, 'not-the-resources-dir');

      const resolved = defaultSeedTarballLookup(OFFICE_MCP_PACKAGE_SPEC);
      expect(resolved).not.toBeNull();
      expect(resolved!.endsWith(tarballName)).toBe(true);
    });
  });

  it('reinstalls when force is true', async () => {
    let installCount = 0;
    const execFile = asExecFile(async (_file, args, options, callback) => {
      installCount += 1;
      const cwd = options.cwd;
      if (typeof cwd !== 'string') {
        throw new Error('Expected cwd to be defined');
      }

      const spec = args[1];
      if (typeof spec !== 'string') {
        throw new Error('Expected install spec');
      }

      const parsedSpec = parsePackageSpec(spec);
      const packageDir = path.join(cwd, 'node_modules', parsedSpec.name);
      await fs.mkdir(packageDir, { recursive: true });
      await fs.writeFile(
        path.join(packageDir, 'package.json'),
        JSON.stringify(
          {
            name: parsedSpec.name,
            version: parsedSpec.version,
            main: 'index.js',
          },
          null,
          2
        ),
        'utf8'
      );
      await fs.writeFile(
        path.join(packageDir, 'index.js'),
        `module.exports = ${installCount};\n`,
        'utf8'
      );
      callback(null, '', '');
    });

    const service = createManagedMcpInstallService({
      userDataPath,
      npmPath: 'npm',
      logger: createLogger(),
      execFile,
    });

    const firstMetadata = await service.install({ packageSpec: 'example-package@1.2.3' });
    const secondMetadata = await service.install({ packageSpec: 'example-package@1.2.3', force: true });

    expect(installCount).toBe(2);
    expect(secondMetadata.installRoot).toBe(firstMetadata.installRoot);
    expect(secondMetadata.installedAt).not.toBe(firstMetadata.installedAt);
    expect(await fs.readFile(secondMetadata.entryPath, 'utf8')).toContain('module.exports = 2');
  });

  it('throws on an unpinned package spec during install', async () => {
    const service = createManagedMcpInstallService({
      userDataPath,
      npmPath: 'npm',
      logger: createLogger(),
      execFile: createExecFileSuccess(),
    });

    await expect(service.install({ packageSpec: '@mindstone/server' })).rejects.toThrow(
      UnpinnedPackageSpecError
    );
  });

  it('throws an InstallTimeoutError when installation exceeds timeoutMs', async () => {
    const service = createManagedMcpInstallService({
      userDataPath,
      npmPath: 'npm',
      logger: createLogger(),
      execFile: asExecFile((_file, _args, _options, callback) => {
        setTimeout(() => callback(null, '', ''), 100);
      }),
    });

    const installPromise = service.install({
      packageSpec: 'example-package@1.2.3',
      timeoutMs: 25,
    });

    await expect(installPromise).rejects.toThrow(InstallTimeoutError);
  }, 5_000);

  it('leaves no install root residue when execFile fails', async () => {
    const service = createManagedMcpInstallService({
      userDataPath,
      npmPath: 'npm',
      logger: createLogger(),
      execFile: asExecFile(async (_file, args, options, callback) => {
        const cwd = options.cwd;
        if (typeof cwd !== 'string') {
          throw new Error('Expected cwd to be defined');
        }

        const spec = args[1];
        if (typeof spec !== 'string') {
          throw new Error('Expected install spec');
        }

        const parsedSpec = parsePackageSpec(spec);
        const packageDir = path.join(cwd, 'node_modules', parsedSpec.name);
        await fs.mkdir(packageDir, { recursive: true });
        await fs.writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ name: parsedSpec.name }), 'utf8');

        const error = Object.assign(new Error('npm install failed'), {
          code: 1,
          stderr: 'network exploded',
        });
        callback(error, '', 'network exploded');
      }),
    });

    await expect(service.install({ packageSpec: 'example-package@1.2.3' })).rejects.toThrow(
      ManagedMcpInstallError
    );

    const installRoot = service.getInstallRoot('example-package@1.2.3');
    expect(await fs.stat(installRoot).catch(() => null)).toBeNull();

    const managedRoot = path.join(userDataPath, 'mcp', 'managed-installs');
    const entries = await fs.readdir(managedRoot).catch(() => []);
    expect(entries.filter((entry) => entry.startsWith('.tmp-'))).toHaveLength(0);
  });

  it('returns existing metadata when rename loses a race to an already-installed target', async () => {
    const packageSpec = 'example-package@1.2.3';
    const installRoot = path.join(userDataPath, 'mcp', 'managed-installs', packageSpec);
    const managedRoot = path.join(userDataPath, 'mcp', 'managed-installs');

    const rename = vi.fn(async (oldPath: string, newPath: string) => {
      if (newPath === installRoot && oldPath.startsWith(path.join(managedRoot, '.tmp-'))) {
        // Simulate a competing install process that completed first: it wrote a
        // valid install (entry file + manifest + metadata) before our rename ran.
        const packageDir = path.join(installRoot, 'node_modules', 'example-package');
        await fs.mkdir(packageDir, { recursive: true });
        await fs.writeFile(
          path.join(packageDir, 'package.json'),
          JSON.stringify({ name: 'example-package', version: '1.2.3', main: 'index.js' }, null, 2),
          'utf8'
        );
        await fs.writeFile(path.join(packageDir, 'index.js'), 'module.exports = {};', 'utf8');
        const targetMetadata: InstallMetadata = {
          packageSpec,
          packageName: 'example-package',
          version: '1.2.3',
          entryPath: path.join(packageDir, 'index.js'),
          installRoot,
          installedAt: '2026-04-16T00:00:00.000Z',
          platform: process.platform,
          nodeVersion: process.version,
          metaVersion: 1,
        };
        await fs.writeFile(
          path.join(installRoot, '.install-meta.json'),
          JSON.stringify(targetMetadata, null, 2),
          'utf8'
        );

        const renameError = Object.assign(new Error('target exists'), { code: 'EEXIST' });
        throw renameError;
      }

      return await fs.rename(oldPath, newPath);
    });

    const racingService = createManagedMcpInstallService({
      userDataPath,
      npmPath: 'npm',
      logger: createLogger(),
      execFile: createExecFileSuccess({
        packageJson: {
          name: 'example-package',
          version: '1.2.3',
          main: 'index.js',
        },
      }),
      rename: rename as unknown as typeof fs.rename,
    });

    const metadata = await racingService.install({ packageSpec });

    expect(metadata.installedAt).toBe('2026-04-16T00:00:00.000Z');
    const entries = await fs.readdir(managedRoot);
    expect(entries.filter((entry) => entry.startsWith('.tmp-'))).toHaveLength(0);
  });

  it('returns a deterministic install root path', () => {
    const service = createManagedMcpInstallService({
      userDataPath,
      npmPath: 'npm',
      logger: createLogger(),
      execFile: createExecFileSuccess(),
    });

    expect(service.getInstallRoot('@scope/example-package@1.2.3')).toBe(
      path.join(userDataPath, 'mcp', 'managed-installs', '@scope', 'example-package@1.2.3')
    );
  });

  it('reports installation state via isInstalled', async () => {
    const service = createManagedMcpInstallService({
      userDataPath,
      npmPath: 'npm',
      logger: createLogger(),
      execFile: createExecFileSuccess(),
    });

    expect(await service.isInstalled('example-package@1.2.3')).toBe(false);
    await service.install({ packageSpec: 'example-package@1.2.3' });
    expect(await service.isInstalled('example-package@1.2.3')).toBe(true);
  });

  it('uninstalls a managed package', async () => {
    const service = createManagedMcpInstallService({
      userDataPath,
      npmPath: 'npm',
      logger: createLogger(),
      execFile: createExecFileSuccess(),
    });

    await service.install({ packageSpec: 'example-package@1.2.3' });
    await service.uninstall('example-package@1.2.3');

    await expect(fs.access(service.getInstallRoot('example-package@1.2.3'))).rejects.toThrow();
  });

  it('cleans up stale temp directories while preserving newer ones', async () => {
    const service = createManagedMcpInstallService({
      userDataPath,
      npmPath: 'npm',
      logger: createLogger(),
      execFile: createExecFileSuccess(),
    });

    const managedRoot = path.join(userDataPath, 'mcp', 'managed-installs');
    await fs.mkdir(managedRoot, { recursive: true });

    const staleDir = path.join(managedRoot, '.tmp-stale');
    const freshDir = path.join(managedRoot, '.tmp-fresh');
    await fs.mkdir(staleDir, { recursive: true });
    await fs.mkdir(freshDir, { recursive: true });

    const staleTime = new Date(Date.now() - (11 * 60 * 1_000));
    const freshTime = new Date();
    await fs.utimes(staleDir, staleTime, staleTime);
    await fs.utimes(freshDir, freshTime, freshTime);

    const result = await service.cleanupStaleTempDirs();

    expect(result.removed).toEqual([staleDir]);
    expect(result.errors).toEqual([]);
    await expect(fs.access(staleDir)).rejects.toThrow();
    await expect(fs.access(freshDir)).resolves.toBeUndefined();
  });

  it('cleans up stale backup directories from crashed atomic-replace operations', async () => {
    const service = createManagedMcpInstallService({
      userDataPath,
      npmPath: 'npm',
      logger: createLogger(),
      execFile: createExecFileSuccess(),
    });

    const managedRoot = path.join(userDataPath, 'mcp', 'managed-installs');
    await fs.mkdir(managedRoot, { recursive: true });

    // Backup naming pattern from replaceInstallRootAtomically:
    //   `.${basename}.bak-${pid}-${hex}`
    const staleBackupDir = path.join(managedRoot, '.@[external-email]-99999-abcdef12');
    const freshBackupDir = path.join(managedRoot, '.@[external-email]-88888-11223344');
    // Also make sure non-matching directories are left alone (real installs).
    const realInstallDir = path.join(managedRoot, '@scope-pkg@3.0.0');

    await fs.mkdir(staleBackupDir, { recursive: true });
    await fs.mkdir(freshBackupDir, { recursive: true });
    await fs.mkdir(realInstallDir, { recursive: true });

    const staleTime = new Date(Date.now() - (11 * 60 * 1_000));
    const freshTime = new Date();
    await fs.utimes(staleBackupDir, staleTime, staleTime);
    await fs.utimes(freshBackupDir, freshTime, freshTime);
    await fs.utimes(realInstallDir, staleTime, staleTime); // stale but NOT a backup-pattern

    const result = await service.cleanupStaleTempDirs();

    expect(result.removed).toEqual([staleBackupDir]);
    expect(result.errors).toEqual([]);
    await expect(fs.access(staleBackupDir)).rejects.toThrow();
    await expect(fs.access(freshBackupDir)).resolves.toBeUndefined();
    await expect(fs.access(realInstallDir)).resolves.toBeUndefined();
  });

  describe('entry point resolution', () => {
    it('prefers a string bin field', async () => {
      const service = createManagedMcpInstallService({
        userDataPath,
        npmPath: 'npm',
        logger: createLogger(),
        execFile: createExecFileSuccess({
          packageJson: {
            name: 'example-package',
            version: '1.2.3',
            bin: 'cli.js',
            main: 'index.js',
          },
          files: {
            'cli.js': 'console.log("bin");\n',
            'index.js': 'console.log("main");\n',
          },
        }),
      });

      const metadata = await service.install({ packageSpec: 'example-package@1.2.3' });
      expect(metadata.entryPath).toBe(
        path.join(metadata.installRoot, 'node_modules', 'example-package', 'cli.js')
      );
    });

    it('uses the matching key from a bin object', async () => {
      const service = createManagedMcpInstallService({
        userDataPath,
        npmPath: 'npm',
        logger: createLogger(),
        execFile: createExecFileSuccess({
          packageName: '@scope/example-package',
          packageJson: {
            name: '@scope/example-package',
            version: '1.2.3',
            bin: {
              other: 'other.js',
              'example-package': 'cli.js',
            },
          },
          files: {
            'cli.js': 'console.log("matched");\n',
            'other.js': 'console.log("fallback");\n',
          },
        }),
      });

      const metadata = await service.install({ packageSpec: '@scope/example-package@1.2.3' });
      expect(metadata.entryPath).toBe(
        path.join(metadata.installRoot, 'node_modules', '@scope', 'example-package', 'cli.js')
      );
    });

    it('falls back to the first value from a bin object when no key matches', async () => {
      const service = createManagedMcpInstallService({
        userDataPath,
        npmPath: 'npm',
        logger: createLogger(),
        execFile: createExecFileSuccess({
          packageName: '@scope/example-package',
          packageJson: {
            name: '@scope/example-package',
            version: '1.2.3',
            bin: {
              another: 'first.js',
              extra: 'second.js',
            },
          },
          files: {
            'first.js': 'console.log("first");\n',
            'second.js': 'console.log("second");\n',
          },
        }),
      });

      const metadata = await service.install({ packageSpec: '@scope/example-package@1.2.3' });
      expect(metadata.entryPath).toBe(
        path.join(metadata.installRoot, 'node_modules', '@scope', 'example-package', 'first.js')
      );
    });

    it('falls back to main when bin is absent', async () => {
      const service = createManagedMcpInstallService({
        userDataPath,
        npmPath: 'npm',
        logger: createLogger(),
        execFile: createExecFileSuccess({
          packageJson: {
            name: 'example-package',
            version: '1.2.3',
            main: 'dist/server.js',
          },
          files: {
            'dist/server.js': 'console.log("main");\n',
          },
        }),
      });

      const metadata = await service.install({ packageSpec: 'example-package@1.2.3' });
      expect(metadata.entryPath).toBe(
        path.join(metadata.installRoot, 'node_modules', 'example-package', 'dist', 'server.js')
      );
    });

    it('throws when no entry point resolves to a file', async () => {
      const service = createManagedMcpInstallService({
        userDataPath,
        npmPath: 'npm',
        logger: createLogger(),
        execFile: createExecFileSuccess({
          packageJson: {
            name: 'example-package',
            version: '1.2.3',
          },
          files: {},
        }),
      });

      await expect(service.install({ packageSpec: 'example-package@1.2.3' })).rejects.toThrow(
        InstallEntryPointNotFound
      );
    });
  });

  describe('state validation (phantom-install detection)', () => {
    it('getMetadata returns null when entry file has been deleted after install', async () => {
      const service = createManagedMcpInstallService({
        userDataPath,
        npmPath: 'npm',
        logger: createLogger(),
        execFile: createExecFileSuccess(),
      });

      const metadata = await service.install({ packageSpec: 'example-package@1.2.3' });
      expect(await service.isInstalled('example-package@1.2.3')).toBe(true);

      // Simulate antivirus quarantine / disk cleanup tool deleting the entry file
      await fs.rm(metadata.entryPath, { force: true });

      expect(await service.getMetadata('example-package@1.2.3')).toBeNull();
      expect(await service.isInstalled('example-package@1.2.3')).toBe(false);
    });

    it('getMetadata returns null when installed manifest name mismatches spec', async () => {
      const service = createManagedMcpInstallService({
        userDataPath,
        npmPath: 'npm',
        logger: createLogger(),
        execFile: createExecFileSuccess(),
      });

      const metadata = await service.install({ packageSpec: 'example-package@1.2.3' });

      // Tamper the manifest: rewrite it with a different name
      const manifestPath = path.join(
        metadata.installRoot,
        'node_modules',
        'example-package',
        'package.json',
      );
      await fs.writeFile(
        manifestPath,
        JSON.stringify({ name: 'different-package', version: '1.2.3', main: 'index.js' }, null, 2),
        'utf8',
      );

      expect(await service.getMetadata('example-package@1.2.3')).toBeNull();
      expect(await service.isInstalled('example-package@1.2.3')).toBe(false);
    });

    it('install auto-reinstalls when metadata is present but install state is invalid', async () => {
      const logger = createLogger();
      const execFile = vi.fn(createExecFileSuccess());
      const service = createManagedMcpInstallService({
        userDataPath,
        npmPath: 'npm',
        logger,
        execFile: execFile as unknown as ManagedExecFile,
      });

      const first = await service.install({ packageSpec: 'example-package@1.2.3' });
      expect(execFile).toHaveBeenCalledTimes(1);

      // Nuke the entry file to create a phantom-install state
      await fs.rm(first.entryPath, { force: true });
      expect(await service.isInstalled('example-package@1.2.3')).toBe(false);

      // Second install must detect invalidity and run a real install, not silently
      // return the stale metadata.
      const second = await service.install({ packageSpec: 'example-package@1.2.3' });
      expect(execFile).toHaveBeenCalledTimes(2);
      expect(second.entryPath).toBe(first.entryPath);
      expect(await service.isInstalled('example-package@1.2.3')).toBe(true);
    });
  });

  describe('in-process install dedupe', () => {
    it('deduplicates concurrent install requests for the same spec', async () => {
      let execFileCalls = 0;
      const slowExecFile: ManagedExecFile = asExecFile(async (_file, args, options, callback) => {
        execFileCalls++;
        // Simulate a 30ms install so the second concurrent request overlaps with the first.
        await new Promise((resolve) => setTimeout(resolve, 30));
        const cwd = options.cwd;
        if (typeof cwd !== 'string') throw new Error('cwd required');
        const spec = args[1];
        if (typeof spec !== 'string') throw new Error('spec required');
        const parsed = parsePackageSpec(spec);
        const pkgDir = path.join(cwd, 'node_modules', ...parsed.name.split('/'));
        await fs.mkdir(pkgDir, { recursive: true });
        await fs.writeFile(
          path.join(pkgDir, 'package.json'),
          JSON.stringify({ name: parsed.name, version: parsed.version, main: 'index.js' }, null, 2),
          'utf8',
        );
        await fs.writeFile(path.join(pkgDir, 'index.js'), 'module.exports = {};', 'utf8');
        callback(null, '', '');
      });

      const service = createManagedMcpInstallService({
        userDataPath,
        npmPath: 'npm',
        logger: createLogger(),
        execFile: slowExecFile,
      });

      const [first, second] = await Promise.all([
        service.install({ packageSpec: 'example-package@1.2.3' }),
        service.install({ packageSpec: 'example-package@1.2.3' }),
      ]);

      expect(execFileCalls).toBe(1);
      expect(first.entryPath).toBe(second.entryPath);
      expect(first.installedAt).toBe(second.installedAt);
    });

    it('releases the dedupe slot so subsequent installs can run independently', async () => {
      let execFileCalls = 0;
      const countingExecFile: ManagedExecFile = asExecFile(async (_file, args, options, callback) => {
        execFileCalls++;
        const factory = createExecFileSuccess();
        (factory as unknown as typeof countingExecFile)('npm', args, options, callback);
      });

      const service = createManagedMcpInstallService({
        userDataPath,
        npmPath: 'npm',
        logger: createLogger(),
        execFile: countingExecFile,
      });

      await service.install({ packageSpec: 'example-package@1.2.3' });
      await service.install({ packageSpec: 'example-package@1.2.3' });
      expect(execFileCalls).toBe(1); // second was a cache hit, not a dedupe hit

      // Different spec should run its own install
      await service.install({ packageSpec: 'other-package@1.0.0' });
      expect(execFileCalls).toBe(2);
    });
  });

  describe('post-promotion cleanup resilience', () => {
    it('install succeeds even when backup cleanup fails after a successful promotion', async () => {
      const logger = createLogger();

      // First install creates a live install root
      const service1 = createManagedMcpInstallService({
        userDataPath,
        npmPath: 'npm',
        logger,
        execFile: createExecFileSuccess(),
      });
      await service1.install({ packageSpec: 'example-package@1.2.3' });

      // Second (forced) install: succeed the temp→installRoot swap, then fail cleanup
      // of the backup dir by making fs.rm reject for paths matching the backup name.
      // We do this by wrapping renameImpl: after promotion succeeds, the next fs.rm
      // naturally hits the real filesystem — so we instead stub an alternate service
      // whose rename succeeds but whose post-rename cleanup blows up via a custom
      // implementation. Easiest: patch `fs.rm` globally in this test.
      const realRm = fs.rm;
      const rmSpy = vi.spyOn(fs, 'rm').mockImplementation(async (...args) => {
        const target = String(args[0] ?? '');
        if (target.includes('.bak-')) {
          throw Object.assign(new Error('simulated cleanup failure'), { code: 'EPERM' });
        }
        return realRm.apply(fs, args);
      });

      try {
        const service2 = createManagedMcpInstallService({
          userDataPath,
          npmPath: 'npm',
          logger,
          execFile: createExecFileSuccess(),
        });
        const forced = await service2.install({ packageSpec: 'example-package@1.2.3', force: true });
        expect(forced).toMatchObject({ packageSpec: 'example-package@1.2.3' });
        expect(await service2.isInstalled('example-package@1.2.3')).toBe(true);
      } finally {
        rmSpy.mockRestore();
      }
    });
  });

  describe('Windows MAX_PATH guard', () => {
    const originalPlatform = process.platform;
    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('throws InstallPathTooLongError when install root exceeds Windows budget', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });

      const longUserData = path.join(
        os.tmpdir(),
        'win32-long-path',
        'A'.repeat(140),
      );
      await fs.mkdir(longUserData, { recursive: true });

      try {
        const service = createManagedMcpInstallService({
          userDataPath: longUserData,
          npmPath: 'npm',
          logger: createLogger(),
          execFile: createExecFileSuccess(),
        });

        await expect(
          service.install({ packageSpec: '@scope/pkg@1.2.3' }),
        ).rejects.toBeInstanceOf(InstallPathTooLongError);
      } finally {
        await fs.rm(longUserData, { recursive: true, force: true }).catch(() => undefined);
      }
    });

    it('does NOT throw on non-Windows regardless of path length', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });

      // Use multiple nested segments so each stays under POSIX's 255-byte
      // filename limit while total path length exceeds the Windows budget.
      const longUserData = path.join(
        os.tmpdir(),
        'posix-long',
        'A'.repeat(200),
        'B'.repeat(200),
      );
      await fs.mkdir(longUserData, { recursive: true });

      try {
        const service = createManagedMcpInstallService({
          userDataPath: longUserData,
          npmPath: 'npm',
          logger: createLogger(),
          execFile: createExecFileSuccess(),
        });

        const result = await service.install({ packageSpec: 'example-package@1.2.3' });
        expect(result.packageSpec).toBe('example-package@1.2.3');
      } finally {
        await fs.rm(longUserData, { recursive: true, force: true }).catch(() => undefined);
      }
    });

    it('allows normal-length Windows paths', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });

      const service = createManagedMcpInstallService({
        userDataPath,
        npmPath: 'npm',
        logger: createLogger(),
        execFile: createExecFileSuccess(),
      });

      const result = await service.install({ packageSpec: 'example-package@1.2.3' });
      expect(result.packageSpec).toBe('example-package@1.2.3');
    });
  });

  describe('reinstall-history / quarantine-loop detection', () => {
    const spec = 'example-package@1.2.3';

    it('returns null history for a never-seen spec', async () => {
      const service = createManagedMcpInstallService({
        userDataPath,
        npmPath: 'npm',
        logger: createLogger(),
        execFile: createExecFileSuccess(),
      });
      expect(await service.getReinstallHistory(spec)).toBeNull();
    });

    it('increments on repeated attempts within the window', async () => {
      const service = createManagedMcpInstallService({
        userDataPath,
        npmPath: 'npm',
        logger: createLogger(),
        execFile: createExecFileSuccess(),
      });

      const first = await service.recordReinstallAttempt(spec);
      expect(first.reinstallCount).toBe(1);
      expect(first.quarantined).toBe(false);

      const second = await service.recordReinstallAttempt(spec);
      expect(second.reinstallCount).toBe(2);
      expect(second.firstReinstallAt).toBe(first.firstReinstallAt);
      expect(second.quarantined).toBe(false);

      const third = await service.recordReinstallAttempt(spec);
      expect(third.reinstallCount).toBe(3);
      expect(third.quarantined).toBe(true);
    });

    it('survives across service instances (persisted state)', async () => {
      const first = createManagedMcpInstallService({
        userDataPath,
        npmPath: 'npm',
        logger: createLogger(),
        execFile: createExecFileSuccess(),
      });
      await first.recordReinstallAttempt(spec);
      await first.recordReinstallAttempt(spec);
      await first.recordReinstallAttempt(spec);

      const second = createManagedMcpInstallService({
        userDataPath,
        npmPath: 'npm',
        logger: createLogger(),
        execFile: createExecFileSuccess(),
      });
      const history = await second.getReinstallHistory(spec);
      expect(history).not.toBeNull();
      expect(history!.reinstallCount).toBe(3);
      expect(history!.quarantined).toBe(true);
    });

    it('resets to count=1 when an attempt happens outside the window', async () => {
      const service = createManagedMcpInstallService({
        userDataPath,
        npmPath: 'npm',
        logger: createLogger(),
        execFile: createExecFileSuccess(),
      });

      await service.recordReinstallAttempt(spec);

      // Manually age the history to simulate a cycle > 1 hour ago
      const historyPath = path.join(userDataPath, 'mcp', 'managed-installs', '.managed-install-history.json');
      const raw = await fs.readFile(historyPath, 'utf8');
      const parsed = JSON.parse(raw);
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1_000).toISOString();
      parsed.specs[spec].firstReinstallAt = twoHoursAgo;
      parsed.specs[spec].lastReinstallAt = twoHoursAgo;
      parsed.specs[spec].reinstallCount = 5;
      await fs.writeFile(historyPath, JSON.stringify(parsed, null, 2), 'utf8');

      const next = await service.recordReinstallAttempt(spec);
      expect(next.reinstallCount).toBe(1);
      expect(next.quarantined).toBe(false);
    });

    it('clearReinstallHistory resets state for a spec', async () => {
      const service = createManagedMcpInstallService({
        userDataPath,
        npmPath: 'npm',
        logger: createLogger(),
        execFile: createExecFileSuccess(),
      });
      await service.recordReinstallAttempt(spec);
      await service.recordReinstallAttempt(spec);
      await service.clearReinstallHistory(spec);

      expect(await service.getReinstallHistory(spec)).toBeNull();
    });

    it('handles corrupt history file by starting fresh', async () => {
      const service = createManagedMcpInstallService({
        userDataPath,
        npmPath: 'npm',
        logger: createLogger(),
        execFile: createExecFileSuccess(),
      });

      const managedRoot = path.join(userDataPath, 'mcp', 'managed-installs');
      await fs.mkdir(managedRoot, { recursive: true });
      const historyPath = path.join(managedRoot, '.managed-install-history.json');
      await fs.writeFile(historyPath, '{not valid json', 'utf8');

      const result = await service.recordReinstallAttempt(spec);
      expect(result.reinstallCount).toBe(1);
      expect(result.quarantined).toBe(false);
    });
  });
});
