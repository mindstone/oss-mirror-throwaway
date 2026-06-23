import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { SpaceInfo } from '../spaceService';
import type { SpaceConfig } from '@shared/types';

// Mock electron-store before importing spaceService
vi.mock('electron-store', () => ({
  default: class {
    store: Record<string, unknown> = {};
    get = vi.fn((key: string) => this.store[key]);
    set = vi.fn((key: string, value: unknown) => { this.store[key] = value; });
    delete = vi.fn((key: string) => { delete this.store[key]; });
    has = vi.fn((key: string) => key in this.store);
  }
}));

// Dynamic import after mocks
const spaceService = await import('../spaceService');

describe('spaceService.validateSpacePath', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-validate-path-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('accepts valid relative paths', () => {
    const result = spaceService.validateSpacePath(tempDir, 'work/Company/Project');
    expect(result).toBe(path.join(tempDir, 'work', 'Company', 'Project'));
  });

  it('accepts simple space names', () => {
    const result = spaceService.validateSpacePath(tempDir, 'Personal');
    expect(result).toBe(path.join(tempDir, 'Personal'));
  });

  it('rejects absolute Unix paths', () => {
    expect(() => spaceService.validateSpacePath(tempDir, '/etc/passwd'))
      .toThrow('Space path must be relative to workspace');
  });

  it('rejects absolute Windows paths', () => {
    // On macOS/Linux, C:\Windows is not considered an absolute path by Node's path.isAbsolute()
    // The path validation still catches this via path.resolve() escaping the workspace
    // On Windows, this test would catch it via isAbsolute()
    if (process.platform === 'win32') {
      expect(() => spaceService.validateSpacePath(tempDir, 'C:\\Windows\\System32'))
        .toThrow('Space path must be relative to workspace');
    } else {
      // On Unix, 'C:\\Windows\\System32' is a valid relative path that stays within workspace
      // (the backslashes are just literal characters, not separators)
      const result = spaceService.validateSpacePath(tempDir, 'C:\\Windows\\System32');
      expect(result).toBe(path.join(tempDir, 'C:\\Windows\\System32'));
    }
  });

  it('rejects path traversal with ../', () => {
    expect(() => spaceService.validateSpacePath(tempDir, '../sensitive-data'))
      .toThrow('Path traversal is not permitted');
  });

  it('rejects path traversal with nested ../', () => {
    expect(() => spaceService.validateSpacePath(tempDir, 'work/../../../etc/passwd'))
      .toThrow('Path traversal is not permitted');
  });

  it('rejects path traversal with Windows backslashes', () => {
    expect(() => spaceService.validateSpacePath(tempDir, 'work\\..\\..\\sensitive'))
      .toThrow('Path traversal is not permitted');
  });

  it('rejects empty space path', () => {
    expect(() => spaceService.validateSpacePath(tempDir, ''))
      .toThrow('Space path is required');
  });

  it('rejects whitespace-only space path', () => {
    expect(() => spaceService.validateSpacePath(tempDir, '   '))
      .toThrow('Space path cannot be empty');
  });

  it('rejects null/undefined space path', () => {
    expect(() => spaceService.validateSpacePath(tempDir, null as unknown as string))
      .toThrow('Space path is required');
    expect(() => spaceService.validateSpacePath(tempDir, undefined as unknown as string))
      .toThrow('Space path is required');
  });

  it('rejects when workspace path is empty', () => {
    expect(() => spaceService.validateSpacePath('', 'Personal'))
      .toThrow('Workspace path is required');
  });

  it('trims whitespace from space path', () => {
    const result = spaceService.validateSpacePath(tempDir, '  Personal  ');
    expect(result).toBe(path.join(tempDir, 'Personal'));
  });

  it('rejects single dot path (workspace root)', () => {
    expect(() => spaceService.validateSpacePath(tempDir, '.'))
      .toThrow('Cannot operate on workspace root');
  });

  it('rejects dot-slash path (workspace root)', () => {
    expect(() => spaceService.validateSpacePath(tempDir, './'))
      .toThrow('Cannot operate on workspace root');
  });

  it('rejects paths that normalize to workspace root', () => {
    expect(() => spaceService.validateSpacePath(tempDir, 'foo/..'))
      .toThrow('Path traversal is not permitted');
  });
});

describe('spaceService.removeSpace path security', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-remove-space-'));
    // Create a test space
    const spaceDir = path.join(tempDir, 'TestSpace');
    await fs.mkdir(spaceDir, { recursive: true });
    await fs.writeFile(
      path.join(spaceDir, 'README.md'),
      '---\nrebel_space_description: Test space\n---\n# Test\n',
      'utf8'
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('rejects absolute path attacks', async () => {
    await expect(spaceService.removeSpace(tempDir, '/etc/passwd', false))
      .rejects.toThrow('Space path must be relative to workspace');
  });

  it('rejects path traversal attacks', async () => {
    await expect(spaceService.removeSpace(tempDir, '../../../etc/passwd', false))
      .rejects.toThrow('Path traversal is not permitted');
  });

  it('rejects path traversal with valid prefix', async () => {
    await expect(spaceService.removeSpace(tempDir, 'TestSpace/../../../etc/passwd', false))
      .rejects.toThrow('Path traversal is not permitted');
  });

  it('allows valid space removal', async () => {
    const spaceDir = path.join(tempDir, 'ToRemove');
    await fs.mkdir(spaceDir, { recursive: true });
    
    // Call with removeSymlinkOnly=false since it's a directory
    await spaceService.removeSpace(tempDir, 'ToRemove', false);
    
    // Verify directory was removed
    await expect(fs.access(spaceDir)).rejects.toThrow();
  });

  it('rejects workspace root removal via single dot', async () => {
    await expect(spaceService.removeSpace(tempDir, '.', false))
      .rejects.toThrow('Cannot operate on workspace root');
  });

  it('rejects Chief-of-Staff removal', async () => {
    const cosDir = path.join(tempDir, 'Chief-of-Staff');
    await fs.mkdir(cosDir, { recursive: true });
    
    await expect(spaceService.removeSpace(tempDir, 'Chief-of-Staff', false))
      .rejects.toThrow('Cannot remove Chief-of-Staff space');
  });

  it('rejects Chief-of-Staff removal via case variation', async () => {
    const cosDir = path.join(tempDir, 'Chief-of-Staff');
    await fs.mkdir(cosDir, { recursive: true });
    
    // Case-insensitive comparison should catch variations
    await expect(spaceService.removeSpace(tempDir, 'chief-of-staff', false))
      .rejects.toThrow('Cannot remove Chief-of-Staff space');
    await expect(spaceService.removeSpace(tempDir, 'CHIEF-OF-STAFF', false))
      .rejects.toThrow('Cannot remove Chief-of-Staff space');
  });
});

describe('spaceService.scanSpaces', () => {
  let tempDir: string;
  let chiefOfStaffDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-spaces-test-'));
    chiefOfStaffDir = path.join(tempDir, 'Chief-of-Staff');
    await fs.mkdir(chiefOfStaffDir, { recursive: true });
    // Create minimal Chief-of-Staff README with frontmatter
    await fs.writeFile(
      path.join(chiefOfStaffDir, 'README.md'),
      '---\nrebel_space_description: Chief of Staff router space\nspace_type: router\n---\n# Chief of Staff\n',
      'utf8'
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('treats company as space when README.md has frontmatter', async () => {
    // Setup: work/AcmeConsulting with README.md frontmatter (company IS a space)
    const companyDir = path.join(tempDir, 'work', 'AcmeConsulting');
    await fs.mkdir(companyDir, { recursive: true });
    await fs.writeFile(
      path.join(companyDir, 'README.md'),
      '---\nrebel_space_description: AcmeConsulting consulting space\nspace_type: company\nsharing: private\n---\n# AcmeConsulting\n',
      'utf8'
    );
    
    // Create subdirectories that should NOT appear as separate spaces
    await fs.mkdir(path.join(companyDir, 'memory'), { recursive: true });
    await fs.mkdir(path.join(companyDir, 'scripts'), { recursive: true });

    const spaces = await spaceService.scanSpaces(tempDir);
    
    // Should have: Chief-of-Staff and work/AcmeConsulting (NOT memory/scripts)
    const spacePaths = spaces.map(s => s.path);
    expect(spacePaths).toContain('Chief-of-Staff');
    expect(spacePaths).toContain('work/AcmeConsulting');
    expect(spacePaths).not.toContain('work/AcmeConsulting/memory');
    expect(spacePaths).not.toContain('work/AcmeConsulting/scripts');
  });

  it('treats company as container when README.md has no frontmatter', async () => {
    // Setup: work/Mindstone with README.md but NO frontmatter (company is container)
    const companyDir = path.join(tempDir, 'work', 'Mindstone');
    await fs.mkdir(companyDir, { recursive: true });
    await fs.writeFile(
      path.join(companyDir, 'README.md'),
      '# Mindstone\n\nThis is a container, not a space.\n',
      'utf8'
    );
    
    // Create a proper space within the container
    const projectDir = path.join(companyDir, 'ProjectAlpha');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      path.join(projectDir, 'README.md'),
      '---\nrebel_space_description: Project Alpha workspace\nspace_type: project\nsharing: team\n---\n# Project Alpha\n',
      'utf8'
    );

    const spaces = await spaceService.scanSpaces(tempDir);
    
    const spacePaths = spaces.map(s => s.path);
    // work/Mindstone should NOT be a space (no frontmatter)
    expect(spacePaths).not.toContain('work/Mindstone');
    // But work/Mindstone/ProjectAlpha should be a space
    expect(spacePaths).toContain('work/Mindstone/ProjectAlpha');
  });

  it('scans personal spaces correctly', async () => {
    // Setup: personal space
    const personalDir = path.join(tempDir, 'personal');
    await fs.mkdir(personalDir, { recursive: true });
    await fs.writeFile(
      path.join(personalDir, 'README.md'),
      '---\nrebel_space_description: My personal notes\nspace_type: personal\nsharing: private\n---\n# Personal Notes\n',
      'utf8'
    );

    const spaces = await spaceService.scanSpaces(tempDir);
    
    const spacePaths = spaces.map(s => s.path);
    expect(spacePaths).toContain('personal');
    
    const personalSpace = spaces.find(s => s.path === 'personal');
    expect(personalSpace?.type).toBe('personal');
  });

  it('returns empty array for workspace with no spaces', async () => {
    // Create empty workspace (just Chief-of-Staff)
    const emptyWorkDir = path.join(tempDir, 'work');
    await fs.mkdir(emptyWorkDir, { recursive: true });

    const spaces = await spaceService.scanSpaces(tempDir);
    
    // Should only have Chief-of-Staff
    expect(spaces.length).toBe(1);
    expect(spaces[0].path).toBe('Chief-of-Staff');
  });
});

