import { describe, it, expect } from 'vitest';
import {
  SETTINGS_DRIFT_REEMIT_WINDOW_MS,
  consumeSettingsDriftEmissionDecision,
  createSettingsDriftEmissionCache,
  detectSettingsDrift,
} from '../settingsDriftDetector';
import type { SettingsDriftEventState, SettingsDriftObservation } from '../settingsDriftDetector';
import type { AppSettings } from '@shared/types';
import fs from 'node:fs';
import path from 'node:path';

describe('settingsDriftDetector', () => {
  it('detects no drift when settings are identical', () => {
    const a: Partial<AppSettings> = { activeProvider: 'anthropic', memoryUpdateEnabled: true };
    const b: Partial<AppSettings> = { activeProvider: 'anthropic', memoryUpdateEnabled: true };
    const drifts = detectSettingsDrift(a as AppSettings, b as AppSettings);
    expect(drifts).toHaveLength(0);
  });

  it('detects drift when enum field differs', () => {
    const a: Partial<AppSettings> = { activeProvider: 'anthropic' };
    const b: Partial<AppSettings> = { activeProvider: 'openrouter' };
    const drifts = detectSettingsDrift(a as AppSettings, b as AppSettings);
    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toEqual({ field: 'active_provider', diffKind: 'a_b_differ_enum' });
  });

  it('detects a_set_b_unset and b_set_a_unset', () => {
    const a: Partial<AppSettings> = { memoryUpdateEnabled: true };
    const b: Partial<AppSettings> = {};
    let drifts = detectSettingsDrift(a as AppSettings, b as AppSettings);
    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toEqual({ field: 'memory_enabled', diffKind: 'a_set_b_unset' });

    drifts = detectSettingsDrift(b as AppSettings, a as AppSettings);
    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toEqual({ field: 'memory_enabled', diffKind: 'b_set_a_unset' });
  });

  it('detects deep typed field differences', () => {
    const a: Partial<AppSettings> = {
      models: { workingProfileId: 'profile-1' } as any,
      localModel: { profiles: [{ id: 'profile-1' }] } as any,
    } as any;
    const b: Partial<AppSettings> = {
      models: { workingProfileId: 'profile-2' } as any,
      localModel: { profiles: [{ id: 'profile-2' }] } as any,
    } as any;
    const drifts = detectSettingsDrift(a as AppSettings, b as AppSettings);
    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toEqual({ field: 'turn_model_profile_id', diffKind: 'a_b_differ_typed' });
  });

  it('maintains structural purity by importing no settings-write paths', () => {
    const sourceCode = fs.readFileSync(path.join(__dirname, '../settingsDriftDetector.ts'), 'utf-8');
    // Ensure we are not importing functions like updateSettings or mergeSettings
    // which could accidentally trigger a sync loop.
    expect(sourceCode).not.toMatch(/updateSettings/);
    expect(sourceCode).not.toMatch(/setSettings/);
    expect(sourceCode).not.toMatch(/cloudRouter/);
    expect(sourceCode).not.toMatch(/syncNow/);
  });

  it('suppresses identical drift emissions inside the transition window', () => {
    const cache = createSettingsDriftEmissionCache();
    const drifts = [{ field: 'active_provider', diffKind: 'a_b_differ_enum' }] as const;
    const emitted: Array<SettingsDriftObservation & { eventState: SettingsDriftEventState }> = [];

    for (let index = 0; index < 100; index += 1) {
      const decision = consumeSettingsDriftEmissionDecision(drifts, cache, { nowMs: 1_000 });
      if (decision.shouldEmit) emitted.push(...decision.observations.map(drift => ({
        ...drift,
        eventState: decision.eventState,
      })));
    }

    expect(emitted).toEqual([
      {
        field: 'active_provider',
        diffKind: 'a_b_differ_enum',
        eventState: 'observed',
      },
    ]);
  });

  it('emits again when the differing field set changes', () => {
    const cache = createSettingsDriftEmissionCache();

    const initial = consumeSettingsDriftEmissionDecision(
      [{ field: 'active_provider', diffKind: 'a_b_differ_enum' }],
      cache,
      { nowMs: 1_000 },
    );
    const changed = consumeSettingsDriftEmissionDecision(
      [
        { field: 'active_provider', diffKind: 'a_b_differ_enum' },
        { field: 'memory_enabled', diffKind: 'a_set_b_unset' },
      ],
      cache,
      { nowMs: 1_001 },
    );

    expect(initial.shouldEmit).toBe(true);
    expect(changed.shouldEmit).toBe(true);
    expect(changed.eventState).toBe('observed');
    expect(changed.observations).toEqual([
      { field: 'active_provider', diffKind: 'a_b_differ_enum' },
      { field: 'memory_enabled', diffKind: 'a_set_b_unset' },
    ]);
  });

  it('emits resolved when drift transitions to no differences', () => {
    const cache = createSettingsDriftEmissionCache();

    const observed = consumeSettingsDriftEmissionDecision(
      [{ field: 'active_provider', diffKind: 'a_b_differ_enum' }],
      cache,
      { nowMs: 1_000 },
    );
    const resolved = consumeSettingsDriftEmissionDecision([], cache, { nowMs: 1_001 });
    const repeatedResolved = consumeSettingsDriftEmissionDecision([], cache, { nowMs: 1_002 });

    expect(observed.shouldEmit).toBe(true);
    expect(resolved).toMatchObject({
      shouldEmit: true,
      eventState: 'resolved',
      fingerprint: null,
      observations: [{ field: 'active_provider', diffKind: 'a_b_differ_enum' }],
    });
    expect(repeatedResolved.shouldEmit).toBe(false);
  });

  it('allows identical drift to re-emit after the transition window', () => {
    const cache = createSettingsDriftEmissionCache();
    const drifts = [{ field: 'active_provider', diffKind: 'a_b_differ_enum' }] as const;

    expect(consumeSettingsDriftEmissionDecision(drifts, cache, { nowMs: 1_000 }).shouldEmit).toBe(true);
    expect(consumeSettingsDriftEmissionDecision(drifts, cache, { nowMs: 1_001 }).shouldEmit).toBe(false);
    expect(consumeSettingsDriftEmissionDecision(drifts, cache, {
      nowMs: 1_000 + SETTINGS_DRIFT_REEMIT_WINDOW_MS,
    }).shouldEmit).toBe(true);
  });
});
