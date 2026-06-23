import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = fileURLToPath(new URL('../../', import.meta.url));

function listSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(fullPath));
    } else if (entry.isFile() && fullPath.endsWith('.ts') && !fullPath.endsWith('.d.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

function relativeSourcePath(filePath: string): string {
  return path.relative(SRC_ROOT, filePath).split(path.sep).join('/');
}

function findHiddenFullTurnLaunchFiles(): string[] {
  const hiddenSessionPattern = /memory-update-|use-case-discovery-|error-eval-|automation-calendar-sync|meeting-analysis/;
  const launchCallPattern = /(?:^|[\s.])(executeAgentTurn|runHeadlessTurn)\s*\(/;

  return listSourceFiles(SRC_ROOT)
    .filter((filePath) => {
      if (!statSync(filePath).isFile()) return false;
      const source = readFileSync(filePath, 'utf8');
      return hiddenSessionPattern.test(source) && launchCallPattern.test(source);
    })
    .map(relativeSourcePath)
    .sort();
}

describe('desktop auxiliary full-turn launch sites', () => {
  it('enumerates hidden full-turn producers so new auxiliary sites must be declared', () => {
    expect(findHiddenFullTurnLaunchFiles()).toEqual([
      'core/services/calendarSyncService.ts',
      'core/services/memoryUpdateService.ts',
      'main/services/errorRecoveryService.ts',
      'main/services/meetingBot/meetingAnalysisService.ts',
      'main/services/useCaseGeneratorService.ts',
    ]);
  });

  it('routes use-case discovery through an explicit active-working single-model auxiliary declaration', () => {
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');

    expect(source).toContain('resolveActiveWorkingSingleModelAuxiliaryTurnOverrides');
    expect(source).toContain('const auxiliaryOverrides = resolveActiveWorkingSingleModelAuxiliaryTurnOverrides(getSettings());');
    expect(source).toContain('modelOverride: auxiliaryOverrides.modelOverride');
    expect(source).toContain('thinkingModelOverride: auxiliaryOverrides.thinkingModelOverride');
    expect(source).toContain('workingProfileOverrideId: auxiliaryOverrides.workingProfileOverrideId');
  });

  it('routes safe-mode error evaluation through explicit active-working single-model auxiliary declarations', () => {
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');

    const matches = source.match(/resolveActiveWorkingSingleModelAuxiliaryTurnOverrides\(getSettings\(\)\)/g) ?? [];
    // use-case discovery + two error-recovery dependency wrappers.
    expect(matches).toHaveLength(3);
    const memoryHookMatches = source.match(/memoryWriteHook: options\.readOnlyHook/g) ?? [];
    // Both error-recovery wrappers route the read-only eval hook.
    expect(memoryHookMatches).toHaveLength(2);
    expect(source).toContain('modelOverride: auxiliaryOverrides.modelOverride');
    expect(source).toContain('thinkingModelOverride: auxiliaryOverrides.thinkingModelOverride');
    expect(source).toContain('workingProfileOverrideId: auxiliaryOverrides.workingProfileOverrideId');
  });

  it('routes memory update through the memory BTS auxiliary declaration', () => {
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');

    expect(source).toContain('const memoryTurnOverride = resolveMemoryBtsTurnOverride(settings);');
    expect(source).toContain('const memoryAuxiliaryOverrides = resolveAuxiliaryTurnModelOverrides(memoryTurnOverride.auxiliaryTurnConfig);');
    expect(source).toContain('modelOverride: memoryAuxiliaryOverrides.modelOverride');
    expect(source).toContain('thinkingModelOverride: memoryAuxiliaryOverrides.thinkingModelOverride');
    expect(source).toContain('workingProfileOverrideId: memoryAuxiliaryOverrides.workingProfileOverrideId');
  });

  it('declares approval re-eval continuations as user-session inheritance', () => {
    const source = readFileSync(new URL('../services/safety/approvalReEvalService.ts', import.meta.url), 'utf8');

    expect(source).toContain("mode: 'inherit_user_session'");
    expect(source).toContain('resolveAuxiliaryTurnModelOverrides(auxiliaryTurnConfig)');
    expect(source).toContain('modelOverride: auxiliaryOverrides.modelOverride');
    expect(source).toContain('workingProfileOverrideId: auxiliaryOverrides.workingProfileOverrideId');
    expect(source).toContain('thinkingModelOverride: auxiliaryOverrides.thinkingModelOverride');
  });

  it('declares meeting analysis as an active-working single-model auxiliary turn', () => {
    const source = readFileSync(new URL('../services/meetingBot/meetingAnalysisService.ts', import.meta.url), 'utf8');

    expect(source).toContain('const auxiliaryOverrides = resolveActiveWorkingSingleModelAuxiliaryTurnOverrides(settings);');
    expect(source).toContain('modelOverride: auxiliaryOverrides.modelOverride');
    expect(source).toContain('workingProfileOverrideId: auxiliaryOverrides.workingProfileOverrideId');
    expect(source).toContain('thinkingModelOverride: auxiliaryOverrides.thinkingModelOverride');
  });

  it('declares calendar sync as an active-working single-model auxiliary turn', () => {
    const source = readFileSync(new URL('../../core/services/calendarSyncService.ts', import.meta.url), 'utf8');

    expect(source).toContain('const auxiliaryOverrides = resolveActiveWorkingSingleModelAuxiliaryTurnOverrides(deps.getSettings());');
    expect(source).toContain('modelOverride: auxiliaryOverrides.modelOverride');
    expect(source).toContain('thinkingModelOverride: auxiliaryOverrides.thinkingModelOverride');
    expect(source).toContain('workingProfileOverrideId: auxiliaryOverrides.workingProfileOverrideId');
  });
});