describe('spaceService.reconcileSpacesWithSettings associated accounts', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-reconcile-spaces-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('preserves explicit local associated accounts while refreshing scanned metadata', async () => {
    const spaceDir = path.join(tempDir, 'work', 'AcmeCorp', 'Shared');
    await fs.mkdir(spaceDir, { recursive: true });

    const scannedSpaces: SpaceInfo[] = [{
      name: 'Shared',
      path: 'work/AcmeCorp/Shared',
      absolutePath: spaceDir,
      type: 'company',
      isSymlink: false,
      hasReadme: true,
      description: 'Updated shared description',
      sharing: 'restricted',
      emails: ['[external-email]'],
      status: 'ok',
    }];
    const currentSettings: SpaceConfig[] = [{
      name: 'Shared',
      path: 'work/AcmeCorp/Shared',
      type: 'company',
      isSymlink: false,
      createdAt: 1234567890,
      description: 'Old description',
      associatedAccounts: [],
    }];

    const reconciled = await spaceService.reconcileSpacesWithSettings(
      tempDir,
      scannedSpaces,
      currentSettings,
    );

    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]).toEqual(expect.objectContaining({
      description: 'Updated shared description',
      associatedAccounts: [],
    }));
  });
});

describe('spaceService.removeSpace ENOENT handling', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-remove-enoent-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('treats ENOENT as success (idempotent removal)', async () => {
    // Try to remove a space that doesn't exist
    // Should NOT throw - treating as success since the goal is for it to not exist
    await expect(spaceService.removeSpace(tempDir, 'NonExistentSpace', true))
      .resolves.toBeUndefined();
  });

  it('throws for non-symlink when removeSymlinkOnly is true', async () => {
    const spaceDir = path.join(tempDir, 'RegularFolder');
    await fs.mkdir(spaceDir, { recursive: true });
    
    await expect(spaceService.removeSpace(tempDir, 'RegularFolder', true))
      .rejects.toThrow('Space is not a symlink. Use moveSpace() to relocate regular folders.');
  });

  it('removes regular folder when removeSymlinkOnly is false', async () => {
    const spaceDir = path.join(tempDir, 'RegularFolder');
    await fs.mkdir(spaceDir, { recursive: true });
    await fs.writeFile(path.join(spaceDir, 'test.txt'), 'content');
    
    await spaceService.removeSpace(tempDir, 'RegularFolder', false);
    
    // Verify folder is gone
    await expect(fs.access(spaceDir)).rejects.toThrow();
  });
});

describe('spaceService.moveSpace', () => {
  let workspaceDir: string;
  let destinationDir: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-workspace-'));
    destinationDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-destination-'));
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(destinationDir, { recursive: true, force: true }).catch(() => {});
  });

  it('moves a folder successfully', async () => {
    // Create a space folder
    const spacePath = path.join(workspaceDir, 'TestSpace');
    await fs.mkdir(spacePath, { recursive: true });
    await fs.writeFile(path.join(spacePath, 'test.txt'), 'hello world');

    const result = await spaceService.moveSpace(workspaceDir, 'TestSpace', destinationDir);

    // Verify move succeeded
    expect(result.newPath).toBe(path.join(destinationDir, 'TestSpace'));
    expect(result.wasCrossDevice).toBe(false); // Same temp filesystem
    
    // Original should be gone
    await expect(fs.access(spacePath)).rejects.toThrow();
    
    // Destination should exist with correct content
    const content = await fs.readFile(path.join(result.newPath, 'test.txt'), 'utf8');
    expect(content).toBe('hello world');
  });

  it('rejects destination inside workspace', async () => {
    const spacePath = path.join(workspaceDir, 'TestSpace');
    const insideWorkspaceDir = path.join(workspaceDir, 'other');
    await fs.mkdir(spacePath, { recursive: true });
    await fs.mkdir(insideWorkspaceDir, { recursive: true });

    await expect(spaceService.moveSpace(workspaceDir, 'TestSpace', insideWorkspaceDir))
      .rejects.toThrow('Destination must be outside the workspace');
  });

  it('rejects destination that is the workspace itself', async () => {
    const spacePath = path.join(workspaceDir, 'TestSpace');
    await fs.mkdir(spacePath, { recursive: true });

    await expect(spaceService.moveSpace(workspaceDir, 'TestSpace', workspaceDir))
      .rejects.toThrow('Destination must be outside the workspace');
  });

  it('rejects symlinks (should use removeSpace instead)', async () => {
    // Create a source folder and symlink
    const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-source-'));
    const symlinkPath = path.join(workspaceDir, 'SymlinkSpace');
    await fs.symlink(sourceDir, symlinkPath, 'dir');

    await expect(spaceService.moveSpace(workspaceDir, 'SymlinkSpace', destinationDir))
      .rejects.toThrow('Cannot move a symlink. Use removeSpace() to remove symlinks.');

    // Cleanup
    await fs.rm(sourceDir, { recursive: true, force: true }).catch(() => {});
  });

  it('rejects if destination already exists', async () => {
    const spacePath = path.join(workspaceDir, 'TestSpace');
    const conflictPath = path.join(destinationDir, 'TestSpace');
    await fs.mkdir(spacePath, { recursive: true });
    await fs.mkdir(conflictPath, { recursive: true }); // Already exists

    await expect(spaceService.moveSpace(workspaceDir, 'TestSpace', destinationDir))
      .rejects.toThrow('A file or folder already exists at destination');
  });

  it('rejects if destination directory does not exist', async () => {
    const spacePath = path.join(workspaceDir, 'TestSpace');
    await fs.mkdir(spacePath, { recursive: true });

    await expect(spaceService.moveSpace(workspaceDir, 'TestSpace', '/nonexistent/path'))
      .rejects.toThrow('Destination directory does not exist');
  });

  it('rejects moving Chief-of-Staff', async () => {
    const cosDir = path.join(workspaceDir, 'Chief-of-Staff');
    await fs.mkdir(cosDir, { recursive: true });

    await expect(spaceService.moveSpace(workspaceDir, 'Chief-of-Staff', destinationDir))
      .rejects.toThrow('Cannot move Chief-of-Staff space');
  });
});

describe('spaceService.reconcileSpacesWithSettings', () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-reconcile-'));
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
  });

  it('adds new spaces found on disk', async () => {
    // Create a space on disk
    const spacePath = path.join(workspaceDir, 'NewSpace');
    await fs.mkdir(spacePath, { recursive: true });
    
    // Simulate scanned spaces (must have status: 'ok' to be added)
    const scannedSpaces: SpaceInfo[] = [
      {
        name: 'NewSpace',
        path: 'NewSpace',
        absolutePath: spacePath,
        type: 'other',
        isSymlink: false,
        hasReadme: true,
        description: 'A new space',
        status: 'ok',
      },
    ];

    // No existing settings
    const result = await spaceService.reconcileSpacesWithSettings(
      workspaceDir,
      scannedSpaces,
      undefined
    );

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('NewSpace');
    expect(result[0].name).toBe('NewSpace');
  });

  it('inherits companyName from an existing sibling when adding a disk-discovered space', async () => {
    const existingSpacePath = path.join(workspaceDir, 'work', 'Mindstone', 'Exec');
    const newSpacePath = path.join(workspaceDir, 'work', 'Mindstone', 'Coaches');
    await fs.mkdir(existingSpacePath, { recursive: true });
    await fs.mkdir(newSpacePath, { recursive: true });

    const existingSettings: SpaceConfig[] = [
      {
        name: 'Exec',
        path: 'work/Mindstone/Exec',
        type: 'project',
        isSymlink: false,
        createdAt: 1234567890,
        companyName: 'Mindstone',
      },
    ];

    const scannedSpaces: SpaceInfo[] = [
      {
        name: 'Coaches',
        path: 'work/Mindstone/Coaches',
        absolutePath: newSpacePath,
        type: 'project',
        isSymlink: false,
        hasReadme: true,
        status: 'ok',
      },
    ];

    const result = await spaceService.reconcileSpacesWithSettings(
      workspaceDir,
      scannedSpaces,
      existingSettings
    );

    const coachesSpace = result.find((space) => space.path === 'work/Mindstone/Coaches');
    expect(coachesSpace?.companyName).toBe('Mindstone');
  });

  it('derives companyName from the work/company/project path when no sibling has companyName', async () => {
    const spacePath = path.join(workspaceDir, 'work', 'Mindstone', 'Coaches');
    await fs.mkdir(spacePath, { recursive: true });

    const scannedSpaces: SpaceInfo[] = [
      {
        name: 'Coaches',
        path: 'work/Mindstone/Coaches',
        absolutePath: spacePath,
        type: 'project',
        isSymlink: false,
        hasReadme: true,
        status: 'ok',
      },
    ];

    const result = await spaceService.reconcileSpacesWithSettings(
      workspaceDir,
      scannedSpaces,
      undefined
    );

    expect(result).toHaveLength(1);
    expect(result[0].companyName).toBe('Mindstone');
  });

  it('leaves companyName undefined when no sibling exists and path does not match the heuristic', async () => {
    const spacePath = path.join(workspaceDir, 'projects', 'Coaches');
    await fs.mkdir(spacePath, { recursive: true });

    const scannedSpaces: SpaceInfo[] = [
      {
        name: 'Coaches',
        path: 'projects/Coaches',
        absolutePath: spacePath,
        type: 'project',
        isSymlink: false,
        hasReadme: true,
        status: 'ok',
      },
    ];

    const result = await spaceService.reconcileSpacesWithSettings(
      workspaceDir,
      scannedSpaces,
      undefined
    );

    expect(result).toHaveLength(1);
    expect(result[0].companyName).toBeUndefined();
  });

  it('does not overwrite existing companyName with a path-derived value during reconcile', async () => {
    const spacePath = path.join(workspaceDir, 'work', 'Mindstone', 'Exec');
    await fs.mkdir(spacePath, { recursive: true });

    const existingSettings: SpaceConfig[] = [
      {
        name: 'Exec',
        path: 'work/Mindstone/Exec',
        type: 'project',
        isSymlink: false,
        createdAt: 1234567890,
        companyName: 'Acme',
      },
    ];

    const scannedSpaces: SpaceInfo[] = [
      {
        name: 'Exec',
        path: 'work/Mindstone/Exec',
        absolutePath: spacePath,
        type: 'project',
        isSymlink: false,
        hasReadme: true,
        status: 'ok',
      },
    ];

    const result = await spaceService.reconcileSpacesWithSettings(
      workspaceDir,
      scannedSpaces,
      existingSettings
    );

    expect(result).toHaveLength(1);
    expect(result[0].companyName).toBe('Acme');
  });

  it('removes spaces that no longer exist on disk (ENOENT)', async () => {
    // Don't create the space on disk - it's "gone"
    const existingSettings: SpaceConfig[] = [
      {
        name: 'DeletedSpace',
        path: 'DeletedSpace',
        type: 'other',
        isSymlink: false,
        createdAt: Date.now(),
      },
    ];

    const result = await spaceService.reconcileSpacesWithSettings(
      workspaceDir,
      [], // No scanned spaces
      existingSettings
    );

    // Should be empty - space was removed
    expect(result).toHaveLength(0);
  });

  it('preserves enriched metadata from settings when updating', async () => {
    // Create a space on disk
    const spacePath = path.join(workspaceDir, 'ExistingSpace');
    await fs.mkdir(spacePath, { recursive: true });

    const existingSettings: SpaceConfig[] = [
      {
        name: 'ExistingSpace',
        path: 'ExistingSpace',
        type: 'personal',
        isSymlink: false,
        createdAt: 1234567890,
        companyName: 'OldCompany',
        storageProvider: 'google_drive',
      },
    ];

    const scannedSpaces: SpaceInfo[] = [
      {
        name: 'ExistingSpace',
        path: 'ExistingSpace',
        absolutePath: spacePath,
        type: 'project', // Changed type
        isSymlink: false,
        hasReadme: true,
        description: 'Updated description',
      },
    ];

    const result = await spaceService.reconcileSpacesWithSettings(
      workspaceDir,
      scannedSpaces,
      existingSettings
    );

    expect(result).toHaveLength(1);
    // SECURITY: Type is NOT updated from frontmatter (prevents spoofing)
    // Local settings are authoritative for type
    expect(result[0].type).toBe('personal'); // Preserves existing type
    expect(result[0].description).toBe('Updated description');
    // Enriched metadata preserved
    expect(result[0].createdAt).toBe(1234567890);
    expect(result[0].companyName).toBe('OldCompany');
    expect(result[0].storageProvider).toBe('google_drive');
  });

  it('keeps space in settings if path exists but not in scan (e.g., missing frontmatter)', async () => {
    // Create folder on disk without frontmatter
    const spacePath = path.join(workspaceDir, 'StillThere');
    await fs.mkdir(spacePath, { recursive: true });

    const existingSettings: SpaceConfig[] = [
      {
        name: 'StillThere',
        path: 'StillThere',
        type: 'other',
        isSymlink: false,
        createdAt: Date.now(),
      },
    ];

    // No scanned spaces (folder exists but no frontmatter)
    const result = await spaceService.reconcileSpacesWithSettings(
      workspaceDir,
      [],
      existingSettings
    );

    // Should keep the entry since folder still exists
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('StillThere');
  });

  it('handles case-insensitive path matching', async () => {
    const spacePath = path.join(workspaceDir, 'TestSpace');
    await fs.mkdir(spacePath, { recursive: true });

    const existingSettings: SpaceConfig[] = [
      {
        name: 'TestSpace',
        path: 'TestSpace', // Original case
        type: 'other',
        isSymlink: false,
        createdAt: 1234567890,
      },
    ];

    const scannedSpaces: SpaceInfo[] = [
      {
        name: 'testspace',
        path: 'testspace', // Different case
        absolutePath: spacePath,
        type: 'project',
        isSymlink: false,
        hasReadme: true,
      },
    ];

    const result = await spaceService.reconcileSpacesWithSettings(
      workspaceDir,
      scannedSpaces,
      existingSettings
    );

    // Should match and update, not add as new
    expect(result).toHaveLength(1);
    expect(result[0].createdAt).toBe(1234567890); // Preserved from settings
  });
});


