import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PLUGIN_ACTIVATION_STORE_VERSION } from '@core/constants';

let storeData: Record<string, unknown> = {};

vi.mock('@core/storeFactory', () => ({
  createStore: vi.fn((options: { defaults?: Record<string, unknown> }) => {
    if (Object.keys(storeData).length === 0) {
      storeData = { ...(options.defaults ?? {}) };
    }

    return {
      get: (key: string) => storeData[key],
      set: (keyOrObject: string | Record<string, unknown>, value?: unknown) => {
        if (typeof keyOrObject === 'string') {
          storeData[keyOrObject] = value;
        } else {
          Object.assign(storeData, keyOrObject);
        }
      },
      has: (key: string) => key in storeData,
      delete: (key: string) => {
        delete storeData[key];
      },
      clear: () => {
        storeData = {};
      },
      get store() {
        return storeData;
      },
      set store(value: Record<string, unknown>) {
        storeData = value;
      },
      path: '/mock/plugin-activation.json',
    };
  }),
}));

import {
  getActivatedPluginIds,
  addActivatedPluginId,
  removeActivatedPluginId,
  getDeactivatedPluginIds,
  addDeactivatedPluginId,
  removeDeactivatedPluginId,
  getPendingReviewPluginIds,
  addPendingReviewPluginId,
  removePendingReviewPluginId,
  isPluginActivated,
  _resetForTests,
} from '../pluginActivationStore';

describe('pluginActivationStore', () => {
  beforeEach(() => {
    storeData = {};
    _resetForTests();
  });

  it('starts empty with the correct store version', () => {
    expect(getActivatedPluginIds()).toEqual([]);
    expect(storeData.version).toBe(PLUGIN_ACTIVATION_STORE_VERSION);
  });

  it('adds plugin IDs and deduplicates repeats', () => {
    addActivatedPluginId('meeting-prep');
    addActivatedPluginId('meeting-prep');
    addActivatedPluginId('inbox-triage');

    expect(getActivatedPluginIds()).toEqual(['meeting-prep', 'inbox-triage']);
    expect(storeData.version).toBe(PLUGIN_ACTIVATION_STORE_VERSION);
  });

  it('removes plugin IDs', () => {
    addActivatedPluginId('meeting-prep');
    addActivatedPluginId('inbox-triage');

    removeActivatedPluginId('meeting-prep');

    expect(getActivatedPluginIds()).toEqual(['inbox-triage']);
  });

  it('checks activation state by plugin ID', () => {
    addActivatedPluginId('meeting-prep');

    expect(isPluginActivated('meeting-prep')).toBe(true);
    expect(isPluginActivated('inbox-triage')).toBe(false);
  });

  it('normalizes invalid persisted entries on read', () => {
    storeData = {
      version: PLUGIN_ACTIVATION_STORE_VERSION,
      activatedPluginIds: ['valid-plugin', '', 'valid-plugin', 123, null] as unknown[],
    };

    expect(getActivatedPluginIds()).toEqual(['valid-plugin']);
    expect(storeData.activatedPluginIds).toEqual(['valid-plugin']);
  });

  it('persists activation list across store re-initialization', () => {
    addActivatedPluginId('meeting-prep');
    addActivatedPluginId('inbox-triage');

    _resetForTests();

    expect(getActivatedPluginIds()).toEqual(['meeting-prep', 'inbox-triage']);
    expect(isPluginActivated('meeting-prep')).toBe(true);
  });
});

describe('pluginActivationStore pending-review tracking (Stage 3A)', () => {
  beforeEach(() => {
    storeData = {};
    _resetForTests();
  });

  it('starts empty (missing key normalises to [] — backward-compatible, no migration)', () => {
    // Simulate an old store that predates the field.
    storeData = { version: PLUGIN_ACTIVATION_STORE_VERSION, activatedPluginIds: [] };
    expect(getPendingReviewPluginIds()).toEqual([]);
  });

  it('adds and deduplicates pending-review plugin IDs', () => {
    addPendingReviewPluginId('community-dashboard');
    addPendingReviewPluginId('community-dashboard');
    expect(getPendingReviewPluginIds()).toEqual(['community-dashboard']);
  });

  it('removes a pending-review plugin ID', () => {
    addPendingReviewPluginId('community-dashboard');
    removePendingReviewPluginId('community-dashboard');
    expect(getPendingReviewPluginIds()).toEqual([]);
  });

  it('activating a plugin clears its pending-review flag', () => {
    addPendingReviewPluginId('community-dashboard');
    addDeactivatedPluginId('community-dashboard');

    addActivatedPluginId('community-dashboard');

    expect(getPendingReviewPluginIds()).toEqual([]);
    expect(getDeactivatedPluginIds()).toEqual([]);
    expect(isPluginActivated('community-dashboard')).toBe(true);
  });

  it('persists pending-review list across store re-initialization', () => {
    addPendingReviewPluginId('community-dashboard');
    _resetForTests();
    expect(getPendingReviewPluginIds()).toEqual(['community-dashboard']);
  });
});

describe('pluginActivationStore deactivated tracking', () => {
  beforeEach(() => {
    storeData = {};
    _resetForTests();
  });

  it('starts with empty deactivated list', () => {
    expect(getDeactivatedPluginIds()).toEqual([]);
  });

  it('adds and removes deactivated IDs', () => {
    addDeactivatedPluginId('my-plugin');
    expect(getDeactivatedPluginIds()).toEqual(['my-plugin']);

    removeDeactivatedPluginId('my-plugin');
    expect(getDeactivatedPluginIds()).toEqual([]);
  });

  it('deduplicates repeated deactivated IDs', () => {
    addDeactivatedPluginId('my-plugin');
    addDeactivatedPluginId('my-plugin');
    expect(getDeactivatedPluginIds()).toEqual(['my-plugin']);
  });

  it('enforces mutual exclusivity: activating removes from deactivated', () => {
    addDeactivatedPluginId('my-plugin');
    expect(getDeactivatedPluginIds()).toEqual(['my-plugin']);

    addActivatedPluginId('my-plugin');
    expect(getActivatedPluginIds()).toContain('my-plugin');
    expect(getDeactivatedPluginIds()).not.toContain('my-plugin');
  });

  it('enforces mutual exclusivity: deactivating removes from activated', () => {
    addActivatedPluginId('my-plugin');
    expect(getActivatedPluginIds()).toContain('my-plugin');

    addDeactivatedPluginId('my-plugin');
    expect(getDeactivatedPluginIds()).toContain('my-plugin');
    expect(getActivatedPluginIds()).not.toContain('my-plugin');
  });

  it('normalizes invalid persisted deactivated entries on read', () => {
    storeData = {
      version: PLUGIN_ACTIVATION_STORE_VERSION,
      activatedPluginIds: [],
      deactivatedPluginIds: ['valid', '', 42, null, 'valid'] as unknown[],
    };

    expect(getDeactivatedPluginIds()).toEqual(['valid']);
  });
});
