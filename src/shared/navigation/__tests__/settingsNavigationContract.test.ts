import { describe, it, expect } from 'vitest';
import {
  resolveSettingsNavigation,
  resolveSettingsSectionForScroll,
  canonicalizeSettingsSectionId,
  isPublicSettingsSectionId,
} from '../settingsNavigationContract';

describe('settingsNavigationContract', () => {
  describe('resolveSettingsNavigation', () => {
    it('maps bare system tab to spaces workspace destination', () => {
      expect(resolveSettingsNavigation({ tab: 'system' })).toEqual({
        leafTab: 'spaces',
        destination: 'workspace',
        redirectedFrom: { tab: 'system' },
      });
    });

    it('maps tab-only composite routes to their default public sections', () => {
      expect(resolveSettingsNavigation({ tab: 'cloud' })).toEqual({
        leafTab: 'cloud',
        section: 'cloudSync',
        destination: 'workspace',
      });
      expect(resolveSettingsNavigation({ tab: 'account' })).toEqual({
        leafTab: 'account',
        section: 'profile',
        destination: 'account_preferences',
      });
      expect(resolveSettingsNavigation({ tab: 'safety' })).toEqual({
        leafTab: 'safety',
        section: 'privacySafety',
        destination: 'privacy_safety',
      });
      expect(resolveSettingsNavigation({ tab: 'diagnostics' })).toEqual({
        leafTab: 'diagnostics',
        section: 'supportDiagnostics',
        destination: 'advanced',
      });
      expect(resolveSettingsNavigation({ tab: 'plugins' })).toEqual({
        leafTab: 'plugins',
        section: 'labsPlugins',
        destination: 'advanced',
      });
    });

    it('maps system appearance to account leaf', () => {
      expect(resolveSettingsNavigation({ tab: 'system', section: 'appearance' })).toEqual({
        leafTab: 'account',
        section: 'appearance',
        destination: 'account_preferences',
        redirectedFrom: { tab: 'system', section: 'appearance' },
      });
    });

    it('maps system advanced hash to diagnostics advancedOperations per matrix', () => {
      expect(resolveSettingsNavigation({ tab: 'system', section: 'advanced' })).toEqual({
        leafTab: 'diagnostics',
        section: 'advancedOperations',
        destination: 'advanced',
        redirectedFrom: { tab: 'system', section: 'advanced' },
      });
    });

    it('maps section-only voiceAudio to voice tab', () => {
      expect(resolveSettingsNavigation({ section: 'voiceAudio' })).toEqual({
        leafTab: 'voice',
        section: 'voiceAudio',
        destination: 'agent_voice',
      });
    });

    it('maps section-only privacyData alias to safety privacySafety', () => {
      expect(resolveSettingsNavigation({ section: 'privacyData' })).toEqual({
        leafTab: 'safety',
        section: 'privacySafety',
        destination: 'privacy_safety',
      });
    });

    it('maps agents voiceAudio redirect', () => {
      expect(resolveSettingsNavigation({ tab: 'agents', section: 'voiceAudio' })).toEqual({
        leafTab: 'voice',
        section: 'voiceAudio',
        destination: 'agent_voice',
        redirectedFrom: { tab: 'agents', section: 'voiceAudio' },
      });
    });

    it('gates developer tab to support diagnostics when developer mode is off', () => {
      expect(resolveSettingsNavigation({ tab: 'developer' }, { developerModeEnabled: false })).toEqual({
        leafTab: 'diagnostics',
        section: 'supportDiagnostics',
        destination: 'advanced',
        redirectedFrom: { tab: 'developer' },
      });
    });

    it('maps system localInference to advanced destination', () => {
      expect(resolveSettingsNavigation({ tab: 'system', section: 'localInference' })).toEqual({
        leafTab: 'diagnostics',
        section: 'localInference',
        destination: 'advanced',
        redirectedFrom: { tab: 'system', section: 'localInference' },
      });
    });

    it('maps section-only localInference to advanced destination', () => {
      expect(resolveSettingsNavigation({ section: 'localInference' })).toEqual({
        leafTab: 'diagnostics',
        section: 'localInference',
        destination: 'advanced',
      });
    });

    it('maps system suggestions to account_preferences destination', () => {
      expect(resolveSettingsNavigation({ tab: 'system', section: 'suggestions' })).toEqual({
        leafTab: 'account',
        section: 'suggestions',
        destination: 'account_preferences',
        redirectedFrom: { tab: 'system', section: 'suggestions' },
      });
    });

    it('maps section-only suggestions to account_preferences destination', () => {
      expect(resolveSettingsNavigation({ section: 'suggestions' })).toEqual({
        leafTab: 'account',
        section: 'suggestions',
        destination: 'account_preferences',
      });
    });

    it('maps the messagingChannels section to the cloud workspace destination', () => {
      expect(resolveSettingsNavigation({ tab: 'cloud', section: 'messagingChannels' })).toEqual({
        leafTab: 'cloud',
        section: 'messagingChannels',
        destination: 'workspace',
      });
      expect(resolveSettingsNavigation({ section: 'messagingChannels' })).toEqual({
        leafTab: 'cloud',
        section: 'messagingChannels',
        destination: 'workspace',
      });
    });

    it('keeps the cloudSync deep link resolution unchanged', () => {
      expect(resolveSettingsNavigation({ tab: 'cloud', section: 'cloudSync' })).toEqual({
        leafTab: 'cloud',
        section: 'cloudSync',
        destination: 'workspace',
      });
      expect(resolveSettingsNavigation({ section: 'cloudSync' })).toEqual({
        leafTab: 'cloud',
        section: 'cloudSync',
        destination: 'workspace',
      });
    });

    it('treats messagingChannels as a public settings section id', () => {
      expect(isPublicSettingsSectionId('messagingChannels')).toBe(true);
    });
  });

  describe('resolveSettingsSectionForScroll', () => {
    it('disambiguates advanced for system vs diagnostics vs meetings', () => {
      expect(resolveSettingsSectionForScroll('system', 'advanced')).toBe('advancedOperations');
      expect(resolveSettingsSectionForScroll('diagnostics', 'advanced')).toBe('diagnosticsAdvanced');
      expect(resolveSettingsSectionForScroll('meetings', 'advanced')).toBe('advanced');
    });

    it('passes connector data-section ids through for tools tab scroll', () => {
      expect(resolveSettingsSectionForScroll('tools', 'connector-Fathom')).toBe('connector-Fathom');
    });
  });

  describe('canonicalizeSettingsSectionId', () => {
    it('maps privacyData to privacySafety', () => {
      expect(canonicalizeSettingsSectionId('privacyData')).toBe('privacySafety');
    });
  });
});