describe('spaceService.reconcileSpacesWithSettings — writable propagation', () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-writable-'));
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
  });

  it('propagates writable=false from scanned space to SpaceConfig', async () => {
    const spacePath = path.join(workspaceDir, 'ReadOnlyDrive');
    await fs.mkdir(spacePath, { recursive: true });

    const scannedSpaces: SpaceInfo[] = [
      {
        name: 'ReadOnlyDrive',
        path: 'ReadOnlyDrive',
        absolutePath: spacePath,
        type: 'other',
        isSymlink: true,
        hasReadme: true,
        description: 'Shared read-only folder',
        status: 'ok',
        writable: false,
      },
    ];

    const result = await spaceService.reconcileSpacesWithSettings(
      workspaceDir,
      scannedSpaces,
      undefined,
    );

    expect(result).toHaveLength(1);
    expect(result[0].writable).toBe(false);
  });

  it('propagates writable=true from scanned space to SpaceConfig', async () => {
    const spacePath = path.join(workspaceDir, 'WritableDrive');
    await fs.mkdir(spacePath, { recursive: true });

    const scannedSpaces: SpaceInfo[] = [
      {
        name: 'WritableDrive',
        path: 'WritableDrive',
        absolutePath: spacePath,
        type: 'personal',
        isSymlink: false,
        hasReadme: true,
        description: 'My own space',
        status: 'ok',
        writable: true,
      },
    ];

    const result = await spaceService.reconcileSpacesWithSettings(
      workspaceDir,
      scannedSpaces,
      undefined,
    );

    expect(result).toHaveLength(1);
    expect(result[0].writable).toBe(true);
  });

  it('updates writable status when space is re-scanned with changed permissions', async () => {
    const spacePath = path.join(workspaceDir, 'ChangedDrive');
    await fs.mkdir(spacePath, { recursive: true });

    const existingSettings: SpaceConfig[] = [
      {
        name: 'ChangedDrive',
        path: 'ChangedDrive',
        type: 'other',
        isSymlink: true,
        createdAt: Date.now(),
        writable: true, // Previously writable
      },
    ];

    const scannedSpaces: SpaceInfo[] = [
      {
        name: 'ChangedDrive',
        path: 'ChangedDrive',
        absolutePath: spacePath,
        type: 'other',
        isSymlink: true,
        hasReadme: true,

        writable: false, // Now read-only
      },
    ];

    const result = await spaceService.reconcileSpacesWithSettings(
      workspaceDir,
      scannedSpaces,
      existingSettings,
    );

    expect(result).toHaveLength(1);
    expect(result[0].writable).toBe(false);
  });

  it('leaves writable undefined when not present in scanned space', async () => {
    const spacePath = path.join(workspaceDir, 'UnknownDrive');
    await fs.mkdir(spacePath, { recursive: true });

    const scannedSpaces: SpaceInfo[] = [
      {
        name: 'UnknownDrive',
        path: 'UnknownDrive',
        absolutePath: spacePath,
        type: 'other',
        isSymlink: false,
        hasReadme: true,
        status: 'ok',
        // writable not set
      },
    ];

    const result = await spaceService.reconcileSpacesWithSettings(
      workspaceDir,
      scannedSpaces,
      undefined,
    );

    expect(result).toHaveLength(1);
    expect(result[0].writable).toBeUndefined();
  });
});

describe('spaceService.reconcileSpacesWithSettings — sharing/description preservation', () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-sharing-'));
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
  });

  it('preserves sharing when scanned space has undefined sharing', async () => {
    const spacePath = path.join(workspaceDir, 'PrivateSpace');
    await fs.mkdir(spacePath, { recursive: true });

    const existingSettings: SpaceConfig[] = [
      {
        name: 'PrivateSpace',
        path: 'PrivateSpace',
        type: 'personal',
        isSymlink: false,
        createdAt: Date.now(),
        sharing: 'private',
      },
    ];

    const scannedSpaces: SpaceInfo[] = [
      {
        name: 'PrivateSpace',
        path: 'PrivateSpace',
        absolutePath: spacePath,
        type: 'personal',
        isSymlink: false,
        hasReadme: true,
        // sharing: undefined — frontmatter omits sharing field
      },
    ];

    const result = await spaceService.reconcileSpacesWithSettings(
      workspaceDir,
      scannedSpaces,
      existingSettings,
    );

    expect(result).toHaveLength(1);
    expect(result[0].sharing).toBe('private');
  });

  it('updates sharing when scanned space has explicit sharing', async () => {
    const spacePath = path.join(workspaceDir, 'SharedSpace');
    await fs.mkdir(spacePath, { recursive: true });

    const existingSettings: SpaceConfig[] = [
      {
        name: 'SharedSpace',
        path: 'SharedSpace',
        type: 'project',
        isSymlink: false,
        createdAt: Date.now(),
        sharing: 'private',
      },
    ];

    const scannedSpaces: SpaceInfo[] = [
      {
        name: 'SharedSpace',
        path: 'SharedSpace',
        absolutePath: spacePath,
        type: 'project',
        isSymlink: false,
        hasReadme: true,
        sharing: 'restricted', // Frontmatter has explicit sharing
      },
    ];

    const result = await spaceService.reconcileSpacesWithSettings(
      workspaceDir,
      scannedSpaces,
      existingSettings,
    );

    expect(result).toHaveLength(1);
    expect(result[0].sharing).toBe('restricted');
  });

  it('preserves description when scanned space has undefined description', async () => {
    const spacePath = path.join(workspaceDir, 'DescSpace');
    await fs.mkdir(spacePath, { recursive: true });

    const existingSettings: SpaceConfig[] = [
      {
        name: 'DescSpace',
        path: 'DescSpace',
        type: 'other',
        isSymlink: false,
        createdAt: Date.now(),
        description: 'My important space',
      },
    ];

    const scannedSpaces: SpaceInfo[] = [
      {
        name: 'DescSpace',
        path: 'DescSpace',
        absolutePath: spacePath,
        type: 'other',
        isSymlink: false,
        hasReadme: true,
        // description: undefined — frontmatter omits description
      },
    ];

    const result = await spaceService.reconcileSpacesWithSettings(
      workspaceDir,
      scannedSpaces,
      existingSettings,
    );

    expect(result).toHaveLength(1);
    expect(result[0].description).toBe('My important space');
  });

  it('updates description when scanned space has explicit description', async () => {
    const spacePath = path.join(workspaceDir, 'UpdatedDesc');
    await fs.mkdir(spacePath, { recursive: true });

    const existingSettings: SpaceConfig[] = [
      {
        name: 'UpdatedDesc',
        path: 'UpdatedDesc',
        type: 'other',
        isSymlink: false,
        createdAt: Date.now(),
        description: 'Old description',
      },
    ];

    const scannedSpaces: SpaceInfo[] = [
      {
        name: 'UpdatedDesc',
        path: 'UpdatedDesc',
        absolutePath: spacePath,
        type: 'other',
        isSymlink: false,
        hasReadme: true,
        description: 'New description from frontmatter',
      },
    ];

    const result = await spaceService.reconcileSpacesWithSettings(
      workspaceDir,
      scannedSpaces,
      existingSettings,
    );

    expect(result).toHaveLength(1);
    expect(result[0].description).toBe('New description from frontmatter');
  });
});

