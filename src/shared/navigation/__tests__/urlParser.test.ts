import { describe, it, expect } from 'vitest';
import { parseNavigationUrl, formatNavigationUrl, formatLibraryUrl } from '../urlParser';
import { SETTINGS_TABS, isSettingsTabId } from '../types';
import type { NavigationTarget } from '../types';

describe('urlParser', () => {
  describe('parseNavigationUrl', () => {
    describe('settings URLs', () => {
      it('should parse rebel://settings', () => {
        const result = parseNavigationUrl('rebel://settings');
        expect(result).toEqual({ type: 'settings', tab: undefined, section: undefined });
      });

      it('should parse settings with tab', () => {
        const result = parseNavigationUrl('rebel://settings/agents');
        expect(result).toEqual({ type: 'settings', tab: 'agents', section: undefined });
      });

      it('should parse settings with section', () => {
        const result = parseNavigationUrl('rebel://settings#voiceAudio');
        expect(result).toEqual({ type: 'settings', tab: undefined, section: 'voiceAudio' });
      });

      it('should parse settings with tab and section', () => {
        const result = parseNavigationUrl('rebel://settings/agents#voiceAudio');
        expect(result).toEqual({ type: 'settings', tab: 'agents', section: 'voiceAudio' });
      });

      it('should parse settings query tab and section deep links', () => {
        const result = parseNavigationUrl('rebel://settings/?tab=cloud&section=messagingChannels');
        expect(result).toEqual({ type: 'settings', tab: 'cloud', section: 'messagingChannels' });
      });

      it('should parse all valid settings tabs', () => {
        for (const tab of SETTINGS_TABS) {
          const result = parseNavigationUrl(`rebel://settings/${tab}`);
          expect(result).toEqual({ type: 'settings', tab, section: undefined });
        }
      });

      it('should resolve tab aliases (connectors → tools)', () => {
        const result = parseNavigationUrl('rebel://settings/connectors');
        expect(result).toEqual({ type: 'settings', tab: 'tools', section: undefined });
      });

      it('should resolve tab alias with section', () => {
        const result = parseNavigationUrl('rebel://settings/connectors#experimental-connectors');
        expect(result).toEqual({ type: 'settings', tab: 'tools', section: 'experimental-connectors' });
      });

      it('should resolve support alias to diagnostics tab', () => {
        const result = parseNavigationUrl('rebel://settings/support');
        expect(result).toEqual({ type: 'settings', tab: 'diagnostics', section: undefined });
      });

      it('should ignore invalid tab and open settings without tab', () => {
        const result = parseNavigationUrl('rebel://settings/invalidtab');
        expect(result).toEqual({ type: 'settings', tab: undefined, section: undefined });
      });

      it('should handle trailing slash', () => {
        const result = parseNavigationUrl('rebel://settings/agents/');
        expect(result).toEqual({ type: 'settings', tab: 'agents', section: undefined });
      });
    });

    describe('session/conversation URLs', () => {
      it('should parse rebel://conversation/{id}', () => {
        const result = parseNavigationUrl('rebel://conversation/abc-123');
        expect(result).toEqual({ type: 'sessions', sessionId: 'abc-123' });
      });

      it('should parse rebel://sessions/{id}', () => {
        const result = parseNavigationUrl('rebel://sessions/abc-123');
        expect(result).toEqual({ type: 'sessions', sessionId: 'abc-123' });
      });

      it('should parse rebel://conversation without id', () => {
        const result = parseNavigationUrl('rebel://conversation');
        expect(result).toEqual({ type: 'sessions', sessionId: undefined });
      });

      it('should parse rebel://sessions without id', () => {
        const result = parseNavigationUrl('rebel://sessions');
        expect(result).toEqual({ type: 'sessions', sessionId: undefined });
      });

      it('should parse rebel://chat/from-dashboard links with a token', () => {
        const result = parseNavigationUrl('rebel://chat/from-dashboard?token=abc-123');
        expect(result).toEqual({ type: 'dashboard-chat', token: 'abc-123' });
      });

      it('should reject rebel://chat/from-dashboard links without a token', () => {
        const result = parseNavigationUrl('rebel://chat/from-dashboard');
        expect(result).toBeNull();
      });
    });

    describe('library URLs', () => {
      it('should parse rebel://library', () => {
        const result = parseNavigationUrl('rebel://library');
        expect(result).toEqual({ type: 'library' });
      });

      it('should parse rebel://library/{path}', () => {
        const result = parseNavigationUrl('rebel://library/docs/readme.md');
        expect(result).toEqual({ type: 'library', filePath: 'docs/readme.md' });
      });

      it('should decode URL-encoded library paths', () => {
        const result = parseNavigationUrl('rebel://library/my%20folder/file.txt');
        expect(result).toEqual({ type: 'library', filePath: 'my folder/file.txt' });
      });

      it('should parse rebel://library/{path}?type=folder as folderPath', () => {
        const result = parseNavigationUrl('rebel://library/my-space?type=folder');
        expect(result).toEqual({ type: 'library', folderPath: 'my-space' });
      });

      it('should decode URL-encoded folder paths', () => {
        const result = parseNavigationUrl('rebel://library/my%20folder?type=folder');
        expect(result).toEqual({ type: 'library', folderPath: 'my folder' });
      });

      it('should ignore type param without path', () => {
        const result = parseNavigationUrl('rebel://library?type=folder');
        expect(result).toEqual({ type: 'library' });
      });

      it('should parse rebel://library?filter=plugins', () => {
        const result = parseNavigationUrl('rebel://library?filter=plugins');
        expect(result).toEqual({ type: 'library', filter: 'plugins' });
      });

      it('should ignore unknown filter values', () => {
        const result = parseNavigationUrl('rebel://library?filter=bogus');
        expect(result).toEqual({ type: 'library' });
      });

      it('should combine filter with file path', () => {
        const result = parseNavigationUrl('rebel://library/docs/readme.md?filter=skills');
        expect(result).toEqual({ type: 'library', filter: 'skills', filePath: 'docs/readme.md' });
      });

      // Backwards compatibility: old 'workspace' URLs should parse to 'library' type
      it('should parse rebel://workspace as library (backwards compat)', () => {
        const result = parseNavigationUrl('rebel://workspace');
        expect(result).toEqual({ type: 'library' });
      });

      it('should parse rebel://workspace/{path} as library (backwards compat)', () => {
        const result = parseNavigationUrl('rebel://workspace/docs/readme.md');
        expect(result).toEqual({ type: 'library', filePath: 'docs/readme.md' });
      });
    });

    describe('space URLs', () => {
      it('should parse rebel://space/{spaceName}/{filePath}', () => {
        const result = parseNavigationUrl('rebel://space/My%20Space/file.md');
        expect(result).toEqual({ type: 'space', spaceName: 'My Space', filePath: 'file.md' });
      });

      it('should parse space URL with folder path', () => {
        const result = parseNavigationUrl('rebel://space/My%20Space/docs?type=folder');
        expect(result).toEqual({ type: 'space', spaceName: 'My Space', folderPath: 'docs' });
      });

      it('should parse space root (no path)', () => {
        const result = parseNavigationUrl('rebel://space/My%20Space');
        expect(result).toEqual({ type: 'space', spaceName: 'My Space' });
      });

      it('should handle space name with encoded slash', () => {
        const result = parseNavigationUrl('rebel://space/My%20Space%2FSlash/file.md');
        expect(result).toEqual({ type: 'space', spaceName: 'My Space/Slash', filePath: 'file.md' });
      });

      it('should safely handle path traversal (URL normalization resolves it)', () => {
        // WHATWG URL spec normalizes ../.. paths before we see them
        // rebel://space/My%20Space/../../etc/passwd → pathname becomes /etc/passwd
        // So spaceName = 'etc', filePath = 'passwd' (safe - no traversal)
        const result = parseNavigationUrl('rebel://space/My%20Space/../../etc/passwd');
        expect(result).toEqual({ type: 'space', spaceName: 'etc', filePath: 'passwd' });
      });

      it('should reject backslashes in relative path', () => {
        expect(parseNavigationUrl('rebel://space/My%20Space/foo%5Cbar')).toBeNull();
      });

      it('should reject NUL bytes in relative path', () => {
        expect(parseNavigationUrl('rebel://space/My%20Space/foo%00bar')).toBeNull();
      });

      it('should return null for no space name', () => {
        expect(parseNavigationUrl('rebel://space')).toBeNull();
        expect(parseNavigationUrl('rebel://space/')).toBeNull();
      });

      it('should parse nested relative path', () => {
        const result = parseNavigationUrl('rebel://space/Exec/memory/topics/Q1.md');
        expect(result).toEqual({ type: 'space', spaceName: 'Exec', filePath: 'memory/topics/Q1.md' });
      });

      it('should handle case-insensitive host', () => {
        const result = parseNavigationUrl('rebel://SPACE/My%20Space/file.md');
        expect(result).toEqual({ type: 'space', spaceName: 'My Space', filePath: 'file.md' });
      });

      it('should handle trailing slash on space root', () => {
        const result = parseNavigationUrl('rebel://space/My%20Space/');
        expect(result).toEqual({ type: 'space', spaceName: 'My Space' });
      });

      it('should decode nested folder path', () => {
        const result = parseNavigationUrl('rebel://space/Exec/memory/topics?type=folder');
        expect(result).toEqual({ type: 'space', spaceName: 'Exec', folderPath: 'memory/topics' });
      });
    });

    describe('automations URLs', () => {
      it('should parse rebel://automations', () => {
        const result = parseNavigationUrl('rebel://automations');
        expect(result).toEqual({ type: 'automations', automationId: undefined });
      });

      it('should parse rebel://automations/{id}', () => {
        const result = parseNavigationUrl('rebel://automations/auto-123');
        expect(result).toEqual({ type: 'automations', automationId: 'auto-123' });
      });
    });

    describe('team URLs', () => {
      it('should parse rebel://team', () => {
        const result = parseNavigationUrl('rebel://team');
        expect(result).toEqual({ type: 'team' });
      });

      it('should parse rebel://team/{roleId}', () => {
        const result = parseNavigationUrl('rebel://team/role-123');
        expect(result).toEqual({ type: 'team', roleId: 'role-123' });
      });

      it('should decode URL-encoded roleId', () => {
        const result = parseNavigationUrl('rebel://team/role%20with%20spaces');
        expect(result).toEqual({ type: 'team', roleId: 'role with spaces' });
      });
    });

    describe('focus URLs', () => {
      it('should parse rebel://focus', () => {
        const result = parseNavigationUrl('rebel://focus');
        expect(result).toEqual({ type: 'focus', lens: undefined });
      });

      it('should parse rebel://focus/week', () => {
        const result = parseNavigationUrl('rebel://focus/week');
        expect(result).toEqual({ type: 'focus', lens: 'week' });
      });

      it('should parse rebel://focus/month', () => {
        const result = parseNavigationUrl('rebel://focus/month');
        expect(result).toEqual({ type: 'focus', lens: 'month' });
      });

      it('should parse rebel://focus/quarter', () => {
        const result = parseNavigationUrl('rebel://focus/quarter');
        expect(result).toEqual({ type: 'focus', lens: 'quarter' });
      });

      it('should ignore invalid lens and return undefined lens', () => {
        const result = parseNavigationUrl('rebel://focus/yearly');
        expect(result).toEqual({ type: 'focus', lens: undefined });
      });

      it('should handle trailing slash', () => {
        const result = parseNavigationUrl('rebel://focus/');
        expect(result).toEqual({ type: 'focus', lens: undefined });
      });
    });

    describe('simple surface URLs', () => {
      it('should parse rebel://home', () => {
        const result = parseNavigationUrl('rebel://home');
        expect(result).toEqual({ type: 'home' });
      });

      it('should parse rebel://tasks', () => {
        const result = parseNavigationUrl('rebel://tasks');
        expect(result).toEqual({ type: 'tasks' });
      });

      it('should parse rebel://tasks/{id} with focused approval', () => {
        expect(parseNavigationUrl('rebel://tasks/approval-abc')).toEqual({
          type: 'tasks',
          focusApprovalId: 'approval-abc',
        });
      });

      it('should parse rebel://tasks?focusApprovalId={id} as alias', () => {
        expect(parseNavigationUrl('rebel://tasks?focusApprovalId=approval-abc')).toEqual({
          type: 'tasks',
          focusApprovalId: 'approval-abc',
        });
      });

      it('should decode percent-encoded focus approval ids', () => {
        expect(parseNavigationUrl('rebel://tasks/approval%20abc')).toEqual({
          type: 'tasks',
          focusApprovalId: 'approval abc',
        });
      });

      it('should parse rebel://usecases', () => {
        const result = parseNavigationUrl('rebel://usecases');
        expect(result).toEqual({ type: 'usecases', useCaseId: undefined });
      });

      it('should parse rebel://usecases/{id}', () => {
        const result = parseNavigationUrl('rebel://usecases/usecase-123');
        expect(result).toEqual({ type: 'usecases', useCaseId: 'usecase-123' });
      });
    });

    describe('insights URLs', () => {
      it('should parse rebel://insights/{turnId}', () => {
        const result = parseNavigationUrl('rebel://insights/turn-456');
        expect(result).toEqual({ type: 'insights', turnId: 'turn-456' });
      });

      it('should return null for rebel://insights without turnId', () => {
        const result = parseNavigationUrl('rebel://insights');
        expect(result).toBeNull();
      });
    });

    describe('media URLs', () => {
      it('should parse rebel://media/{path}', () => {
        const result = parseNavigationUrl('rebel://media/resources/video.mp4');
        expect(result).toEqual({ type: 'media', resourcePath: 'resources/video.mp4' });
      });

      it('should return null for rebel://media without path', () => {
        const result = parseNavigationUrl('rebel://media');
        expect(result).toBeNull();
      });
    });

    describe('plugin URLs', () => {
      it('should parse rebel://plugin/{pluginId}', () => {
        const result = parseNavigationUrl('rebel://plugin/test');
        expect(result).toEqual({ type: 'plugin', pluginId: 'test', tabId: undefined });
      });

      it('should parse rebel://plugin/{pluginId}/{tabId}', () => {
        const result = parseNavigationUrl('rebel://plugin/my-plugin/settings');
        expect(result).toEqual({ type: 'plugin', pluginId: 'my-plugin', tabId: 'settings' });
      });

      it('should return null for rebel://plugin without pluginId', () => {
        const result = parseNavigationUrl('rebel://plugin');
        expect(result).toBeNull();
      });

      it('should return null for rebel://plugin/', () => {
        const result = parseNavigationUrl('rebel://plugin/');
        expect(result).toBeNull();
      });

      it('should decode URL-encoded plugin IDs', () => {
        const result = parseNavigationUrl('rebel://plugin/my%20plugin');
        expect(result).toEqual({ type: 'plugin', pluginId: 'my plugin', tabId: undefined });
      });

      it('should parse plugin URL with single query param', () => {
        const result = parseNavigationUrl('rebel://plugin/file-viewer?path=/docs/README.md');
        expect(result).toEqual({
          type: 'plugin',
          pluginId: 'file-viewer',
          tabId: undefined,
          params: { path: '/docs/README.md' },
        });
      });

      it('should parse plugin URL with multiple query params', () => {
        const result = parseNavigationUrl('rebel://plugin/meeting-prep?meetingId=abc&tab=agenda');
        expect(result).toEqual({
          type: 'plugin',
          pluginId: 'meeting-prep',
          tabId: undefined,
          params: { meetingId: 'abc', tab: 'agenda' },
        });
      });

      it('should parse plugin URL with tabId and query params', () => {
        const result = parseNavigationUrl('rebel://plugin/my-plugin/settings?theme=dark&lang=en');
        expect(result).toEqual({
          type: 'plugin',
          pluginId: 'my-plugin',
          tabId: 'settings',
          params: { theme: 'dark', lang: 'en' },
        });
      });

      it('should decode URL-encoded query param values', () => {
        const result = parseNavigationUrl('rebel://plugin/person-dossier?person=Jane+Doe');
        expect(result).toEqual({
          type: 'plugin',
          pluginId: 'person-dossier',
          tabId: undefined,
          params: { person: 'Jane Doe' },
        });
      });

      it('should handle URL-encoded special characters in params', () => {
        const result = parseNavigationUrl('rebel://plugin/viewer?path=%2Fdocs%2FREADME.md&q=hello%20world%26more');
        expect(result).toEqual({
          type: 'plugin',
          pluginId: 'viewer',
          tabId: undefined,
          params: { path: '/docs/README.md', q: 'hello world&more' },
        });
      });

      it('should omit params field when no query params present', () => {
        const result = parseNavigationUrl('rebel://plugin/test-plugin');
        expect(result).toEqual({ type: 'plugin', pluginId: 'test-plugin', tabId: undefined });
        expect(result).not.toHaveProperty('params');
      });

      it('should handle empty param value', () => {
        const result = parseNavigationUrl('rebel://plugin/test?key=');
        expect(result).toEqual({
          type: 'plugin',
          pluginId: 'test',
          tabId: undefined,
          params: { key: '' },
        });
      });
    });

    describe('feedback URLs', () => {
      it('should parse rebel://feedback', () => {
        const result = parseNavigationUrl('rebel://feedback');
        expect(result).toEqual({ type: 'feedback', feedbackType: undefined, description: undefined, stepsToReproduce: undefined, expectedBehavior: undefined });
      });

      it('should parse rebel://feedback/bug', () => {
        const result = parseNavigationUrl('rebel://feedback/bug');
        expect(result).toEqual({ type: 'feedback', feedbackType: 'bug', description: undefined, stepsToReproduce: undefined, expectedBehavior: undefined });
      });

      it('should parse rebel://feedback/improvement', () => {
        const result = parseNavigationUrl('rebel://feedback/improvement');
        expect(result).toEqual({ type: 'feedback', feedbackType: 'improvement', description: undefined, stepsToReproduce: undefined, expectedBehavior: undefined });
      });

      it('should parse rebel://feedback/bug with description', () => {
        const result = parseNavigationUrl('rebel://feedback/bug?description=something%20broke');
        expect(result).toEqual({ type: 'feedback', feedbackType: 'bug', description: 'something broke', stepsToReproduce: undefined, expectedBehavior: undefined });
      });

      it('should ignore invalid feedback type', () => {
        const result = parseNavigationUrl('rebel://feedback/invalid');
        expect(result).toEqual({ type: 'feedback', feedbackType: undefined, description: undefined, stepsToReproduce: undefined, expectedBehavior: undefined });
      });

      it('should handle URL-encoded special characters in description', () => {
        const result = parseNavigationUrl('rebel://feedback/bug?description=line%201%0Aline%202%20%26%20more');
        expect(result).toEqual({ type: 'feedback', feedbackType: 'bug', description: 'line 1\nline 2 & more', stepsToReproduce: undefined, expectedBehavior: undefined });
      });

      it('should truncate overly long descriptions', () => {
        const longDesc = 'a'.repeat(6000);
        const result = parseNavigationUrl(`rebel://feedback/bug?description=${longDesc}`);
        expect(result?.type).toBe('feedback');
        if (result?.type === 'feedback') {
          expect(result.description?.length).toBe(5000);
        }
      });

      it('should parse stepsToReproduce query param', () => {
        const result = parseNavigationUrl('rebel://feedback/bug?stepsToReproduce=1.+Open+app');
        expect(result).toEqual({
          type: 'feedback',
          feedbackType: 'bug',
          description: undefined,
          stepsToReproduce: '1. Open app',
          expectedBehavior: undefined,
        });
      });

      it('should parse expectedBehavior query param', () => {
        const result = parseNavigationUrl('rebel://feedback/bug?expectedBehavior=Should+not+crash');
        expect(result).toEqual({
          type: 'feedback',
          feedbackType: 'bug',
          description: undefined,
          stepsToReproduce: undefined,
          expectedBehavior: 'Should not crash',
        });
      });

      it('should parse all three feedback params together', () => {
        const result = parseNavigationUrl(
          'rebel://feedback/bug?description=App+crashes&stepsToReproduce=1.+Open+app%0A2.+Click+button&expectedBehavior=No+crash'
        );
        expect(result).toEqual({
          type: 'feedback',
          feedbackType: 'bug',
          description: 'App crashes',
          stepsToReproduce: '1. Open app\n2. Click button',
          expectedBehavior: 'No crash',
        });
      });

      it('should parse attachContinuityDiagnostics=1 for feedback bug links', () => {
        const result = parseNavigationUrl('rebel://feedback/bug?attachContinuityDiagnostics=1');
        expect(result).toEqual({
          type: 'feedback',
          feedbackType: 'bug',
          description: undefined,
          stepsToReproduce: undefined,
          expectedBehavior: undefined,
          attachContinuityDiagnostics: true,
        });
      });

      it('should handle multiline stepsToReproduce content', () => {
        const steps = '1. Open app\n2. Click button\n3. See error';
        const encoded = encodeURIComponent(steps);
        const result = parseNavigationUrl(`rebel://feedback/bug?stepsToReproduce=${encoded}`);
        expect(result?.type).toBe('feedback');
        if (result?.type === 'feedback') {
          expect(result.stepsToReproduce).toBe(steps);
        }
      });

      it('should handle special characters in stepsToReproduce', () => {
        const result = parseNavigationUrl(
          'rebel://feedback/bug?stepsToReproduce=Click+%22Save+%26+Close%22'
        );
        expect(result?.type).toBe('feedback');
        if (result?.type === 'feedback') {
          expect(result.stepsToReproduce).toBe('Click "Save & Close"');
        }
      });

      it('should truncate overly long stepsToReproduce', () => {
        const longSteps = 'x'.repeat(6000);
        const result = parseNavigationUrl(`rebel://feedback/bug?stepsToReproduce=${longSteps}`);
        expect(result?.type).toBe('feedback');
        if (result?.type === 'feedback') {
          expect(result.stepsToReproduce?.length).toBe(5000);
        }
      });

      it('should truncate overly long expectedBehavior', () => {
        const longExpected = 'y'.repeat(6000);
        const result = parseNavigationUrl(`rebel://feedback/bug?expectedBehavior=${longExpected}`);
        expect(result?.type).toBe('feedback');
        if (result?.type === 'feedback') {
          expect(result.expectedBehavior?.length).toBe(5000);
        }
      });
    });

    describe('action URLs', () => {
      it('should parse canonical rebel://action/start-voice', () => {
        expect(parseNavigationUrl('rebel://action/start-voice')).toEqual({
          type: 'action',
          action: 'start-voice',
        });
      });

      it('should parse canonical rebel://action/start-meeting-recording', () => {
        expect(parseNavigationUrl('rebel://action/start-meeting-recording')).toEqual({
          type: 'action',
          action: 'start-meeting-recording',
        });
      });

      it('should parse canonical rebel://action/stop-meeting-recording', () => {
        expect(parseNavigationUrl('rebel://action/stop-meeting-recording')).toEqual({
          type: 'action',
          action: 'stop-meeting-recording',
        });
      });

      it('should accept unknown action verbs (open-ended)', () => {
        expect(parseNavigationUrl('rebel://action/some-plugin-verb')).toEqual({
          type: 'action',
          action: 'some-plugin-verb',
        });
      });

      it('should parse query params into params record', () => {
        expect(parseNavigationUrl('rebel://action/start-voice?source=widget&foo=bar')).toEqual({
          type: 'action',
          action: 'start-voice',
          params: { source: 'widget', foo: 'bar' },
        });
      });

      it('should return null when action verb is missing', () => {
        expect(parseNavigationUrl('rebel://action')).toBeNull();
        expect(parseNavigationUrl('rebel://action/')).toBeNull();
      });

      it('should map legacy rebel:///start-voice to canonical action target', () => {
        expect(parseNavigationUrl('rebel:///start-voice')).toEqual({
          type: 'action',
          action: 'start-voice',
        });
      });

      it('should map legacy rebel:///start-meeting-recording to canonical action target', () => {
        expect(parseNavigationUrl('rebel:///start-meeting-recording')).toEqual({
          type: 'action',
          action: 'start-meeting-recording',
        });
      });

      it('should map legacy rebel:///stop-meeting-recording to canonical action target', () => {
        expect(parseNavigationUrl('rebel:///stop-meeting-recording')).toEqual({
          type: 'action',
          action: 'stop-meeting-recording',
        });
      });

      it('should map legacy rebel:///inbox-item/{id} to tasks navigation (not action)', () => {
        // inbox-item is navigation-shaped ("focus this approval") not a side-effect.
        expect(parseNavigationUrl('rebel:///inbox-item/approval-123')).toEqual({
          type: 'tasks',
          focusApprovalId: 'approval-123',
        });
      });

      it('should decode percent-encoded inbox-item ids', () => {
        expect(parseNavigationUrl('rebel:///inbox-item/abc%20def')).toEqual({
          type: 'tasks',
          focusApprovalId: 'abc def',
        });
      });

      it('should reject unknown legacy three-slash verbs', () => {
        // We explicitly do NOT accept arbitrary verbs via the empty-host form —
        // the canonical rebel://action/... form must be used for new verbs.
        expect(parseNavigationUrl('rebel:///some-future-verb')).toBeNull();
      });

      it('should reject bare rebel:/// with no path', () => {
        expect(parseNavigationUrl('rebel:///')).toBeNull();
      });
    });

    describe('path traversal prevention', () => {
      it('should safely handle .. in path (URL normalization resolves it)', () => {
        // WHATWG URL spec normalizes ../.. paths before we see them
        // rebel://library/../etc/passwd → pathname becomes /etc/passwd after URL normalization
        // This results in filePath: 'etc/passwd' which is relative to library (safe)
        expect(parseNavigationUrl('rebel://library/../etc/passwd')).toEqual({
          type: 'library',
          filePath: 'etc/passwd'
        });
      });

      it('should safely handle URL-encoded .. (%2e%2e) in library path', () => {
        // WHATWG URL spec also normalizes URL-encoded traversal sequences
        // This is security-positive behavior - URL parser catches encoded traversal
        expect(parseNavigationUrl('rebel://library/%2e%2e/etc/passwd')).toEqual({
          type: 'library',
          filePath: 'etc/passwd'
        });
      });

      it('should safely handle . in path (URL normalization resolves it)', () => {
        // URL constructor normalizes ./ paths before we see them
        expect(parseNavigationUrl('rebel://library/./hidden')).toEqual({
          type: 'library',
          filePath: 'hidden'
        });
      });

      it('should safely handle URL-encoded . (%2e) in library path', () => {
        // WHATWG URL spec normalizes URL-encoded . as well
        expect(parseNavigationUrl('rebel://library/%2e/hidden')).toEqual({
          type: 'library',
          filePath: 'hidden'
        });
      });

      it('should reject backslashes in library path', () => {
        expect(parseNavigationUrl('rebel://library/foo\\bar')).toBeNull();
        expect(parseNavigationUrl('rebel://library/foo%5Cbar')).toBeNull(); // URL-encoded backslash
      });

      it('should reject NUL bytes in library path', () => {
        expect(parseNavigationUrl('rebel://library/foo%00bar')).toBeNull();
      });

      it('should reject absolute paths in library', () => {
        // These would become /path after URL parsing, which we reject
        expect(parseNavigationUrl('rebel://library//etc/passwd')).toBeNull();
      });

      it('should reject Windows drive letters in library path', () => {
        expect(parseNavigationUrl('rebel://library/C:/Windows/System32')).toBeNull();
      });

      it('should reject UNC paths in library path', () => {
        expect(parseNavigationUrl('rebel://library/%5C%5Cserver%5Cshare')).toBeNull(); // \\server\share
      });
    });

    describe('malformed URL handling', () => {
      it('should return null for non-rebel:// URLs', () => {
        expect(parseNavigationUrl('https://example.com')).toBeNull();
        expect(parseNavigationUrl('file:///path/to/file')).toBeNull();
        expect(parseNavigationUrl('library://path')).toBeNull();
        expect(parseNavigationUrl('workspace://path')).toBeNull(); // backwards compat protocol
      });

      it('should return null for invalid URLs', () => {
        expect(parseNavigationUrl('not a url')).toBeNull();
        expect(parseNavigationUrl('')).toBeNull();
        expect(parseNavigationUrl('rebel://')).toBeNull();
      });

      it('should return null for unknown rebel:// hosts', () => {
        expect(parseNavigationUrl('rebel://unknown')).toBeNull();
        expect(parseNavigationUrl('rebel://foo/bar')).toBeNull();
      });

      it('should handle malformed percent encoding gracefully', () => {
        // Invalid percent encoding in path should return null
        const result = parseNavigationUrl('rebel://workspace/%GG');
        expect(result).toBeNull();
      });

      it('should gracefully degrade invalid hash encoding', () => {
        // Invalid percent encoding in hash should ignore section but parse rest
        const result = parseNavigationUrl('rebel://settings/agents#%GG');
        expect(result).toEqual({ type: 'settings', tab: 'agents', section: undefined });
      });
    });

    describe('edge cases', () => {
      it('should handle case-insensitive scheme', () => {
        expect(parseNavigationUrl('REBEL://settings')).toEqual({
          type: 'settings',
          tab: undefined,
          section: undefined
        });
        expect(parseNavigationUrl('Rebel://Settings')).toEqual({
          type: 'settings',
          tab: undefined,
          section: undefined
        });
      });

      it('should handle case-insensitive host', () => {
        expect(parseNavigationUrl('rebel://SETTINGS/agents')).toEqual({
          type: 'settings',
          tab: 'agents',
          section: undefined
        });
      });

      it('should normalize trailing slashes', () => {
        expect(parseNavigationUrl('rebel://settings/')).toEqual({
          type: 'settings',
          tab: undefined,
          section: undefined
        });
        expect(parseNavigationUrl('rebel://library/')).toEqual({
          type: 'library'
        });
      });

      it('should handle empty hash', () => {
        const result = parseNavigationUrl('rebel://settings/agents#');
        expect(result).toEqual({ type: 'settings', tab: 'agents', section: undefined });
      });
    });
  });

  describe('formatNavigationUrl', () => {
    describe('home URLs', () => {
      it('should format home', () => {
        const url = formatNavigationUrl({ type: 'home' });
        expect(url).toBe('rebel://home');
      });
    });

    describe('settings URLs', () => {
      it('should format settings without tab', () => {
        const url = formatNavigationUrl({ type: 'settings' });
        expect(url).toBe('rebel://settings');
      });

      it('should format settings with tab', () => {
        const url = formatNavigationUrl({ type: 'settings', tab: 'agents' });
        expect(url).toBe('rebel://settings/agents');
      });

      it('should format settings with section only', () => {
        const url = formatNavigationUrl({ type: 'settings', section: 'voiceAudio' });
        expect(url).toBe('rebel://settings#voiceAudio');
      });

      it('should format settings with tab and section', () => {
        const url = formatNavigationUrl({ type: 'settings', tab: 'agents', section: 'voiceAudio' });
        expect(url).toBe('rebel://settings/agents#voiceAudio');
      });
    });

    describe('session URLs', () => {
      it('should format sessions as conversation URL', () => {
        const url = formatNavigationUrl({ type: 'sessions', sessionId: 'abc-123' });
        expect(url).toBe('rebel://conversation/abc-123');
      });

      it('should format sessions without id', () => {
        const url = formatNavigationUrl({ type: 'sessions' });
        expect(url).toBe('rebel://conversation');
      });
    });

    describe('library URLs', () => {
      it('should format library without path', () => {
        const url = formatNavigationUrl({ type: 'library' });
        expect(url).toBe('rebel://library');
      });

      it('should format library with filePath', () => {
        const url = formatNavigationUrl({ type: 'library', filePath: 'docs/readme.md' });
        expect(url).toBe('rebel://library/docs%2Freadme.md');
      });

      it('should format library with folderPath', () => {
        const url = formatNavigationUrl({ type: 'library', folderPath: 'my-space' });
        expect(url).toBe('rebel://library/my-space?type=folder');
      });

      it('should encode special characters in library filePath', () => {
        const url = formatNavigationUrl({ type: 'library', filePath: 'my folder/file.txt' });
        expect(url).toBe('rebel://library/my%20folder%2Ffile.txt');
      });

      it('should encode special characters in library folderPath', () => {
        const url = formatNavigationUrl({ type: 'library', folderPath: 'my folder' });
        expect(url).toBe('rebel://library/my%20folder?type=folder');
      });

      it('should format library with filter only', () => {
        const url = formatNavigationUrl({ type: 'library', filter: 'plugins' });
        expect(url).toBe('rebel://library?filter=plugins');
      });

      it('should round-trip library with filter and folderPath', () => {
        const url = formatNavigationUrl({ type: 'library', filter: 'plugins', folderPath: 'My-Space' });
        expect(url).toBe('rebel://library/My-Space?type=folder&filter=plugins');
      });
    });

    describe('space URLs', () => {
      it('should format space root', () => {
        const url = formatNavigationUrl({ type: 'space', spaceName: 'My Space' });
        expect(url).toBe('rebel://space/My%20Space');
      });

      it('should format space with filePath', () => {
        const url = formatNavigationUrl({ type: 'space', spaceName: 'Exec', filePath: 'file.md' });
        expect(url).toBe('rebel://space/Exec/file.md');
      });

      it('should format space with folderPath', () => {
        const url = formatNavigationUrl({ type: 'space', spaceName: 'Exec', folderPath: 'docs' });
        expect(url).toBe('rebel://space/Exec/docs?type=folder');
      });

      it('should encode special characters in spaceName', () => {
        const url = formatNavigationUrl({ type: 'space', spaceName: 'My Space/Slash', filePath: 'file.md' });
        expect(url).toBe('rebel://space/My%20Space%2FSlash/file.md');
      });

      it('should encode nested filePath', () => {
        const url = formatNavigationUrl({ type: 'space', spaceName: 'Exec', filePath: 'memory/topics/Q1.md' });
        expect(url).toBe('rebel://space/Exec/memory%2Ftopics%2FQ1.md');
      });

      it('should encode nested folderPath', () => {
        const url = formatNavigationUrl({ type: 'space', spaceName: 'Exec', folderPath: 'memory/topics' });
        expect(url).toBe('rebel://space/Exec/memory%2Ftopics?type=folder');
      });
    });

    describe('focus URLs', () => {
      it('should format focus without lens', () => {
        const url = formatNavigationUrl({ type: 'focus' });
        expect(url).toBe('rebel://focus');
      });

      it('should format focus with week lens', () => {
        const url = formatNavigationUrl({ type: 'focus', lens: 'week' });
        expect(url).toBe('rebel://focus/week');
      });

      it('should format focus with month lens', () => {
        const url = formatNavigationUrl({ type: 'focus', lens: 'month' });
        expect(url).toBe('rebel://focus/month');
      });

      it('should format focus with quarter lens', () => {
        const url = formatNavigationUrl({ type: 'focus', lens: 'quarter' });
        expect(url).toBe('rebel://focus/quarter');
      });
    });

    describe('other URLs', () => {
      it('should format automations', () => {
        expect(formatNavigationUrl({ type: 'automations' })).toBe('rebel://automations');
        expect(formatNavigationUrl({ type: 'automations', automationId: 'auto-1' })).toBe(
          'rebel://automations/auto-1'
        );
      });

      it('should format team', () => {
        expect(formatNavigationUrl({ type: 'team' })).toBe('rebel://team');
        expect(formatNavigationUrl({ type: 'team', roleId: 'role-1' })).toBe(
          'rebel://team/role-1'
        );
      });

      it('should format tasks', () => {
        expect(formatNavigationUrl({ type: 'tasks' })).toBe('rebel://tasks');
      });

      it('should format usecases', () => {
        expect(formatNavigationUrl({ type: 'usecases' })).toBe('rebel://usecases');
        expect(formatNavigationUrl({ type: 'usecases', useCaseId: 'abc-123' })).toBe(
          'rebel://usecases/abc-123'
        );
      });

      it('should format insights', () => {
        expect(formatNavigationUrl({ type: 'insights', turnId: 'turn-1' })).toBe(
          'rebel://insights/turn-1'
        );
      });

      it('should format media', () => {
        expect(formatNavigationUrl({ type: 'media', resourcePath: 'resources/video.mp4' })).toBe(
          'rebel://media/resources%2Fvideo.mp4'
        );
      });

      it('should format feedback', () => {
        expect(formatNavigationUrl({ type: 'feedback' })).toBe('rebel://feedback');
        expect(formatNavigationUrl({ type: 'feedback', feedbackType: 'bug' })).toBe('rebel://feedback/bug');
        expect(formatNavigationUrl({ type: 'feedback', feedbackType: 'improvement' })).toBe('rebel://feedback/improvement');
      });

      it('should format feedback with description', () => {
        const url = formatNavigationUrl({ type: 'feedback', feedbackType: 'bug', description: 'something broke' });
        expect(url).toBe('rebel://feedback/bug?description=something+broke');
      });

      it('should format feedback with stepsToReproduce', () => {
        const url = formatNavigationUrl({ type: 'feedback', feedbackType: 'bug', stepsToReproduce: '1. Open app\n2. Click button' });
        expect(url).toBe('rebel://feedback/bug?stepsToReproduce=1.+Open+app%0A2.+Click+button');
      });

      it('should format feedback with expectedBehavior', () => {
        const url = formatNavigationUrl({ type: 'feedback', feedbackType: 'bug', expectedBehavior: 'No crash' });
        expect(url).toBe('rebel://feedback/bug?expectedBehavior=No+crash');
      });

      it('should format feedback with all three params', () => {
        const url = formatNavigationUrl({
          type: 'feedback',
          feedbackType: 'bug',
          description: 'App crashes',
          stepsToReproduce: '1. Open app',
          expectedBehavior: 'No crash',
        });
        expect(url).toBe('rebel://feedback/bug?description=App+crashes&stepsToReproduce=1.+Open+app&expectedBehavior=No+crash');
      });

      it('should format feedback with attachContinuityDiagnostics', () => {
        const url = formatNavigationUrl({
          type: 'feedback',
          feedbackType: 'bug',
          attachContinuityDiagnostics: true,
        });
        expect(url).toBe('rebel://feedback/bug?attachContinuityDiagnostics=1');
      });
    });

    describe('plugin URLs', () => {
      it('should format plugin without tabId', () => {
        const url = formatNavigationUrl({ type: 'plugin', pluginId: 'test' });
        expect(url).toBe('rebel://plugin/test');
      });

      it('should format plugin with tabId', () => {
        const url = formatNavigationUrl({ type: 'plugin', pluginId: 'my-plugin', tabId: 'settings' });
        expect(url).toBe('rebel://plugin/my-plugin/settings');
      });

      it('should encode special characters in plugin ID', () => {
        const url = formatNavigationUrl({ type: 'plugin', pluginId: 'my plugin' });
        expect(url).toBe('rebel://plugin/my%20plugin');
      });

      it('should format plugin with params', () => {
        const url = formatNavigationUrl({
          type: 'plugin',
          pluginId: 'file-viewer',
          params: { path: '/docs/README.md' },
        });
        expect(url).toBe('rebel://plugin/file-viewer?path=%2Fdocs%2FREADME.md');
      });

      it('should format plugin with tabId and params', () => {
        const url = formatNavigationUrl({
          type: 'plugin',
          pluginId: 'my-plugin',
          tabId: 'settings',
          params: { theme: 'dark', lang: 'en' },
        });
        expect(url).toBe('rebel://plugin/my-plugin/settings?theme=dark&lang=en');
      });

      it('should format plugin with multiple params', () => {
        const url = formatNavigationUrl({
          type: 'plugin',
          pluginId: 'meeting-prep',
          params: { meetingId: 'abc', tab: 'agenda' },
        });
        expect(url).toBe('rebel://plugin/meeting-prep?meetingId=abc&tab=agenda');
      });

      it('should omit query string when params is empty object', () => {
        const url = formatNavigationUrl({
          type: 'plugin',
          pluginId: 'test',
          params: {},
        });
        expect(url).toBe('rebel://plugin/test');
      });

      it('should omit query string when params is undefined', () => {
        const url = formatNavigationUrl({
          type: 'plugin',
          pluginId: 'test',
          params: undefined,
        });
        expect(url).toBe('rebel://plugin/test');
      });

      it('should encode special characters in param values', () => {
        const url = formatNavigationUrl({
          type: 'plugin',
          pluginId: 'search',
          params: { q: 'hello world&more' },
        });
        expect(url).toBe('rebel://plugin/search?q=hello+world%26more');
      });
    });

    describe('action URLs', () => {
      it('should format action without params', () => {
        expect(formatNavigationUrl({ type: 'action', action: 'start-voice' })).toBe(
          'rebel://action/start-voice',
        );
      });

      it('should format action with params', () => {
        expect(
          formatNavigationUrl({
            type: 'action',
            action: 'start-meeting-recording',
            params: { source: 'widget' },
          }),
        ).toBe('rebel://action/start-meeting-recording?source=widget');
      });

      it('should encode special characters in action verb', () => {
        expect(formatNavigationUrl({ type: 'action', action: 'weird verb' })).toBe(
          'rebel://action/weird%20verb',
        );
      });

      it('should omit query string when params is empty', () => {
        expect(
          formatNavigationUrl({ type: 'action', action: 'start-voice', params: {} }),
        ).toBe('rebel://action/start-voice');
      });
    });
  });

  describe('round-trip parsing', () => {
    const testCases: NavigationTarget[] = [
      { type: 'settings' },
      { type: 'settings', tab: 'agents' },
      { type: 'settings', tab: 'agents', section: 'voiceAudio' },
      { type: 'settings', section: 'coreDirectory' },
      { type: 'sessions' },
      { type: 'sessions', sessionId: 'abc-123' },
      { type: 'library' },
      { type: 'library', filePath: 'simple.txt' },
      { type: 'library', folderPath: 'my-space' },
      { type: 'space', spaceName: 'My Space' },
      { type: 'space', spaceName: 'Exec', filePath: 'file.md' },
      { type: 'space', spaceName: 'Exec', folderPath: 'docs' },
      { type: 'space', spaceName: 'My Space/Slash', filePath: 'report.md' },
      { type: 'focus' },
      { type: 'focus', lens: 'week' },
      { type: 'focus', lens: 'month' },
      { type: 'focus', lens: 'quarter' },
      { type: 'automations' },
      { type: 'automations', automationId: 'auto-1' },
      { type: 'team' },
      { type: 'team', roleId: 'role-1' },
      { type: 'tasks' },
      { type: 'tasks', focusApprovalId: 'approval-abc-123' },
      { type: 'usecases' },
      { type: 'usecases', useCaseId: 'abc-123' },
      { type: 'insights', turnId: 'turn-456' },
      { type: 'media', resourcePath: 'video.mp4' },
      { type: 'feedback' },
      { type: 'feedback', feedbackType: 'bug' },
      { type: 'feedback', feedbackType: 'improvement' },
      { type: 'feedback', feedbackType: 'bug', description: 'App crashes', stepsToReproduce: '1. Open app\n2. Click button', expectedBehavior: 'No crash' },
      { type: 'feedback', feedbackType: 'bug', stepsToReproduce: '1. Open app' },
      { type: 'feedback', feedbackType: 'bug', expectedBehavior: 'Should work' },
      { type: 'feedback', feedbackType: 'bug', attachContinuityDiagnostics: true },
      { type: 'plugin', pluginId: 'test' },
      { type: 'plugin', pluginId: 'my-plugin', tabId: 'settings' },
      { type: 'plugin', pluginId: 'file-viewer', params: { path: '/docs/README.md' } },
      { type: 'plugin', pluginId: 'meeting-prep', params: { meetingId: 'abc', tab: 'agenda' } },
      { type: 'plugin', pluginId: 'my-plugin', tabId: 'view', params: { theme: 'dark' } },
      { type: 'action', action: 'start-voice' },
      { type: 'action', action: 'start-meeting-recording' },
      { type: 'action', action: 'stop-meeting-recording' },
      { type: 'action', action: 'start-voice', params: { source: 'widget' } },
    ];

    it.each(testCases)('should round-trip: %j', (target) => {
      const url = formatNavigationUrl(target);
      const parsed = parseNavigationUrl(url);
      expect(parsed).toEqual(target);
    });
  });

  describe('isSettingsTabId', () => {
    it('should return true for valid tab IDs', () => {
      for (const tab of SETTINGS_TABS) {
        expect(isSettingsTabId(tab)).toBe(true);
      }
    });

    it('should return false for invalid tab IDs', () => {
      expect(isSettingsTabId('invalid')).toBe(false);
      expect(isSettingsTabId('')).toBe(false);
      expect(isSettingsTabId('SYSTEM')).toBe(false); // Case-sensitive
    });
  });

  describe('formatLibraryUrl', () => {
    it('produces canonical rebel://library/ URLs with encoded path', () => {
      expect(formatLibraryUrl('docs/file.md')).toBe('rebel://library/docs%2Ffile.md');
    });

    it('encodes spaces and special characters', () => {
      expect(formatLibraryUrl('my docs/file name.md')).toBe(
        'rebel://library/my%20docs%2Ffile%20name.md',
      );
    });

    it('handles empty path', () => {
      expect(formatLibraryUrl('')).toBe('rebel://library/');
    });

    // Stage H regression: the emitter used to produce `library://...`. Legacy
    // content stays parseable (extractLibraryPath / getLibraryProtocol continue
    // to accept it) but new content is always canonical rebel:// form.
    it('round-trips through parseNavigationUrl as a library target', () => {
      const url = formatLibraryUrl('docs/file.md');
      const parsed = parseNavigationUrl(url);
      expect(parsed).toEqual({ type: 'library', filePath: 'docs/file.md' });
    });
  });
});
