import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildOurComponentsContext,
  OurComponentsContextUnavailableError,
  shouldInjectOurComponentsContext,
  stripOurComponentsCommand,
} from '../ourComponentsContextService';

const CORE_DIRECTORY = path.resolve(__dirname, '../../../..');

describe('stripOurComponentsCommand', () => {
  it('removes the explicit command token from the prompt', () => {
    const result = stripOurComponentsCommand('@CHIEF_DESIGNER redesign the settings toggles');

    expect(result.explicitRequested).toBe(true);
    expect(result.sanitizedPrompt).toBe('redesign the settings toggles');
  });

  it('keeps non-command prompts unchanged', () => {
    const result = stripOurComponentsCommand('review the current hero input');

    expect(result.explicitRequested).toBe(false);
    expect(result.sanitizedPrompt).toBe('review the current hero input');
  });
});

describe('shouldInjectOurComponentsContext', () => {
  it('injects when explicitly requested', () => {
    expect(shouldInjectOurComponentsContext('anything', [], true)).toBe(true);
  });

  it('injects for clear UI design prompts', () => {
    expect(
      shouldInjectOurComponentsContext('Design a new settings section using existing UI components'),
    ).toBe(true);
  });

  it('injects for natural-language visible Rebel UI review prompts', () => {
    expect(shouldInjectOurComponentsContext('Can you review the current screen?')).toBe(true);
    expect(shouldInjectOurComponentsContext('Please improve the settings page layout')).toBe(true);
    expect(shouldInjectOurComponentsContext('What do you think of the homepage UI?')).toBe(true);
    expect(shouldInjectOurComponentsContext('Polish the composer view')).toBe(true);
    expect(shouldInjectOurComponentsContext('Take a look at Settings > Meetings')).toBe(true);
    expect(shouldInjectOurComponentsContext('How does this screen feel?')).toBe(true);
  });

  it('injects when attachments point at UI component sources and the prompt is design-specific', () => {
    expect(
      shouldInjectOurComponentsContext('Can you review this button component?', [
        {
          id: '1',
          name: 'Button.tsx',
          path: '/tmp/Button.tsx',
          relativePath: 'src/renderer/components/ui/Button.tsx',
          size: 256,
          content: 'export const Button = () => null;',
        },
      ]),
    ).toBe(true);
  });

  it('does not inject for generic review prompts just because a UI file is attached', () => {
    expect(
      shouldInjectOurComponentsContext('Can you review this?', [
        {
          id: '1',
          name: 'Button.tsx',
          path: '/tmp/Button.tsx',
          relativePath: 'src/renderer/components/ui/Button.tsx',
          size: 256,
          content: 'export const Button = () => null;',
        },
      ]),
    ).toBe(false);
  });

  it('does not inject for unrelated writing prompts', () => {
    expect(shouldInjectOurComponentsContext('Write release notes for this sprint')).toBe(false);
  });

  it('does not inject for non-UI prompts that mention Rebel surfaces', () => {
    expect(shouldInjectOurComponentsContext('Write release notes for the settings launch')).toBe(false);
    expect(shouldInjectOurComponentsContext('Review this TypeScript service')).toBe(false);
    expect(shouldInjectOurComponentsContext('Can you review the screen capture service?')).toBe(false);
    expect(shouldInjectOurComponentsContext('Validate this component parser')).toBe(false);
  });
});

describe('buildOurComponentsContext', () => {
  it('builds a component guidance block from the existing README and manifest', async () => {
    const context = await buildOurComponentsContext({
      prompt: 'redesign the settings toggles so the hierarchy is clearer',
      coreDirectory: CORE_DIRECTORY,
    });

    expect(context).toContain('## Chief Designer');
    expect(context).toContain('Act as Rebel\'s Chief Designer');
    expect(context).toContain('Prefer existing `shared` families');
    expect(context).toContain('Settings Rows');
    expect(context).toContain('Toggles');
    expect(context).toContain('rebel-system/skills/ux/chief-designer/SKILL.md');
    expect(context).toContain('rebel-system/skills/ux/design-system-reviewer/SKILL.md');
    expect(context).toContain('rebel_get_app_screenshot');
    expect(context).toContain('rebel_navigate_app');
    expect(context).toContain('capture_mode');
    expect(context).toContain('the first visual-evidence step is mandatory');
    expect(context).toContain('workspace screenshot search');
    expect(context).toContain('Do not search recent screenshot files');
    expect(context).not.toContain('Playwright');
    expect(context).toContain('Design System Reviewer handoff');
    expect(context).toContain('DSR picker-mode output directly');
    expect(context).toContain('Do not end with a vague "handoff to DSR" note');
  });

  it('surfaces README guidance for icon button usage when relevant', async () => {
    const context = await buildOurComponentsContext({
      prompt: 'should this toolbar use an icon button for an icon-only action?',
      coreDirectory: CORE_DIRECTORY,
      explicitRequested: true,
    });

    expect(context).toContain('Icon Button');
    expect(context).toContain('Do not use it for primary CTAs');
    expect(context).toContain('Explicit command `@CHIEF_DESIGNER` requested this context.');
  });

  it('does not leak unrelated later README chapters into component guidance', async () => {
    const context = await buildOurComponentsContext({
      prompt: 'review this dialog and tooltip pattern',
      coreDirectory: CORE_DIRECTORY,
    });

    expect(context).not.toContain('All interactive UI elements should include `data-testid` attributes');
  });

  // REBEL-H6: production users open a non-Rebel coreDirectory, so the README
  // and storybook manifest are absent. Surface that as a typed error instead
  // of a generic ENOENT so the caller can downgrade its logging.
  describe('when grounding files are missing (production workspace)', () => {
    let tempCoreDirectory: string;

    beforeEach(async () => {
      tempCoreDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-ourcomponents-missing-'));
    });

    afterEach(async () => {
      await fs.rm(tempCoreDirectory, { recursive: true, force: true });
    });

    it('throws OurComponentsContextUnavailableError when README is missing', async () => {
      await expect(
        buildOurComponentsContext({
          prompt: 'review the settings page',
          coreDirectory: tempCoreDirectory,
        }),
      ).rejects.toBeInstanceOf(OurComponentsContextUnavailableError);
    });

    it('attaches code and missingPath to the unavailable error', async () => {
      try {
        await buildOurComponentsContext({
          prompt: 'review the settings page',
          coreDirectory: tempCoreDirectory,
        });
        expect.fail('expected buildOurComponentsContext to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(OurComponentsContextUnavailableError);
        const typed = error as OurComponentsContextUnavailableError;
        expect(typed.code).toBe('OUR_COMPONENTS_UNAVAILABLE');
        expect(typed.missingPath).toContain('README.md');
        expect(typed.coreDirectory).toBe(path.resolve(tempCoreDirectory));
      }
    });
  });
});
