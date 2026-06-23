import { describe, it, expect } from 'vitest';
import {
  findCoordinatorViolations,
  isAllowlisted,
  ALLOWLISTED_FILES,
  GUARDED_REMOVERS,
} from '../check-index-removal-coordinator';

describe('check-index-removal-coordinator (only-door gate)', () => {
  it('catches a planted direct removeFilesFromIndex call', () => {
    const src = [
      "import { removeFilesFromIndex } from './fileIndexService';",
      'async function rogueCleanup(paths: string[]) {',
      '  await removeFilesFromIndex(paths, { skipReadRefresh: true });',
      '}',
    ].join('\n');
    const violations = findCoordinatorViolations(src, 'src/main/services/rogue.ts');
    expect(violations).toHaveLength(1);
    expect(violations[0].symbol).toBe('removeFilesFromIndex');
    expect(violations[0].line).toBe(3);
  });

  it('catches a planted direct removeFileFromIndex call (qualified + awaited)', () => {
    const src = 'await fileIndexService.removeFileFromIndex(p);';
    const violations = findCoordinatorViolations(src, 'src/main/services/rogue.ts');
    expect(violations).toHaveLength(1);
    expect(violations[0].symbol).toBe('removeFileFromIndex');
  });

  it('does NOT flag the import line itself', () => {
    const src = "import { removeFileFromIndex, removeFilesFromIndex } from './fileIndexService';";
    expect(findCoordinatorViolations(src, 'src/main/services/x.ts')).toHaveLength(0);
  });

  it('does NOT flag the function DEFINITION', () => {
    const src = [
      'export async function removeFileFromIndex(filePath: string) {',
      '  return 1;',
      '}',
      'async function removeFilesFromIndex(filePaths: string[]) { return 0; }',
    ].join('\n');
    expect(findCoordinatorViolations(src, 'src/main/services/fileIndexService/index.ts')).toHaveLength(0);
  });

  it('does NOT flag references inside comments', () => {
    const src = [
      '// calls removeFileFromIndex(...) historically',
      '/* removeFilesFromIndex(paths) was here */',
      'const x = 1;',
    ].join('\n');
    expect(findCoordinatorViolations(src, 'src/main/services/x.ts')).toHaveLength(0);
  });

  it('does NOT flag an interface property key of the guarded name', () => {
    // The coordinator's IndexRemovalRemovers interface declares `removeFileFromIndex:`
    // as a property type, not a call — must not trip the gate.
    const src = [
      'export interface IndexRemovalRemovers {',
      '  readonly removeFileFromIndex: (p: string) => Promise<void>;',
      '  readonly removeFilesFromIndex: (p: string[]) => Promise<number>;',
      '}',
    ].join('\n');
    expect(findCoordinatorViolations(src, 'src/main/services/x.ts')).toHaveLength(0);
  });

  it('does NOT flag the internal (lock-free) replacement variants', () => {
    // These are the legitimate replacement deletes; only the PUBLIC removers are guarded.
    const src = [
      'await removeFileFromIndexInternal(canonicalPath, { skipReadRefresh: true });',
      'return removeFilesFromIndexInternal(filePaths, options);',
    ].join('\n');
    expect(findCoordinatorViolations(src, 'src/main/services/fileIndexService/index.ts')).toHaveLength(0);
  });

  it('allowlists the coordinator, wiring, and definer; not arbitrary files', () => {
    expect(isAllowlisted('src/main/services/indexRemovalCoordinator.ts')).toBe(true);
    expect(isAllowlisted('src/main/index.ts')).toBe(true);
    expect(isAllowlisted('src/main/services/fileIndexService/index.ts')).toBe(true);
    // pluginIndexService is NOT allowlisted — its plugin-README deindex routes
    // through the coordinator now (Stage 4a touch-up), so the only-door claim holds.
    expect(isAllowlisted('src/main/services/pluginIndexService.ts')).toBe(false);
    expect(isAllowlisted('src/main/services/fileWatcherService.ts')).toBe(false);
    expect(isAllowlisted('src/main/services/__tests__/foo.test.ts')).toBe(true);
  });

  it('guards exactly the two public LanceDB removers', () => {
    expect([...GUARDED_REMOVERS].sort()).toEqual(['removeFileFromIndex', 'removeFilesFromIndex']);
    expect(ALLOWLISTED_FILES.has('src/main/services/fileWatcherService.ts')).toBe(false);
  });
});