describe('spaceService.migrateLegacyAgentsMd', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-migrate-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('returns skipped when AGENTS.md does not exist', async () => {
    const spacePath = path.join(tempDir, 'empty-space');
    await fs.mkdir(spacePath, { recursive: true });

    const result = await spaceService.migrateLegacyAgentsMd(spacePath);

    expect(result.success).toBe(true);
    expect(result.migrated).toBe(false);
    expect(result.skipped).toBe('no-agents-md');
  });

  it('migrates AGENTS.md to README.md when only AGENTS.md exists', async () => {
    const spacePath = path.join(tempDir, 'agents-only');
    await fs.mkdir(spacePath, { recursive: true });
    await fs.writeFile(path.join(spacePath, 'AGENTS.md'), '# Test Content\n');

    const result = await spaceService.migrateLegacyAgentsMd(spacePath);

    expect(result.success).toBe(true);
    expect(result.migrated).toBe(true);

    // README.md should exist with the content
    const readmeContent = await fs.readFile(path.join(spacePath, 'README.md'), 'utf-8');
    expect(readmeContent).toBe('# Test Content\n');

    // AGENTS.md should not exist
    await expect(fs.access(path.join(spacePath, 'AGENTS.md'))).rejects.toThrow();
  });

  it('backs up both files to backups/ folder when both exist', async () => {
    const spacePath = path.join(tempDir, 'both-files');
    await fs.mkdir(spacePath, { recursive: true });
    await fs.writeFile(path.join(spacePath, 'README.md'), '# README Content\n');
    await fs.writeFile(path.join(spacePath, 'AGENTS.md'), '# AGENTS Content\n');

    const result = await spaceService.migrateLegacyAgentsMd(spacePath);

    expect(result.success).toBe(true);
    expect(result.migrated).toBe(false);
    expect(result.backedUp).toBe(true);

    // README.md should be untouched
    const readmeContent = await fs.readFile(path.join(spacePath, 'README.md'), 'utf-8');
    expect(readmeContent).toBe('# README Content\n');

    // AGENTS.md should be deleted
    await expect(fs.access(path.join(spacePath, 'AGENTS.md'))).rejects.toThrow();

    // backups/ folder should exist with both files
    const backupsDir = path.join(spacePath, 'backups');
    const backupFiles = await fs.readdir(backupsDir);
    expect(backupFiles.length).toBe(2);
    
    // Should have one README backup and one AGENTS backup
    const readmeBackups = backupFiles.filter(f => f.startsWith('README_'));
    const agentsBackups = backupFiles.filter(f => f.startsWith('AGENTS_'));
    expect(readmeBackups.length).toBe(1);
    expect(agentsBackups.length).toBe(1);
    
    // Verify backup contents
    const readmeBackupContent = await fs.readFile(path.join(backupsDir, readmeBackups[0]), 'utf-8');
    const agentsBackupContent = await fs.readFile(path.join(backupsDir, agentsBackups[0]), 'utf-8');
    expect(readmeBackupContent).toBe('# README Content\n');
    expect(agentsBackupContent).toBe('# AGENTS Content\n');
  });

  it('returns success when README.md already exists (no AGENTS.md)', async () => {
    const spacePath = path.join(tempDir, 'readme-only');
    await fs.mkdir(spacePath, { recursive: true });
    await fs.writeFile(path.join(spacePath, 'README.md'), '# README Content\n');

    const result = await spaceService.migrateLegacyAgentsMd(spacePath);

    // The current implementation doesn't have a 'skipped' reason for this case
    // It returns success=true, migrated=false which is correct
    expect(result.success).toBe(true);
    expect(result.migrated).toBe(false);
  });

  it('skips migration when AGENTS.md is a symlink', async () => {
    const spacePath = path.join(tempDir, 'symlink-agents');
    await fs.mkdir(spacePath, { recursive: true });
    
    // Create a target file and symlink to it
    const targetPath = path.join(tempDir, 'target-agents.md');
    await fs.writeFile(targetPath, '# Symlink Target\n');
    await fs.symlink(targetPath, path.join(spacePath, 'AGENTS.md'));

    const result = await spaceService.migrateLegacyAgentsMd(spacePath);

    expect(result.success).toBe(true);
    expect(result.migrated).toBe(false);
    expect(result.skipped).toBe('symlink');

    // Symlink should still exist
    const lstat = await fs.lstat(path.join(spacePath, 'AGENTS.md'));
    expect(lstat.isSymbolicLink()).toBe(true);
  });
});


describe('spaceService.migrateAllLegacyAgentsMd', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-migrate-all-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('migrates multiple spaces with legacy AGENTS.md files', async () => {
    // Create workspace structure with Chief-of-Staff and Personal spaces
    const chiefOfStaffPath = path.join(tempDir, 'Chief-of-Staff');
    const personalPath = path.join(tempDir, 'Personal');
    
    await fs.mkdir(chiefOfStaffPath, { recursive: true });
    await fs.mkdir(personalPath, { recursive: true });
    
    // Chief-of-Staff has AGENTS.md (legacy)
    await fs.writeFile(
      path.join(chiefOfStaffPath, 'AGENTS.md'),
      '---\nrebel_space_description: "Router"\nspace_type: chief-of-staff\n---\n# CoS'
    );
    
    // Personal has AGENTS.md (legacy)
    await fs.writeFile(
      path.join(personalPath, 'AGENTS.md'),
      '---\nrebel_space_description: "Personal stuff"\nspace_type: personal\n---\n# Personal'
    );

    const summary = await spaceService.migrateAllLegacyAgentsMd(tempDir);

    expect(summary.migrated).toBe(2);
    expect(summary.backedUp).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.migratedPaths).toContain('Chief-of-Staff');
    expect(summary.migratedPaths).toContain('Personal');

    // Verify files were migrated
    await expect(fs.access(path.join(chiefOfStaffPath, 'README.md'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(personalPath, 'README.md'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(chiefOfStaffPath, 'AGENTS.md'))).rejects.toThrow();
    await expect(fs.access(path.join(personalPath, 'AGENTS.md'))).rejects.toThrow();
  });

  it('returns empty summary for workspace with no legacy files', async () => {
    // Create workspace with only README.md files
    const chiefOfStaffPath = path.join(tempDir, 'Chief-of-Staff');
    await fs.mkdir(chiefOfStaffPath, { recursive: true });
    await fs.writeFile(
      path.join(chiefOfStaffPath, 'README.md'),
      '---\nrebel_space_description: "Router"\nspace_type: chief-of-staff\n---\n# CoS'
    );

    const summary = await spaceService.migrateAllLegacyAgentsMd(tempDir);

    expect(summary.migrated).toBe(0);
    expect(summary.backedUp).toBe(0);
    expect(summary.failed).toBe(0);
  });
});


// ============================================================================
// Stage 4 - Space/Workspace Rename Support Tests
// ============================================================================

describe('spaceService.rewritePath', () => {
  it('rewrites exact match', () => {
    const result = spaceService.rewritePath('work/Acme', 'work/Acme', 'work/NewAcme');
    expect(result).toBe('work/NewAcme');
  });

  it('rewrites prefix match with boundary (next char is /)', () => {
    const result = spaceService.rewritePath('work/Acme/ProjectX', 'work/Acme', 'work/NewAcme');
    expect(result).toBe('work/NewAcme/ProjectX');
  });

  it('does NOT match similar prefix without boundary', () => {
    // /Chief should not match /Chief-of-Staff (boundary rule)
    const result = spaceService.rewritePath('Chief-of-Staff', 'Chief', 'NewChief');
    expect(result).toBe('Chief-of-Staff'); // Unchanged
  });

  it('handles case-insensitive matching on non-Linux', () => {
    // On macOS/Windows, paths are case-insensitive
    if (process.platform !== 'linux') {
      const result = spaceService.rewritePath('Work/ACME/Project', 'work/acme', 'work/NewAcme');
      expect(result).toBe('work/NewAcme/Project');
    }
  });

  it('handles case-sensitive matching on Linux', () => {
    // This test only applies on Linux
    if (process.platform === 'linux') {
      const result = spaceService.rewritePath('Work/ACME/Project', 'work/acme', 'work/NewAcme');
      expect(result).toBe('Work/ACME/Project'); // No match due to case
    }
  });

  it('normalizes backslashes to forward slashes', () => {
    const result = spaceService.rewritePath('work\\Acme\\Project', 'work/Acme', 'work/NewAcme');
    expect(result).toBe('work/NewAcme/Project');
  });

  it('returns original path unchanged when no match', () => {
    const result = spaceService.rewritePath('Personal/notes', 'work/Acme', 'work/NewAcme');
    expect(result).toBe('Personal/notes');
  });

  it('handles empty old prefix (exact match for empty string)', () => {
    // Empty string matches only empty path exactly
    const result = spaceService.rewritePath('', '', 'new');
    expect(result).toBe('new');
  });

  it('does not match when old prefix is empty but target is not', () => {
    // Boundary rule: empty prefix + non-empty path has boundary at index 0
    // But 'some/path'[0] is 's', not '/', so no match
    const result = spaceService.rewritePath('some/path', '', 'new');
    expect(result).toBe('some/path');
  });
});


describe('spaceService.migrateSpacePathInSettings', () => {
  it('migrates spaces[].path on exact match', () => {
    const settings = {
      spaces: [
        { path: 'work/Acme', name: 'Acme' },
        { path: 'Personal', name: 'Personal' },
      ],
    };

    const result = spaceService.migrateSpacePathInSettings(settings, 'work/Acme', 'work/NewAcme');

    expect(settings.spaces[0].path).toBe('work/NewAcme');
    expect(settings.spaces[0].name).toBe('NewAcme');
    expect(settings.spaces[1].path).toBe('Personal'); // Unchanged
    expect(result.updated).toContain('spaces[].path');
  });

  it('migrates nested space paths (prefix match)', () => {
    const settings = {
      spaces: [
        { path: 'work/Acme', name: 'Acme' },
        { path: 'work/Acme/ProjectX', name: 'ProjectX' },
      ],
    };

    const result = spaceService.migrateSpacePathInSettings(settings, 'work/Acme', 'work/NewAcme');

    expect(settings.spaces[0].path).toBe('work/NewAcme');
    expect(settings.spaces[1].path).toBe('work/NewAcme/ProjectX');
    // Nested space keeps its name (only exact matches update name)
    expect(settings.spaces[1].name).toBe('ProjectX');
    expect(result.updated).toContain('spaces[].path');
  });

  it('migrates meetingBot space IDs', () => {
    const settings = {
      meetingBot: {
        groupMeetingSpaceId: 'work/Acme',
        oneOnOneSpaceId: 'Personal',
        physicalMeetingSpaceId: 'work/Acme/Meetings',
      },
    };

    const result = spaceService.migrateSpacePathInSettings(settings, 'work/Acme', 'work/NewAcme');

    expect(settings.meetingBot.groupMeetingSpaceId).toBe('work/NewAcme');
    expect(settings.meetingBot.oneOnOneSpaceId).toBe('Personal'); // Unchanged
    expect(settings.meetingBot.physicalMeetingSpaceId).toBe('work/NewAcme/Meetings');
    expect(result.updated).toContain('meetingBot.groupMeetingSpaceId');
    expect(result.updated).toContain('meetingBot.physicalMeetingSpaceId');
  });

  it('migrates spaceSafetyOverrides[].spacePath', () => {
    const settings = {
      spaceSafetyOverrides: [
        { spacePath: 'work/Acme', spaceName: 'Acme' },
        { spacePath: 'Personal', spaceName: 'Personal' },
      ],
    };

    const result = spaceService.migrateSpacePathInSettings(settings, 'work/Acme', 'work/NewAcme');

    expect(settings.spaceSafetyOverrides[0].spacePath).toBe('work/NewAcme');
    expect(settings.spaceSafetyOverrides[0].spaceName).toBe('NewAcme');
    expect(settings.spaceSafetyOverrides[1].spacePath).toBe('Personal'); // Unchanged
    expect(result.updated).toContain('spaceSafetyOverrides[].spacePath');
  });

  it('returns empty updated array when no paths match', () => {
    const settings = {
      spaces: [{ path: 'Personal', name: 'Personal' }],
      meetingBot: { groupMeetingSpaceId: 'work/Other' },
    };

    const result = spaceService.migrateSpacePathInSettings(settings, 'work/Acme', 'work/NewAcme');

    expect(result.updated).toHaveLength(0);
    expect(settings.spaces[0].path).toBe('Personal');
  });
});


