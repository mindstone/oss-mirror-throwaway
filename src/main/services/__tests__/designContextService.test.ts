import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildDesignContext,
  shouldInjectDesignContext,
  stripDesignContextCommand,
} from '../designContextService';

const CORE_DIRECTORY = path.resolve(__dirname, '../../../..');

describe('stripDesignContextCommand', () => {
  it('removes the explicit command token from the prompt', () => {
    const result = stripDesignContextCommand('@designContext improve the onboarding flow');

    expect(result.explicitRequested).toBe(true);
    expect(result.sanitizedPrompt).toBe('improve the onboarding flow');
  });

  it('leaves normal prompts unchanged', () => {
    const result = stripDesignContextCommand('review the current onboarding flow');

    expect(result.explicitRequested).toBe(false);
    expect(result.sanitizedPrompt).toBe('review the current onboarding flow');
  });
});

describe('shouldInjectDesignContext', () => {
  it('injects when explicitly requested', () => {
    expect(shouldInjectDesignContext('anything', [], true)).toBe(true);
  });

  it('injects for product and UX prompts', () => {
    expect(
      shouldInjectDesignContext('review the onboarding journey and improve the first-time experience'),
    ).toBe(true);
  });

  it('injects when a design-memory doc is attached and the prompt is design-oriented', () => {
    expect(
      shouldInjectDesignContext(
        'please improve this onboarding flow',
        [
          {
            id: '1',
            name: 'persona.md',
            path: '/tmp/persona.md',
            relativePath: 'docs/project/ux_testing/personas/04_junior_research_analyst.md',
            size: 128,
            content: '# Persona',
          },
        ],
      ),
    ).toBe(true);
  });

  it('injects when in-app visual evidence from Rebel screenshots is attached', () => {
    expect(
      shouldInjectDesignContext(
        'review this visible UI change',
        [
          {
            id: '1',
            name: '260430_144100_light_home_abc123.png',
            path: '/workspace/.rebel/screenshots/260430_144100_light_home_abc123.png',
            relativePath: '.rebel/screenshots/260430_144100_light_home_abc123.png',
            size: 256_000,
            content: '',
          },
        ],
      ),
    ).toBe(true);
  });

  it('does not inject for unrelated writing prompts', () => {
    expect(shouldInjectDesignContext('write release notes for the latest version')).toBe(false);
  });
});

describe('buildDesignContext', () => {
  it('builds a design-memory block from personas, journeys, and research', async () => {
    const context = await buildDesignContext({
      prompt: 'improve onboarding for skeptical first-time users',
      coreDirectory: CORE_DIRECTORY,
    });

    expect(context).toContain('## Design Context');
    expect(context).toContain('### Personas');
    expect(context).toContain('### User Journeys');
    expect(context).toContain('### Research');
    expect(context).toContain('docs/project/ux_testing/personas/');
    expect(context).toContain('260127_onboarding_user_journey_map.md');
  });

  it('mentions the explicit trigger when the command is used', async () => {
    const context = await buildDesignContext({
      prompt: 'review this new approval flow',
      coreDirectory: CORE_DIRECTORY,
      explicitRequested: true,
    });

    expect(context).toContain('Explicit command `@designContext` requested product/design memory.');
  });
});
