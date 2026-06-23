import { describe, expect, it } from 'vitest';
import { CLOUD_CHANNEL_POLICIES } from '../cloudChannelPolicies';
import {
  CLOUD_SYNCED_MEETING_BOT_KEYS,
  mergeLocalSettings,
  stripLocalSettings,
} from '../cloudSettingsPolicy';

type Surface = 'desktop' | 'cloud' | 'mobile';

interface SurfaceSettings {
  surface: Surface;
  settings: Record<string, unknown>;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function simulateSettingsUpdate(
  writer: SurfaceSettings,
  readers: SurfaceSettings[],
): void {
  const payload = stripLocalSettings(writer.settings);
  for (const reader of readers) {
    reader.settings = mergeLocalSettings(payload, reader.settings);
  }
}

function meetingBotSettings(surface: SurfaceSettings): Record<string, unknown> {
  return surface.settings.meetingBot as Record<string, unknown>;
}

describe('meeting bot settings cross-surface round trip', () => {
  it('keeps triggerPhrase and localRecordingTriggerListening routable and dual-write', () => {
    expect(CLOUD_CHANNEL_POLICIES['settings:update']).toMatchObject({
      routable: true,
      dualWrite: true,
      transport: 'rest',
    });
    expect(CLOUD_SYNCED_MEETING_BOT_KEYS.has('triggerPhrase')).toBe(true);
    expect(CLOUD_SYNCED_MEETING_BOT_KEYS.has('localRecordingTriggerListening')).toBe(true);
  });

  it('round-trips desktop → cloud → mobile and mobile → cloud → desktop', () => {
    const desktop: SurfaceSettings = {
      surface: 'desktop',
      settings: {
        cloudInstance: { mode: 'cloud', cloudToken: 'local-only' },
        coreDirectory: '/Users/example/Core',
        meetingBot: {
          triggerPhrase: 'Spark',
          localRecordingTriggerListening: true,
        },
      },
    };
    const cloud: SurfaceSettings = {
      surface: 'cloud',
      settings: {
        meetingBot: {
          triggerPhrase: null,
          localRecordingTriggerListening: false,
        },
      },
    };
    const mobile: SurfaceSettings = {
      surface: 'mobile',
      settings: clone(cloud.settings),
    };

    simulateSettingsUpdate(desktop, [cloud, mobile]);
    expect(meetingBotSettings(cloud)).toMatchObject({
      triggerPhrase: 'Spark',
      localRecordingTriggerListening: true,
    });
    expect(meetingBotSettings(mobile)).toMatchObject({
      triggerPhrase: 'Spark',
      localRecordingTriggerListening: true,
    });

    mobile.settings = {
      ...mobile.settings,
      meetingBot: {
        triggerPhrase: 'Hey Rebel',
        localRecordingTriggerListening: false,
      },
    };

    simulateSettingsUpdate(mobile, [cloud, desktop]);
    expect(meetingBotSettings(cloud)).toMatchObject({
      triggerPhrase: 'Hey Rebel',
      localRecordingTriggerListening: false,
    });
    expect(meetingBotSettings(desktop)).toMatchObject({
      triggerPhrase: 'Hey Rebel',
      localRecordingTriggerListening: false,
    });
    expect(desktop.settings.cloudInstance).toEqual({ mode: 'cloud', cloudToken: 'local-only' });
    expect(desktop.settings.coreDirectory).toBe('/Users/example/Core');
  });
});