describe('spaceService.renameSpace', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-rename-space-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('renames a regular folder successfully', async () => {
    const spacePath = path.join(tempDir, 'OldName');
    await fs.mkdir(spacePath, { recursive: true });
    await fs.writeFile(path.join(spacePath, 'test.txt'), 'content');

    const result = await spaceService.renameSpace(tempDir, {
      spacePath: 'OldName',
      newName: 'NewName',
    });

    expect(result.success).toBe(true);
    expect(result.oldPath).toBe('OldName');
    expect(result.newPath).toBe('NewName');
    
    // Old path should not exist
    await expect(fs.access(spacePath)).rejects.toThrow();
    // New path should exist with content
    const newPath = path.join(tempDir, 'NewName');
    const content = await fs.readFile(path.join(newPath, 'test.txt'), 'utf8');
    expect(content).toBe('content');
  });

  it('renames a symlink (not its target)', async () => {
    // Create source folder and symlink
    const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-source-'));
    await fs.writeFile(path.join(sourceDir, 'data.txt'), 'symlink data');
    
    const symlinkPath = path.join(tempDir, 'OldSymlink');
    await fs.symlink(sourceDir, symlinkPath, 'dir');

    const result = await spaceService.renameSpace(tempDir, {
      spacePath: 'OldSymlink',
      newName: 'NewSymlink',
    });

    expect(result.success).toBe(true);
    expect(result.newPath).toBe('NewSymlink');
    
    // Old symlink should not exist
    await expect(fs.lstat(symlinkPath)).rejects.toThrow();
    // New symlink should exist and point to same target
    const newSymlinkPath = path.join(tempDir, 'NewSymlink');
    const stat = await fs.lstat(newSymlinkPath);
    expect(stat.isSymbolicLink()).toBe(true);
    const target = await fs.readlink(newSymlinkPath);
    expect(target).toBe(sourceDir);
    
    // Cleanup
    await fs.rm(sourceDir, { recursive: true, force: true }).catch(() => {});
  });

  it('rejects renaming Chief-of-Staff', async () => {
    const cosPath = path.join(tempDir, 'Chief-of-Staff');
    await fs.mkdir(cosPath, { recursive: true });

    const result = await spaceService.renameSpace(tempDir, {
      spacePath: 'Chief-of-Staff',
      newName: 'NewCoS',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Cannot rename Chief-of-Staff');
  });

  it('rejects when target already exists', async () => {
    const oldPath = path.join(tempDir, 'OldSpace');
    const conflictPath = path.join(tempDir, 'ConflictName');
    await fs.mkdir(oldPath, { recursive: true });
    await fs.mkdir(conflictPath, { recursive: true });

    const result = await spaceService.renameSpace(tempDir, {
      spacePath: 'OldSpace',
      newName: 'ConflictName',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('already exists');
  });

  it('rejects empty new name', async () => {
    const spacePath = path.join(tempDir, 'TestSpace');
    await fs.mkdir(spacePath, { recursive: true });

    const result = await spaceService.renameSpace(tempDir, {
      spacePath: 'TestSpace',
      newName: '   ',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('cannot be empty');
  });

  it('rejects names with path separators', async () => {
    const spacePath = path.join(tempDir, 'TestSpace');
    await fs.mkdir(spacePath, { recursive: true });

    const result = await spaceService.renameSpace(tempDir, {
      spacePath: 'TestSpace',
      newName: 'invalid/name',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('path separators');
  });

  it('handles case-only rename on case-insensitive filesystem', async () => {
    // This tests the two-step rename via temp name
    const spacePath = path.join(tempDir, 'TestSpace');
    await fs.mkdir(spacePath, { recursive: true });

    const result = await spaceService.renameSpace(tempDir, {
      spacePath: 'TestSpace',
      newName: 'testspace', // Case change only
    });

    // On case-insensitive filesystems (macOS/Windows), this should succeed
    if (process.platform !== 'linux') {
      expect(result.success).toBe(true);
      expect(result.newPath).toBe('testspace');
      
      // Verify the new path exists (with new casing)
      const newPath = path.join(tempDir, 'testspace');
      await expect(fs.access(newPath)).resolves.toBeUndefined();
    }
  });

  it('returns warnings for symlinks to cloud storage paths', async () => {
    // Create a simulated Google Drive symlink
    const googleDriveSource = path.join(os.tmpdir(), 'Google Drive', 'Shared');
    await fs.mkdir(googleDriveSource, { recursive: true });
    
    const symlinkPath = path.join(tempDir, 'CloudSpace');
    await fs.symlink(googleDriveSource, symlinkPath, 'dir');

    const result = await spaceService.renameSpace(tempDir, {
      spacePath: 'CloudSpace',
      newName: 'RenamedCloud',
    });

    expect(result.success).toBe(true);
    expect(result.warnings).toBeDefined();
    expect(result.warnings?.some(w => w.includes('shared folder'))).toBe(true);

    // Cleanup
    await fs.rm(googleDriveSource, { recursive: true, force: true }).catch(() => {});
  });
});


// ============================================================================
// Stage 2 - Memory Safety Simplification: memoryTrust Cleanup Tests
// ============================================================================

describe('spaceService.removeMemoryTrustFromFrontmatter', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-memorytrust-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('removes memoryTrust while preserving other fields', async () => {
    const spacePath = path.join(tempDir, 'test-space');
    await fs.mkdir(spacePath, { recursive: true });
    await fs.writeFile(
      path.join(spacePath, 'README.md'),
      `---
rebel_space_description: "Test space"
space_type: company
memoryTrust: always_ask
sharing: restricted
sensitivity: standard
---

# Test Space

Some content here.
`
    );

    const result = await spaceService.removeMemoryTrustFromFrontmatter(spacePath);

    expect(result.success).toBe(true);
    expect(result.removed).toBe(true);

    // Verify the file content
    const content = await fs.readFile(path.join(spacePath, 'README.md'), 'utf-8');
    expect(content).not.toContain('memoryTrust');
    expect(content).toContain('rebel_space_description: "Test space"');
    expect(content).toContain('space_type: company');
    expect(content).toContain('sharing: restricted');
    expect(content).toContain('sensitivity: standard');
    expect(content).toContain('# Test Space');
    expect(content).toContain('Some content here.');
  });

  it('handles missing README.md gracefully', async () => {
    const spacePath = path.join(tempDir, 'no-readme');
    await fs.mkdir(spacePath, { recursive: true });
    // Don't create README.md

    const result = await spaceService.removeMemoryTrustFromFrontmatter(spacePath);

    expect(result.success).toBe(true);
    expect(result.removed).toBe(false);
    expect(result.skipped).toBe('no-readme');
  });

  it('handles README.md without frontmatter', async () => {
    const spacePath = path.join(tempDir, 'no-frontmatter');
    await fs.mkdir(spacePath, { recursive: true });
    await fs.writeFile(
      path.join(spacePath, 'README.md'),
      '# Just a regular README\n\nNo frontmatter here.\n'
    );

    const result = await spaceService.removeMemoryTrustFromFrontmatter(spacePath);

    expect(result.success).toBe(true);
    expect(result.removed).toBe(false);
    expect(result.skipped).toBe('no-frontmatter');

    // File should be unchanged
    const content = await fs.readFile(path.join(spacePath, 'README.md'), 'utf-8');
    expect(content).toBe('# Just a regular README\n\nNo frontmatter here.\n');
  });

  it('handles README.md without memoryTrust (no-op)', async () => {
    const spacePath = path.join(tempDir, 'no-memorytrust');
    await fs.mkdir(spacePath, { recursive: true });
    const originalContent = `---
rebel_space_description: "Clean space"
space_type: team
sharing: private
---

# Clean Space
`;
    await fs.writeFile(path.join(spacePath, 'README.md'), originalContent);

    const result = await spaceService.removeMemoryTrustFromFrontmatter(spacePath);

    expect(result.success).toBe(true);
    expect(result.removed).toBe(false);
    expect(result.skipped).toBe('no-memorytrust');

    // File should be unchanged
    const content = await fs.readFile(path.join(spacePath, 'README.md'), 'utf-8');
    expect(content).toBe(originalContent);
  });

  it('handles malformed frontmatter (no closing ---)', async () => {
    const spacePath = path.join(tempDir, 'malformed');
    await fs.mkdir(spacePath, { recursive: true });
    const malformedContent = `---
rebel_space_description: "Malformed"
memoryTrust: balanced

# Oops, forgot to close frontmatter
`;
    await fs.writeFile(path.join(spacePath, 'README.md'), malformedContent);

    const result = await spaceService.removeMemoryTrustFromFrontmatter(spacePath);

    expect(result.success).toBe(true);
    expect(result.removed).toBe(false);
    expect(result.skipped).toBe('no-frontmatter');

    // File should be unchanged
    const content = await fs.readFile(path.join(spacePath, 'README.md'), 'utf-8');
    expect(content).toBe(malformedContent);
  });

  it('removes memoryTrust when it is the only field', async () => {
    const spacePath = path.join(tempDir, 'only-memorytrust');
    await fs.mkdir(spacePath, { recursive: true });
    await fs.writeFile(
      path.join(spacePath, 'README.md'),
      `---
memoryTrust: always_write
---

# Space with only one frontmatter field
`
    );

    const result = await spaceService.removeMemoryTrustFromFrontmatter(spacePath);

    expect(result.success).toBe(true);
    expect(result.removed).toBe(true);

    const content = await fs.readFile(path.join(spacePath, 'README.md'), 'utf-8');
    expect(content).not.toContain('memoryTrust');
    expect(content).toContain('---\n\n---'); // Empty frontmatter
  });

  it('removes memoryTrust when it is the last field', async () => {
    const spacePath = path.join(tempDir, 'last-field');
    await fs.mkdir(spacePath, { recursive: true });
    await fs.writeFile(
      path.join(spacePath, 'README.md'),
      `---
rebel_space_description: "Test"
memoryTrust: balanced
---

# Content
`
    );

    const result = await spaceService.removeMemoryTrustFromFrontmatter(spacePath);

    expect(result.success).toBe(true);
    expect(result.removed).toBe(true);

    const content = await fs.readFile(path.join(spacePath, 'README.md'), 'utf-8');
    expect(content).not.toContain('memoryTrust');
    expect(content).toContain('rebel_space_description: "Test"');
  });

  it('handles quoted memoryTrust values', async () => {
    const spacePath = path.join(tempDir, 'quoted-value');
    await fs.mkdir(spacePath, { recursive: true });
    await fs.writeFile(
      path.join(spacePath, 'README.md'),
      `---
rebel_space_description: "Test"
memoryTrust: "always_ask"
sharing: team
---

# Content
`
    );

    const result = await spaceService.removeMemoryTrustFromFrontmatter(spacePath);

    expect(result.success).toBe(true);
    expect(result.removed).toBe(true);

    const content = await fs.readFile(path.join(spacePath, 'README.md'), 'utf-8');
    expect(content).not.toContain('memoryTrust');
    expect(content).toContain('sharing: team');
  });

  it('is idempotent (safe to run multiple times)', async () => {
    const spacePath = path.join(tempDir, 'idempotent');
    await fs.mkdir(spacePath, { recursive: true });
    await fs.writeFile(
      path.join(spacePath, 'README.md'),
      `---
rebel_space_description: "Test"
memoryTrust: balanced
---

# Content
`
    );

    // First run
    const result1 = await spaceService.removeMemoryTrustFromFrontmatter(spacePath);
    expect(result1.success).toBe(true);
    expect(result1.removed).toBe(true);

    // Second run
    const result2 = await spaceService.removeMemoryTrustFromFrontmatter(spacePath);
    expect(result2.success).toBe(true);
    expect(result2.removed).toBe(false);
    expect(result2.skipped).toBe('no-memorytrust');
  });
});


describe('spaceService.cleanupMemoryTrustFromAllSpaces', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-cleanup-all-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('cleans up memoryTrust from multiple spaces', async () => {
    // Create spaces with memoryTrust
    const space1 = path.join(tempDir, 'space1');
    const space2 = path.join(tempDir, 'space2');
    await fs.mkdir(space1, { recursive: true });
    await fs.mkdir(space2, { recursive: true });

    await fs.writeFile(
      path.join(space1, 'README.md'),
      `---
rebel_space_description: "Space 1"
memoryTrust: always_ask
---
# Space 1
`
    );

    await fs.writeFile(
      path.join(space2, 'README.md'),
      `---
rebel_space_description: "Space 2"
memoryTrust: balanced
sharing: private
---
# Space 2
`
    );

    const spaces = [{ path: 'space1' }, { path: 'space2' }];
    const summary = await spaceService.cleanupMemoryTrustFromAllSpaces(tempDir, spaces);

    expect(summary.removed).toBe(2);
    expect(summary.alreadyClean).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.removedPaths).toContain('space1');
    expect(summary.removedPaths).toContain('space2');

    // Verify files
    const content1 = await fs.readFile(path.join(space1, 'README.md'), 'utf-8');
    const content2 = await fs.readFile(path.join(space2, 'README.md'), 'utf-8');
    expect(content1).not.toContain('memoryTrust');
    expect(content2).not.toContain('memoryTrust');
    expect(content2).toContain('sharing: private'); // Other fields preserved
  });

  it('handles mix of clean and dirty spaces', async () => {
    const cleanSpace = path.join(tempDir, 'clean');
    const dirtySpace = path.join(tempDir, 'dirty');
    await fs.mkdir(cleanSpace, { recursive: true });
    await fs.mkdir(dirtySpace, { recursive: true });

    // Clean space (no memoryTrust)
    await fs.writeFile(
      path.join(cleanSpace, 'README.md'),
      `---
rebel_space_description: "Clean"
---
# Clean
`
    );

    // Dirty space (has memoryTrust)
    await fs.writeFile(
      path.join(dirtySpace, 'README.md'),
      `---
rebel_space_description: "Dirty"
memoryTrust: always_write
---
# Dirty
`
    );

    const spaces = [{ path: 'clean' }, { path: 'dirty' }];
    const summary = await spaceService.cleanupMemoryTrustFromAllSpaces(tempDir, spaces);

    expect(summary.removed).toBe(1);
    expect(summary.alreadyClean).toBe(1);
    expect(summary.removedPaths).toContain('dirty');
  });

  it('handles spaces without README.md', async () => {
    const noReadmeSpace = path.join(tempDir, 'no-readme');
    await fs.mkdir(noReadmeSpace, { recursive: true });
    // Don't create README.md

    const spaces = [{ path: 'no-readme' }];
    const summary = await spaceService.cleanupMemoryTrustFromAllSpaces(tempDir, spaces);

    expect(summary.removed).toBe(0);
    expect(summary.alreadyClean).toBe(1);
    expect(summary.failed).toBe(0);
  });

  it('handles empty workspace path', async () => {
    const spaces = [{ path: 'some-space' }];
    const summary = await spaceService.cleanupMemoryTrustFromAllSpaces('', spaces);

    expect(summary.removed).toBe(0);
    expect(summary.alreadyClean).toBe(0);
    expect(summary.failed).toBe(0);
  });

  it('handles empty spaces array', async () => {
    const summary = await spaceService.cleanupMemoryTrustFromAllSpaces(tempDir, []);

    expect(summary.removed).toBe(0);
    expect(summary.alreadyClean).toBe(0);
    expect(summary.failed).toBe(0);
  });
});

describe('spaceService.readSpaceReadmeBody', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-readme-body-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('returns the body text after frontmatter', async () => {
    const content = [
      '---',
      'rebel_space_description: Team space',
      'sharing: team',
      '---',
      '',
      '# Team Space',
      '',
      'This space excludes 1:1 meetings and HR matters.',
    ].join('\n');
    await fs.writeFile(path.join(tempDir, 'README.md'), content, 'utf-8');

    const body = await spaceService.readSpaceReadmeBody(tempDir);

    expect(body).not.toBeNull();
    expect(body).toContain('# Team Space');
    expect(body).toContain('This space excludes 1:1 meetings and HR matters.');
    // The frontmatter should NOT be in the body
    expect(body).not.toContain('rebel_space_description');
    expect(body).not.toContain('sharing: team');
  });

  it('returns the full content when there is no frontmatter', async () => {
    const content = '# Plain README\n\nJust markdown, no frontmatter.\n';
    await fs.writeFile(path.join(tempDir, 'README.md'), content, 'utf-8');

    const body = await spaceService.readSpaceReadmeBody(tempDir);

    expect(body).toBe(content);
  });

  it('returns null when README.md is missing', async () => {
    const body = await spaceService.readSpaceReadmeBody(tempDir);

    expect(body).toBeNull();
  });

  it('returns null when README.md is empty', async () => {
    await fs.writeFile(path.join(tempDir, 'README.md'), '', 'utf-8');

    const body = await spaceService.readSpaceReadmeBody(tempDir);

    expect(body).toBeNull();
  });

  it('returns null when README.md contains only whitespace', async () => {
    await fs.writeFile(path.join(tempDir, 'README.md'), '   \n\n  \n', 'utf-8');

    const body = await spaceService.readSpaceReadmeBody(tempDir);

    expect(body).toBeNull();
  });

  it('returns null when frontmatter has no body after it', async () => {
    const content = '---\nrebel_space_description: Frontmatter only\n---\n';
    await fs.writeFile(path.join(tempDir, 'README.md'), content, 'utf-8');

    const body = await spaceService.readSpaceReadmeBody(tempDir);

    expect(body).toBeNull();
  });

  it('returns null when body after frontmatter is whitespace only', async () => {
    const content = '---\nrebel_space_description: Space\n---\n\n   \n  \n';
    await fs.writeFile(path.join(tempDir, 'README.md'), content, 'utf-8');

    const body = await spaceService.readSpaceReadmeBody(tempDir);

    expect(body).toBeNull();
  });

  it('returns null when frontmatter is malformed YAML', async () => {
    const content = '---\nrebel_space_description: "unclosed\nother: value\n---\n\n# Body';
    await fs.writeFile(path.join(tempDir, 'README.md'), content, 'utf-8');

    const body = await spaceService.readSpaceReadmeBody(tempDir);

    expect(body).toBeNull();
  });

  it('does not fall back to legacy AGENTS.md when only AGENTS.md exists', async () => {
    // By design: readSpaceReadmeBody reads README.md only.
    await fs.writeFile(path.join(tempDir, 'AGENTS.md'), '# Legacy content\n', 'utf-8');

    const body = await spaceService.readSpaceReadmeBody(tempDir);

    expect(body).toBeNull();
  });

  it('returns null when spacePath is empty string', async () => {
    const body = await spaceService.readSpaceReadmeBody('');

    expect(body).toBeNull();
  });

  it('returns null when README.md path is a directory (EISDIR)', async () => {
    // Simulate a case where README.md is somehow a directory on disk.
    await fs.mkdir(path.join(tempDir, 'README.md'));

    const body = await spaceService.readSpaceReadmeBody(tempDir);

    expect(body).toBeNull();
  });
});

// FOX-3072: frontmatter-repair helper — pure, deterministic, exhaustive coverage.
describe('spaceService.backfillSharingPrivateIfMissing', () => {
  it('no-ops when there is no frontmatter block', () => {
    const body = '# Title\nJust prose, no frontmatter.\n';
    const result = spaceService.backfillSharingPrivateIfMissing(body);
    expect(result.updated).toBe(false);
    expect(result.content).toBe(body);
  });

  it('no-ops when sharing: is already present with a value', () => {
    const body = '---\nrebel_space_description: "Router"\nsharing: "private"\n---\n# Body\n';
    const result = spaceService.backfillSharingPrivateIfMissing(body);
    expect(result.updated).toBe(false);
    expect(result.content).toBe(body);
  });

  it('no-ops when sharing: has non-default value (preserves intent)', () => {
    const body = '---\nrebel_space_description: "Team"\nsharing: "restricted"\n---\n# Body\n';
    const result = spaceService.backfillSharingPrivateIfMissing(body);
    expect(result.updated).toBe(false);
    expect(result.content).toBe(body);
  });

  it('no-ops when sharing: has legacy value (team)', () => {
    const body = '---\nrebel_space_description: "Legacy"\nsharing: "team"\n---\n# Body\n';
    const result = spaceService.backfillSharingPrivateIfMissing(body);
    expect(result.updated).toBe(false);
  });

  it('no-ops when sharing: is present without quotes', () => {
    const body = '---\nrebel_space_description: Router\nsharing: private\n---\n# Body\n';
    const result = spaceService.backfillSharingPrivateIfMissing(body);
    expect(result.updated).toBe(false);
  });

  it('backfills sharing: "private" when missing from frontmatter (core FOX-3072 case)', () => {
    const body = '---\nrebel_space_description: "Router"\nspace_type: "chief-of-staff"\n---\n# Body\n';
    const result = spaceService.backfillSharingPrivateIfMissing(body);
    expect(result.updated).toBe(true);
    expect(result.content).toContain('sharing: "private"');
    // Existing fields preserved verbatim
    expect(result.content).toContain('rebel_space_description: "Router"');
    expect(result.content).toContain('space_type: "chief-of-staff"');
    // Body preserved unchanged
    expect(result.content).toContain('# Body');
  });

  it('idempotent: running twice equals running once', () => {
    const body = '---\nrebel_space_description: "Router"\n---\n# Body\n';
    const first = spaceService.backfillSharingPrivateIfMissing(body);
    const second = spaceService.backfillSharingPrivateIfMissing(first.content);
    expect(first.updated).toBe(true);
    expect(second.updated).toBe(false);
    expect(second.content).toBe(first.content);
  });

  it('preserves field order — inserts sharing as last field before closing fence', () => {
    const body = '---\na: 1\nb: 2\nc: 3\n---\nbody\n';
    const result = spaceService.backfillSharingPrivateIfMissing(body);
    expect(result.updated).toBe(true);
    const fmMatch = result.content.match(/^---\n([\s\S]*?)\n---/);
    expect(fmMatch).not.toBeNull();
    const fmLines = fmMatch![1].split('\n');
    expect(fmLines).toEqual(['a: 1', 'b: 2', 'c: 3', 'sharing: "private"']);
  });

  it('handles CRLF line endings', () => {
    const body = '---\r\nrebel_space_description: "Router"\r\n---\r\nbody\r\n';
    const result = spaceService.backfillSharingPrivateIfMissing(body);
    expect(result.updated).toBe(true);
    expect(result.content).toContain('sharing: "private"');
  });

  it('handles BOM at start of file', () => {
    const body = '\uFEFF---\nrebel_space_description: "Router"\n---\nbody\n';
    const result = spaceService.backfillSharingPrivateIfMissing(body);
    expect(result.updated).toBe(true);
    expect(result.content).toContain('sharing: "private"');
  });

  it('does not false-match "sharing" appearing in a value (only root-level keys)', () => {
    // Here, `description` mentions sharing but there is no `sharing:` ROOT key.
    // The regex anchors at line start, so the word inside the value shouldn't block backfill.
    const body = '---\ndescription: "Controls sharing behavior across spaces"\n---\nbody\n';
    const result = spaceService.backfillSharingPrivateIfMissing(body);
    expect(result.updated).toBe(true);
    expect(result.content).toContain('sharing: "private"');
  });

  it('ignores nested yaml that contains "sharing:" as a sub-key', () => {
    // This edge-case exists more in principle than practice — YAML fronts in Rebel are flat,
    // but we must not be fooled into skipping backfill by a nested key.
    const body = '---\nconfig:\n  sharing: private\n---\nbody\n';
    const result = spaceService.backfillSharingPrivateIfMissing(body);
    // Root-level `sharing:` is absent; our regex should detect that and backfill.
    // (The `sharing:` under config has leading whitespace → `^sharing:` anchored regex fails → backfill.)
    expect(result.updated).toBe(true);
  });
});

// FOX-3072: end-to-end verification that ensureChiefOfStaffSpace repairs partial frontmatter.
describe('spaceService.ensureChiefOfStaffSpace frontmatter repair', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-cos-repair-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('backfills sharing: private when CoS README has frontmatter but missing sharing field', async () => {
    // Setup: CoS space with README.md that has frontmatter but no `sharing` field (FOX-3072 repro).
    const cosDir = path.join(tempDir, 'Chief-of-Staff');
    await fs.mkdir(cosDir, { recursive: true });
    await fs.writeFile(
      path.join(cosDir, 'README.md'),
      '---\nrebel_space_description: "Chief of Staff router"\nspace_type: "chief-of-staff"\n---\n# Chief of Staff\n',
      'utf8'
    );

    const result = await spaceService.ensureChiefOfStaffSpace(tempDir);

    // After call, frontmatter should contain sharing: "private"
    const readmeContent = await fs.readFile(path.join(cosDir, 'README.md'), 'utf8');
    expect(readmeContent).toContain('sharing: "private"');
    // Existing fields preserved
    expect(readmeContent).toContain('rebel_space_description: "Chief of Staff router"');
    expect(readmeContent).toContain('space_type: "chief-of-staff"');
    // Return value reflects the repaired state
    expect(result.sharing).toBe('private');
  });

  it('preserves existing sharing: value when present (idempotency and intent preservation)', async () => {
    const cosDir = path.join(tempDir, 'Chief-of-Staff');
    await fs.mkdir(cosDir, { recursive: true });
    // User has intentionally set sharing: restricted — must NOT be overwritten.
    await fs.writeFile(
      path.join(cosDir, 'README.md'),
      '---\nrebel_space_description: "Router"\nspace_type: "chief-of-staff"\nsharing: "restricted"\n---\n# Body\n',
      'utf8'
    );

    await spaceService.ensureChiefOfStaffSpace(tempDir);

    const readmeContent = await fs.readFile(path.join(cosDir, 'README.md'), 'utf8');
    expect(readmeContent).toContain('sharing: "restricted"');
    expect(readmeContent).not.toContain('sharing: "private"');
  });

  it('is idempotent: repeat calls on well-formed CoS do not modify README', async () => {
    const cosDir = path.join(tempDir, 'Chief-of-Staff');
    await fs.mkdir(cosDir, { recursive: true });
    const initialContent = '---\nrebel_space_description: "Router"\nspace_type: "chief-of-staff"\nsharing: "private"\n---\n# Body\n';
    await fs.writeFile(path.join(cosDir, 'README.md'), initialContent, 'utf8');

    await spaceService.ensureChiefOfStaffSpace(tempDir);
    const firstPass = await fs.readFile(path.join(cosDir, 'README.md'), 'utf8');
    await spaceService.ensureChiefOfStaffSpace(tempDir);
    const secondPass = await fs.readFile(path.join(cosDir, 'README.md'), 'utf8');

    expect(firstPass).toBe(initialContent);
    expect(secondPass).toBe(initialContent);
  });

  it('syncs settings.spaces CoS entry when settingsOps provided and repair occurs', async () => {
    // Setup: CoS README missing sharing, and settings.spaces has the CoS entry with a stale value.
    const cosDir = path.join(tempDir, 'Chief-of-Staff');
    await fs.mkdir(cosDir, { recursive: true });
    await fs.writeFile(
      path.join(cosDir, 'README.md'),
      '---\nrebel_space_description: "Router"\nspace_type: "chief-of-staff"\n---\n# Body\n',
      'utf8'
    );

    let currentSpaces: SpaceConfig[] = [
      {
        name: 'Chief of Staff',
        path: 'Chief-of-Staff',
        type: 'chief-of-staff',
        isSymlink: false,
        sharing: undefined as any, // Stale: missing sharing in settings too
        description: 'Router',
        createdAt: Date.now(),
      },
    ];
    const updateSpaces = vi.fn((spaces: SpaceConfig[]) => { currentSpaces = spaces; });

    await spaceService.ensureChiefOfStaffSpace(tempDir, undefined, {
      getSpaces: () => currentSpaces,
      updateSpaces,
    });

    // settingsOps.updateSpaces must have been called with a repaired entry
    expect(updateSpaces).toHaveBeenCalledTimes(1);
    const cosEntry = currentSpaces.find((s) => s.type === 'chief-of-staff');
    expect(cosEntry?.sharing).toBe('private');
  });

  it('skips settings sync when already aligned (no redundant write)', async () => {
    const cosDir = path.join(tempDir, 'Chief-of-Staff');
    await fs.mkdir(cosDir, { recursive: true });
    await fs.writeFile(
      path.join(cosDir, 'README.md'),
      '---\nrebel_space_description: "Router"\nspace_type: "chief-of-staff"\nsharing: "private"\n---\n# Body\n',
      'utf8'
    );

    const currentSpaces: SpaceConfig[] = [
      {
        name: 'Chief of Staff',
        path: 'Chief-of-Staff',
        type: 'chief-of-staff',
        isSymlink: false,
        sharing: 'private',
        description: 'Router',
        createdAt: Date.now(),
      },
    ];
    const updateSpaces = vi.fn();

    await spaceService.ensureChiefOfStaffSpace(tempDir, undefined, {
      getSpaces: () => currentSpaces,
      updateSpaces,
    });

    // Already aligned — no update should occur.
    expect(updateSpaces).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Stage 3: Mechanical frontmatter repair (spaceService auto-fix extensions)
// =============================================================================

describe('spaceService.attemptMechanicalFrontmatterRepairOnDisk', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-frontmatter-repair-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('repairs a missing closing `---` delimiter while preserving the body', async () => {
    // Opening `---` present, no closing delimiter before the body heading.
    const broken = [
      '---',
      'rebel_space_description: Team A working space',
      'sharing: team',
      '',
      '# Team A',
      '',
      'Body content that must survive the repair untouched.',
    ].join('\n');
    await fs.writeFile(path.join(tempDir, 'README.md'), broken, 'utf8');

    const repaired = await spaceService.attemptMechanicalFrontmatterRepairOnDisk(tempDir);
    expect(repaired).toBe(true);

    const newContent = await fs.readFile(path.join(tempDir, 'README.md'), 'utf8');
    // Two `---` delimiters now present.
    const delimCount = (newContent.match(/^---\s*$/gm) ?? []).length;
    expect(delimCount).toBe(2);
    // Body preserved byte-for-byte — the heading and the trailing line are intact.
    expect(newContent).toContain('# Team A');
    expect(newContent).toContain('Body content that must survive the repair untouched.');
    // Parses cleanly after repair.
    const { frontmatter, parseError } = await spaceService.readSpaceFrontmatterWithError(tempDir);
    expect(parseError).toBeUndefined();
    expect(frontmatter?.rebel_space_description).toBe('Team A working space');
  });

  it('deduplicates top-level keys by keeping the LAST occurrence', async () => {
    // YAML with duplicate top-level keys. js-yaml tolerates some duplicates
    // (depending on version) but the plan's semantics are "keep last" —
    // regardless of whether js-yaml throws, we verify our repair reflects
    // that policy when it does.
    const broken = [
      '---',
      'rebel_space_description: early draft',
      'sharing: private',
      'rebel_space_description: final description',
      '---',
      '# Body',
    ].join('\n');
    await fs.writeFile(path.join(tempDir, 'README.md'), broken, 'utf8');

    // Force the case to require repair by writing duplicate keys that will
    // actually fail to parse (using a scalar vs list redefinition).
    const conflictingDup = [
      '---',
      'tags: [a, b]',
      'rebel_space_description: early',
      'tags:',
      '  - c',
      '  - d',
      'rebel_space_description: final kept value',
      '---',
      '# Body preserved',
    ].join('\n');
    await fs.writeFile(path.join(tempDir, 'README.md'), conflictingDup, 'utf8');

    const repaired = await spaceService.attemptMechanicalFrontmatterRepairOnDisk(tempDir);
    expect(repaired).toBe(true);

    const content = await fs.readFile(path.join(tempDir, 'README.md'), 'utf8');
    expect(content).toContain('# Body preserved');

    const { frontmatter, parseError } = await spaceService.readSpaceFrontmatterWithError(tempDir);
    expect(parseError).toBeUndefined();
    expect(frontmatter?.rebel_space_description).toBe('final kept value');
  });

  it('normalises tabs to 2-space indentation when that fixes the parse', async () => {
    // YAML that breaks because of literal tabs inside indentation.
    const broken = [
      '---',
      'rebel_space_description: Tabbed space',
      'sharing: team',
      'related_spaces:',
      '\t- project-a',
      '\t- project-b',
      '---',
      '# Tabbed',
    ].join('\n');
    await fs.writeFile(path.join(tempDir, 'README.md'), broken, 'utf8');

    const repaired = await spaceService.attemptMechanicalFrontmatterRepairOnDisk(tempDir);
    expect(repaired).toBe(true);

    const content = await fs.readFile(path.join(tempDir, 'README.md'), 'utf8');
    expect(content).not.toMatch(/\t/);
    expect(content).toContain('# Tabbed');

    const { frontmatter, parseError } = await spaceService.readSpaceFrontmatterWithError(tempDir);
    expect(parseError).toBeUndefined();
    expect(frontmatter?.related_spaces).toEqual(['project-a', 'project-b']);
  });

  it('returns false (no-op) when the frontmatter already parses cleanly', async () => {
    const good = [
      '---',
      'rebel_space_description: Already healthy',
      'sharing: team',
      '---',
      '# Body',
    ].join('\n');
    await fs.writeFile(path.join(tempDir, 'README.md'), good, 'utf8');

    const repaired = await spaceService.attemptMechanicalFrontmatterRepairOnDisk(tempDir);
    expect(repaired).toBe(false);

    const content = await fs.readFile(path.join(tempDir, 'README.md'), 'utf8');
    expect(content).toBe(good);
  });

  it('returns false (no-op) when the file has no frontmatter at all', async () => {
    // No opening `---` — out of scope for mechanical repair (the existing
    // addDescriptionToFrontmatter path handles frontmatter insertion).
    const noFm = '# Plain markdown\n\nNo frontmatter here.\n';
    await fs.writeFile(path.join(tempDir, 'README.md'), noFm, 'utf8');

    const repaired = await spaceService.attemptMechanicalFrontmatterRepairOnDisk(tempDir);
    expect(repaired).toBe(false);

    const content = await fs.readFile(path.join(tempDir, 'README.md'), 'utf8');
    expect(content).toBe(noFm);
  });

  it('falls back to AGENTS.md when README.md is absent', async () => {
    // Two tab-indented list items reliably trip js-yaml's parser (one can
    // slip through certain versions — two always fails).
    const broken = [
      '---',
      'rebel_space_description: legacy space',
      'sharing: team',
      'related_spaces:',
      '\t- one',
      '\t- two',
      '---',
      '# Legacy',
    ].join('\n');
    await fs.writeFile(path.join(tempDir, 'AGENTS.md'), broken, 'utf8');

    const repaired = await spaceService.attemptMechanicalFrontmatterRepairOnDisk(tempDir);
    expect(repaired).toBe(true);

    const content = await fs.readFile(path.join(tempDir, 'AGENTS.md'), 'utf8');
    expect(content).not.toMatch(/\t/);
    expect(content).toContain('# Legacy');
  });

  it('S3-F2: preserves original bytes when the atomic rename crashes', async () => {
    // Regression for the Stage 3 review finding: the scan-side
    // auto-fix used to write via `fs.writeFile(filePath, content)` —
    // a truncating write that could leave a half-written README on
    // disk after a crash. The refactor routes through the shared
    // `atomicWriteWithReValidate` helper. Proof: inject a `fs.rename`
    // failure after the tmp has been written and verify the file on
    // disk still equals the original bytes.
    const broken = [
      '---',
      'rebel_space_description: Team space',
      'sharing: team',
      'related_spaces:',
      '\t- one',
      '\t- two',
      '---',
      '# Team',
      'Body line.',
    ].join('\n');
    await fs.writeFile(path.join(tempDir, 'README.md'), broken, 'utf8');

    // Spy on `fs.rename` — the shared atomic helper uses the module's
    // default export (`node:fs/promises`) when no `fs` dep is injected,
    // which is exactly what the scan-side wrapper does.
    const renameSpy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(
      new Error('simulated crash during rename'),
    );

    const repaired = await spaceService.attemptMechanicalFrontmatterRepairOnDisk(tempDir);

    // Rename failure → no repair applied.
    expect(repaired).toBe(false);
    expect(renameSpy).toHaveBeenCalled();
    // File on disk is byte-identical to the original — no truncation,
    // no partial write. This is the S3-F2 invariant.
    const after = await fs.readFile(path.join(tempDir, 'README.md'), 'utf8');
    expect(after).toBe(broken);
    // The tmp sibling must be cleaned up so the next scan isn't
    // confused by a stale `.rebel-frontmatter-tmp` file.
    await expect(fs.access(path.join(tempDir, 'README.md.rebel-frontmatter-tmp'))).rejects.toThrow();

    renameSpy.mockRestore();
  });

  it('S3-F1: rejects a body-absorption candidate via the safety gate (body bytes preserved)', async () => {
    // Regression for the Phase 6 review S3-F1 finding.
    //
    // Scenario: a user has a markdown horizontal rule (`---`) in the
    // body AND the real frontmatter is defective (here: duplicate top-
    // level keys). `splitFrontmatter` picks the body's `---` as the
    // close delimiter, sweeping real body text ("Introduction...") into
    // the candidate frontmatter region. If the mechanical path blindly
    // accepted the deduped result, the body tail would be silently
    // rearranged on disk.
    //
    // The guard chain:
    //   1. The YAML parser rejects duplicate-mapping-key input, so the
    //      post-dedup candidate fails to re-parse (absorbed prose
    //      doesn't form a legal YAML mapping).
    //   2. Even if a candidate were to parse, `validateRepairSafety`
    //      runs `compareFrontmatterFidelity` on the original vs new
    //      frontmatter regions AND, for any missing-closing-delimiter
    //      repair, the `looksLikeMarkdownBody` heuristic.
    //
    // Invariant asserted here: `repaired === false`, file bytes on
    // disk identical to the original, no `.rebel-frontmatter-tmp`
    // remnant.
    const risky = [
      '---',
      'title: My Skill',
      'title: Duplicate Key',
      '',
      'Introduction text that is intentionally long enough to trip the prose heuristic.',
      '',
      '---',
      '',
      '## Section 2 heading',
      '',
      'Body content after the horizontal rule.',
    ].join('\n');
    const readmePath = path.join(tempDir, 'README.md');
    await fs.writeFile(readmePath, risky, 'utf8');
    const originalBytes = await fs.readFile(readmePath);

    const repaired = await spaceService.attemptMechanicalFrontmatterRepairOnDisk(tempDir);

    // Strict: the safety gate (or the YAML re-parse) rejected the
    // candidate — no write happened.
    expect(repaired).toBe(false);

    // Strict: bytes on disk are byte-identical to the original. Both
    // the declared frontmatter AND the body tail survive intact.
    const afterBytes = await fs.readFile(readmePath);
    expect(afterBytes.equals(originalBytes)).toBe(true);

    // Content-level spot checks that the body tail is still there
    // (belt-and-suspenders over the byte-equality assertion above).
    const after = afterBytes.toString('utf8');
    expect(after).toContain('## Section 2 heading');
    expect(after).toContain('Body content after the horizontal rule.');
    expect(after).toContain('Introduction text that is intentionally long');

    // Tmp sibling was cleaned up (or never created) — the next scan
    // must not find a stale `.rebel-frontmatter-tmp` file.
    await expect(fs.access(`${readmePath}.rebel-frontmatter-tmp`)).rejects.toThrow();
  });
});

describe('spaceService.scanSpaces — mechanical frontmatter repair integration', () => {
  let tempDir: string;
  let chiefOfStaffDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-scan-fm-repair-'));
    chiefOfStaffDir = path.join(tempDir, 'Chief-of-Staff');
    await fs.mkdir(chiefOfStaffDir, { recursive: true });
    await fs.writeFile(
      path.join(chiefOfStaffDir, 'README.md'),
      '---\nrebel_space_description: Chief of Staff router space\n---\n# Chief of Staff\n',
      'utf8',
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('heals malformed YAML in writable mode (default) and returns an ok space', async () => {
    const personalDir = path.join(tempDir, 'personal');
    await fs.mkdir(personalDir, { recursive: true });
    // Broken: tabs inside list-item indentation reliably trip js-yaml.
    const broken = [
      '---',
      'rebel_space_description: Personal space',
      'sharing: private',
      'related_spaces:',
      '\t- one',
      '\t- two',
      '---',
      '# Personal',
    ].join('\n');
    await fs.writeFile(path.join(personalDir, 'README.md'), broken, 'utf8');

    const spaces = await spaceService.scanSpaces(tempDir);
    const personal = spaces.find((s) => s.path === 'personal');
    expect(personal).toBeDefined();
    expect(personal?.status).toBe('ok');

    // The file on disk was updated.
    const fileAfter = await fs.readFile(path.join(personalDir, 'README.md'), 'utf8');
    expect(fileAfter).not.toMatch(/\t/);
  });

  it('leaves the file untouched in skipAutoFix mode even when repair would succeed', async () => {
    const personalDir = path.join(tempDir, 'personal');
    await fs.mkdir(personalDir, { recursive: true });
    const broken = [
      '---',
      'rebel_space_description: Personal space',
      'sharing: private',
      'related_spaces:',
      '\t- one',
      '\t- two',
      '---',
      '# Personal',
    ].join('\n');
    await fs.writeFile(path.join(personalDir, 'README.md'), broken, 'utf8');

    const spaces = await spaceService.scanSpaces(tempDir, { skipAutoFix: true });
    const personal = spaces.find((s) => s.path === 'personal');
    expect(personal).toBeDefined();
    expect(personal?.status).toBe('needs_attention');
    expect(personal?.statusMessage).toMatch(/Malformed YAML/);

    // The on-disk file must be unchanged — skipAutoFix is strictly side-effect free.
    const fileAfter = await fs.readFile(path.join(personalDir, 'README.md'), 'utf8');
    expect(fileAfter).toBe(broken);
  });
});
