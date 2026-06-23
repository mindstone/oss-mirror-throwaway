import { describe, it, expect } from 'vitest';
import { 
  parseChangelogHighlights,
  parseChangelogSections,
  type ChangelogHighlight,
  compareVersions
} from '../utils/changelogParser';
import { calculateRelevanceScore, type UserFeatureProfile } from '../hooks/useUserFeatureProfile';
import { generateTryItPrompt } from '../utils/tryItPrompts';

describe('whats-new feature', () => {
  describe('parseChangelogHighlights', () => {
    const createMarkdown = (content: string) => content.trim();

    it('should parse basic highlight entries', () => {
      const markdown = createMarkdown(`
## v0.3.5 — Jan 5-6, 2026

### Highlights

- **Multi-Account Support** — Connect multiple accounts for the same service.
- **Better Search** — Improved semantic search across your files.

### Improvements

- Fixed a bug with voice recording.
      `);

      const highlights = parseChangelogHighlights(markdown, '0.3.5');
      
      expect(highlights).toHaveLength(2);
      expect(highlights[0].title).toBe('Multi-Account Support');
      expect(highlights[0].description).toBe('Connect multiple accounts for the same service.');
      expect(highlights[1].title).toBe('Better Search');
      expect(highlights[1].description).toBe('Improved semantic search across your files.');
    });

    it('should parse metadata comments in any order', () => {
      const markdown = createMarkdown(`
## v0.3.5 — Jan 5-6, 2026

### Highlights

<!-- tags: voice, memory | category: feedback | author: Josh Smith -->
- **Voice Improvements** — Better voice recognition accuracy.

<!-- author: Greg | category: tools | tags: slack -->
- **Slack Integration** — Connect your Slack workspace.

<!-- category: feedback -->
- **Just Category** — Only category specified.

<!-- tags: test -->
- **Just Tags** — Only tags specified.
      `);

      const highlights = parseChangelogHighlights(markdown, '0.3.5');
      
      expect(highlights).toHaveLength(4);
      
      // First: tags, category, author (different order)
      expect(highlights[0].title).toBe('Voice Improvements');
      expect(highlights[0].category).toBe('feedback');
      expect(highlights[0].tags).toEqual(['voice', 'memory']);
      expect(highlights[0].author).toBe('Josh Smith');
      
      // Second: author, category, tags (different order)
      expect(highlights[1].title).toBe('Slack Integration');
      expect(highlights[1].category).toBe('tools');
      expect(highlights[1].tags).toEqual(['slack']);
      expect(highlights[1].author).toBe('Greg');
      
      // Third: only category
      expect(highlights[2].title).toBe('Just Category');
      expect(highlights[2].category).toBe('feedback');
      expect(highlights[2].tags).toBeUndefined();
      
      // Fourth: only tags
      expect(highlights[3].title).toBe('Just Tags');
      expect(highlights[3].tags).toEqual(['test']);
      expect(highlights[3].category).toBeUndefined();
    });

    it('should parse action and image metadata', () => {
      const markdown = createMarkdown(`
## v0.3.5 — Jan 5-6, 2026

### Highlights

<!-- action: rebel://settings/voice | image: voice-preview.png -->
- **Voice Settings** — Configure your voice preferences.
      `);

      const highlights = parseChangelogHighlights(markdown, '0.3.5');
      
      expect(highlights).toHaveLength(1);
      expect(highlights[0].actionUrl).toBe('rebel://settings/voice');
      expect(highlights[0].imageUrl).toBe('voice-preview.png');
    });

    it('should return empty array for non-matching version', () => {
      const markdown = createMarkdown(`
## v0.3.5 — Jan 5-6, 2026

### Highlights

- **Feature** — Description.
      `);

      const highlights = parseChangelogHighlights(markdown, '0.3.4');
      expect(highlights).toHaveLength(0);
    });

    it('should handle version with v prefix in markdown', () => {
      const markdown = createMarkdown(`
## v0.3.5 — Jan 5-6, 2026

### Highlights

- **Feature** — Description.
      `);

      // Both with and without v prefix should work (we normalize)
      expect(parseChangelogHighlights(markdown, '0.3.5')).toHaveLength(1);
      expect(parseChangelogHighlights(markdown, 'v0.3.5')).toHaveLength(1); // v prefix gets normalized
    });

    it('should stop parsing after current version section', () => {
      const markdown = createMarkdown(`
## v0.3.5 — Jan 5-6, 2026

### Highlights

- **New Feature** — From latest version.

## v0.3.4 — Jan 1, 2026

### Highlights

- **Old Feature** — From previous version.
      `);

      const highlights = parseChangelogHighlights(markdown, '0.3.5');
      expect(highlights).toHaveLength(1);
      expect(highlights[0].title).toBe('New Feature');
    });

    it('should return empty array for undefined version', () => {
      const markdown = createMarkdown(`
## v0.3.5 — Jan 5-6, 2026

### Highlights

- **Feature** — Description.
      `);

      const highlights = parseChangelogHighlights(markdown, undefined);
      expect(highlights).toHaveLength(0);
    });

    it('should handle entries without description', () => {
      const markdown = createMarkdown(`
## v0.3.5 — Jan 5-6, 2026

### Highlights

- **Feature Without Description**
- **Feature With Description** — Has a description.
      `);

      const highlights = parseChangelogHighlights(markdown, '0.3.5');
      expect(highlights).toHaveLength(2);
      expect(highlights[0].title).toBe('Feature Without Description');
      expect(highlights[0].description).toBe('');
      expect(highlights[1].description).toBe('Has a description.');
    });
  });

  describe('parseChangelogSections', () => {
    const createMarkdown = (content: string) => content.trim();

    it('should parse multiple version sections with highlights and improvements', () => {
      const markdown = createMarkdown(`
## v0.3.5 — Jan 5-6, 2026

### Highlights

<!-- action: rebel://settings | author: Josh -->
- **New Feature** — Description of new feature.

### Improvements

- Fixed a bug.
- Performance improved.

## v0.3.4 — Jan 1, 2026

### Highlights

- **Old Feature** — From previous version.

### Improvements

- Minor fix.
      `);

      const sections = parseChangelogSections(markdown, '0.3.5');
      
      expect(sections).toHaveLength(2);
      
      // First section (current version)
      expect(sections[0].version).toBe('v0.3.5');
      expect(sections[0].date).toBe('Jan 5-6, 2026');
      expect(sections[0].isCurrentVersion).toBe(true);
      expect(sections[0].highlights).toHaveLength(1);
      expect(sections[0].highlights[0].title).toBe('New Feature');
      expect(sections[0].highlights[0].author).toBe('Josh');
      expect(sections[0].highlights[0].actionUrl).toBe('rebel://settings');
      expect(sections[0].improvements).toHaveLength(2);
      
      // Second section (older version)
      expect(sections[1].version).toBe('v0.3.4');
      expect(sections[1].isCurrentVersion).toBe(false);
      expect(sections[1].highlights).toHaveLength(1);
      expect(sections[1].improvements).toHaveLength(1);
    });

    it('should work without current version parameter', () => {
      const markdown = createMarkdown(`
## v0.3.5 — Jan 5-6, 2026

### Highlights

- **Feature** — Description.
      `);

      const sections = parseChangelogSections(markdown);
      
      expect(sections).toHaveLength(1);
      expect(sections[0].isCurrentVersion).toBe(false);
    });

    it('should parse all metadata fields in sections', () => {
      const markdown = createMarkdown(`
## v0.3.5 — Jan 5-6, 2026

### Highlights

<!-- category: tools | tags: slack, integration | author: Greg | action: rebel://tools -->
- **Slack Integration** — Connect Slack.
      `);

      const sections = parseChangelogSections(markdown, '0.3.5');
      
      expect(sections[0].highlights[0].category).toBe('tools');
      expect(sections[0].highlights[0].tags).toEqual(['slack', 'integration']);
      expect(sections[0].highlights[0].author).toBe('Greg');
      expect(sections[0].highlights[0].actionUrl).toBe('rebel://tools');
    });
  });

  describe('compareVersions', () => {
    it('should correctly compare equal versions', () => {
      expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
      expect(compareVersions('0.3.5', '0.3.5')).toBe(0);
    });

    it('should correctly compare different major versions', () => {
      expect(compareVersions('2.0.0', '1.0.0')).toBeGreaterThan(0);
      expect(compareVersions('1.0.0', '2.0.0')).toBeLessThan(0);
    });

    it('should correctly compare different minor versions', () => {
      expect(compareVersions('1.2.0', '1.1.0')).toBeGreaterThan(0);
      expect(compareVersions('1.1.0', '1.2.0')).toBeLessThan(0);
    });

    it('should correctly compare different patch versions', () => {
      expect(compareVersions('1.0.2', '1.0.1')).toBeGreaterThan(0);
      expect(compareVersions('1.0.1', '1.0.2')).toBeLessThan(0);
    });

    it('should handle edge case: 0.3.10 vs 0.3.9 (string comparison would fail)', () => {
      expect(compareVersions('0.3.10', '0.3.9')).toBeGreaterThan(0);
      expect(compareVersions('0.3.9', '0.3.10')).toBeLessThan(0);
    });

    it('should handle versions with v prefix', () => {
      expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
      expect(compareVersions('1.0.0', 'v1.0.0')).toBe(0);
      expect(compareVersions('v2.0.0', 'v1.0.0')).toBeGreaterThan(0);
    });

    it('should handle missing patch version', () => {
      expect(compareVersions('1.0', '1.0.0')).toBe(0);
      expect(compareVersions('1.0.0', '1.0')).toBe(0);
    });
  });

  describe('calculateRelevanceScore', () => {
    const createProfile = (overrides: Partial<UserFeatureProfile> = {}): UserFeatureProfile => ({
      loading: false,
      mcp: {
        connectedServers: [],
        hasConnections: false,
      },
      features: {
        voiceConfigured: false,
        hasAutomations: false,
        hasSpaces: false,
        meetingBotConfigured: false,
        privacyModeUsed: false,
      },
      onboarding: {
        completedSteps: [],
        hasUseCases: false,
      },
      ...overrides,
    });

    const createHighlight = (title: string, description: string): ChangelogHighlight => ({
      title,
      description,
    });

    it('should return base score (50) for unmatched highlight', () => {
      const profile = createProfile();
      const highlight = createHighlight('Random Feature', 'Does something random.');
      
      expect(calculateRelevanceScore(highlight, profile)).toBe(50);
    });

    it('should boost score for MCP-related highlight when user has connections', () => {
      const profile = createProfile({
        mcp: { connectedServers: ['gmail'], hasConnections: true },
      });
      const highlight = createHighlight('MCP Improvements', 'Better tool integration.');
      
      const score = calculateRelevanceScore(highlight, profile);
      expect(score).toBeGreaterThan(50);
    });

    it('should give extra boost when highlight matches specific connected server', () => {
      const profile = createProfile({
        mcp: { connectedServers: ['slack'], hasConnections: true },
      });
      const highlight = createHighlight('Slack Integration', 'Connect your Slack channels.');
      
      const score = calculateRelevanceScore(highlight, profile);
      expect(score).toBeGreaterThanOrEqual(75); // base + mcp + server match
    });

    it('should boost score for voice highlight when user has voice configured', () => {
      const profile = createProfile({
        features: {
          voiceConfigured: true,
          hasAutomations: false,
          hasSpaces: false,
          meetingBotConfigured: false,
          privacyModeUsed: false,
        },
      });
      const highlight = createHighlight('Voice Recording', 'Improved audio quality.');
      
      const score = calculateRelevanceScore(highlight, profile);
      expect(score).toBeGreaterThan(50);
    });

    it('should boost score for automation highlight when user has automations', () => {
      const profile = createProfile({
        features: {
          voiceConfigured: false,
          hasAutomations: true,
          hasSpaces: false,
          meetingBotConfigured: false,
          privacyModeUsed: false,
        },
      });
      const highlight = createHighlight('New Automation Triggers', 'Schedule your workflows.');
      
      const score = calculateRelevanceScore(highlight, profile);
      expect(score).toBeGreaterThan(50);
    });

    it('should boost score for privacy highlight when user has used privacy mode', () => {
      const profile = createProfile({
        features: {
          voiceConfigured: false,
          hasAutomations: false,
          hasSpaces: false,
          meetingBotConfigured: false,
          privacyModeUsed: true,
        },
      });
      const highlight = createHighlight('Privacy Controls', 'Better security for sensitive data.');
      
      const score = calculateRelevanceScore(highlight, profile);
      expect(score).toBeGreaterThan(50);
    });

    it('should cap score at 100', () => {
      const profile = createProfile({
        mcp: { connectedServers: ['slack', 'gmail', 'salesforce'], hasConnections: true },
        features: {
          voiceConfigured: true,
          hasAutomations: true,
          hasSpaces: true,
          meetingBotConfigured: true,
          privacyModeUsed: true,
        },
      });
      const highlight = createHighlight(
        'Slack Voice Integration',
        'Voice recording with MCP connector automation for memory spaces meeting privacy.'
      );
      
      const score = calculateRelevanceScore(highlight, profile);
      expect(score).toBeLessThanOrEqual(100);
    });
  });

  describe('generateTryItPrompt', () => {
    const createProfile = (overrides: Partial<UserFeatureProfile> = {}): UserFeatureProfile => ({
      loading: false,
      mcp: {
        connectedServers: [],
        hasConnections: false,
      },
      features: {
        voiceConfigured: false,
        hasAutomations: false,
        hasSpaces: false,
        meetingBotConfigured: false,
        privacyModeUsed: false,
      },
      onboarding: {
        completedSteps: [],
        hasUseCases: false,
      },
      ...overrides,
    });

    const createHighlight = (title: string, description: string): ChangelogHighlight => ({
      title,
      description,
    });

    it('should generate a personalized prompt for multi-account feature with Google', () => {
      const profile = createProfile({
        mcp: { connectedServers: ['google-calendar'], hasConnections: true },
      });
      const highlight = createHighlight('Multi-Account Support', 'Connect multiple accounts.');
      
      const result = generateTryItPrompt(highlight, profile);
      
      expect(result.prompt).toBeTruthy();
      expect(result.prompt.toLowerCase()).toContain('google');
    });

    it('should generate a generic prompt for unknown features', () => {
      const profile = createProfile();
      const highlight = createHighlight('Mysterious Feature', 'Does something mysterious.');
      
      const result = generateTryItPrompt(highlight, profile);
      
      expect(result.prompt).toBeTruthy();
      expect(result.prompt).toContain('Mysterious Feature');
    });

    it('should generate voice-specific prompt when user has voice configured', () => {
      const profile = createProfile({
        features: {
          voiceConfigured: true,
          hasAutomations: false,
          hasSpaces: false,
          meetingBotConfigured: false,
          privacyModeUsed: false,
        },
      });
      const highlight = createHighlight('Voice Recording', 'Better audio processing.');
      
      const result = generateTryItPrompt(highlight, profile);
      
      expect(result.prompt).toBeTruthy();
      expect(result.relevanceHint).toBe('You use voice');
    });

    it('should generate automation-specific prompt when user has automations', () => {
      const profile = createProfile({
        features: {
          voiceConfigured: false,
          hasAutomations: true,
          hasSpaces: false,
          meetingBotConfigured: false,
          privacyModeUsed: false,
        },
      });
      const highlight = createHighlight('Automation Triggers', 'Schedule your workflows.');
      
      const result = generateTryItPrompt(highlight, profile);
      
      expect(result.prompt).toBeTruthy();
      expect(result.relevanceHint).toBe('You use automations');
    });

    it('should return prompt object with correct structure', () => {
      const profile = createProfile();
      const highlight = createHighlight('Test Feature', 'Test description.');
      
      const result = generateTryItPrompt(highlight, profile);
      
      expect(typeof result.prompt).toBe('string');
      expect(result.prompt.length).toBeGreaterThan(0);
      // relevanceHint is optional
      expect(result.relevanceHint === undefined || typeof result.relevanceHint === 'string').toBe(true);
    });
  });
});
