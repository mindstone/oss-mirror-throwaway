import { describe, it, expect } from 'vitest';
import {
  parseProfileSections,
  serialiseProfileSections,
  type ParsedProfile,
} from '../profileSections';
import {
  calculateProfileCompletion,
  calculateProfileCompletionFromSections,
} from '../profileCompletion';

// ---------------------------------------------------------------------------
// parseProfileSections
// ---------------------------------------------------------------------------

describe('parseProfileSections', () => {
  it('handles empty string', () => {
    const result = parseProfileSections('');
    expect(result.frontmatter).toBe('');
    expect(result.preamble).toBe('');
    expect(result.sections).toEqual([]);
    expect(result.hasStructuredSections).toBe(false);
  });

  it('handles whitespace-only input', () => {
    const result = parseProfileSections('   \n\n  ');
    expect(result.sections).toEqual([]);
    expect(result.hasStructuredSections).toBe(false);
  });

  it('parses frontmatter-only input', () => {
    const content = '---\ntitle: My Profile\nname: Alice\n---\n';
    const result = parseProfileSections(content);
    expect(result.frontmatter).toContain('title: My Profile');
    expect(result.frontmatter).toContain('name: Alice');
    expect(result.sections).toEqual([]);
    expect(result.hasStructuredSections).toBe(false);
  });

  it('parses content with no headings (unstructured body)', () => {
    const content = 'I am a product manager at Acme Corp.\nI like to work on strategies.';
    const result = parseProfileSections(content);
    expect(result.frontmatter).toBe('');
    expect(result.preamble).toBe(content);
    expect(result.sections).toEqual([]);
    expect(result.hasStructuredSections).toBe(false);
  });

  it('parses standard sections', () => {
    const content = [
      '## Role',
      '',
      'I am a product manager.',
      '',
      '## Goals',
      '',
      'Ship v2 this quarter.',
    ].join('\n');

    const result = parseProfileSections(content);
    expect(result.sections).toHaveLength(2);
    expect(result.sections[0]).toMatchObject({
      id: 'role',
      heading: 'Role',
      isKnown: true,
    });
    expect(result.sections[0].body).toBe('I am a product manager.');
    expect(result.sections[1]).toMatchObject({
      id: 'goals',
      heading: 'Goals',
      isKnown: true,
    });
    expect(result.sections[1].body).toBe('Ship v2 this quarter.');
    expect(result.hasStructuredSections).toBe(true);
  });

  it('handles unknown/custom sections', () => {
    const content = '## My Custom Notes\n\nSome custom content here.';
    const result = parseProfileSections(content);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]).toMatchObject({
      id: 'unknown',
      heading: 'My Custom Notes',
      isKnown: false,
    });
    expect(result.sections[0].body).toBe('Some custom content here.');
  });

  it('skips ## inside code fences', () => {
    const content = [
      '## Role',
      '',
      'Here is an example:',
      '',
      '```markdown',
      '## This is NOT a heading',
      'Just some code.',
      '```',
      '',
      'Back to role content.',
      '',
      '## Goals',
      '',
      'Ship it.',
    ].join('\n');

    const result = parseProfileSections(content);
    expect(result.sections).toHaveLength(2);
    expect(result.sections[0].id).toBe('role');
    expect(result.sections[0].body).toContain('## This is NOT a heading');
    expect(result.sections[1].id).toBe('goals');
  });

  it('handles tilde fences', () => {
    const content = [
      '## Role',
      '',
      '~~~',
      '## Fake heading in tilde fence',
      '~~~',
      '',
      'Real content.',
    ].join('\n');

    const result = parseProfileSections(content);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].body).toContain('## Fake heading in tilde fence');
  });

  it('treats # (h1) and ### (h3+) as content, not delimiters', () => {
    const content = [
      '# Top-level heading',
      '',
      '## Role',
      '',
      '### Sub-heading inside role',
      '',
      'Detail text.',
    ].join('\n');

    const result = parseProfileSections(content);
    expect(result.preamble).toBe('# Top-level heading');
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].id).toBe('role');
    expect(result.sections[0].body).toContain('### Sub-heading inside role');
    expect(result.sections[0].body).toContain('Detail text.');
  });

  it('handles duplicate headings as separate sections', () => {
    const content = [
      '## Goals',
      '',
      'First goals section.',
      '',
      '## Goals',
      '',
      'Second goals section.',
    ].join('\n');

    const result = parseProfileSections(content);
    expect(result.sections).toHaveLength(2);
    expect(result.sections[0].id).toBe('goals');
    expect(result.sections[0].body).toBe('First goals section.');
    expect(result.sections[1].id).toBe('goals');
    expect(result.sections[1].body).toBe('Second goals section.');
  });

  it('fuzzy-matches "My Goals" to goals', () => {
    const content = '## My Goals\n\nI want to grow the team.';
    const result = parseProfileSections(content);
    expect(result.sections[0].id).toBe('goals');
    expect(result.sections[0].isKnown).toBe(true);
  });

  it('fuzzy-matches "Goals & Objectives" to goals', () => {
    const content = '## Goals & Objectives\n\nShip on time.';
    const result = parseProfileSections(content);
    expect(result.sections[0].id).toBe('goals');
  });

  it('fuzzy-matches "How I Communicate" to communication', () => {
    const content = '## How I Communicate\n\nDirectly and concisely.';
    const result = parseProfileSections(content);
    expect(result.sections[0].id).toBe('communication');
  });

  it('fuzzy-matches "How I Work" to working-style', () => {
    const content = '## How I Work\n\nMornings are for deep focus.';
    const result = parseProfileSections(content);
    expect(result.sections[0].id).toBe('working-style');
  });

  it('fuzzy-matches "About Me" to role', () => {
    const content = '## About Me\n\nI lead the product team.';
    const result = parseProfileSections(content);
    expect(result.sections[0].id).toBe('role');
  });

  it('preserves preamble content before first heading', () => {
    const content = [
      'Welcome to my profile.',
      '',
      'Some intro text.',
      '',
      '## Role',
      '',
      'PM at Acme.',
    ].join('\n');

    const result = parseProfileSections(content);
    expect(result.preamble).toBe('Welcome to my profile.\n\nSome intro text.');
    expect(result.sections).toHaveLength(1);
  });

  it('preserves frontmatter and preamble together', () => {
    const content = [
      '---',
      'name: Alice',
      '---',
      '',
      'Some intro.',
      '',
      '## Goals',
      '',
      'Ship v3.',
    ].join('\n');

    const result = parseProfileSections(content);
    expect(result.frontmatter).toContain('name: Alice');
    expect(result.preamble).toBe('Some intro.');
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].id).toBe('goals');
  });
});

// ---------------------------------------------------------------------------
// serialiseProfileSections
// ---------------------------------------------------------------------------

describe('serialiseProfileSections', () => {
  it('serialises an empty profile', () => {
    const profile: ParsedProfile = {
      frontmatter: '',
      preamble: '',
      sections: [],
      hasStructuredSections: false,
    };
    const result = serialiseProfileSections(profile);
    expect(result).toBe('');
  });

  it('serialises frontmatter-only profile', () => {
    const profile: ParsedProfile = {
      frontmatter: '---\nname: Alice\n---',
      preamble: '',
      sections: [],
      hasStructuredSections: false,
    };
    const result = serialiseProfileSections(profile);
    expect(result).toBe('---\nname: Alice\n---\n');
  });

  it('serialises sections with blank line separators', () => {
    const profile: ParsedProfile = {
      frontmatter: '',
      preamble: '',
      sections: [
        { id: 'role', heading: 'Role', body: 'PM at Acme.', isKnown: true },
        { id: 'goals', heading: 'Goals', body: 'Ship v2.', isKnown: true },
      ],
      hasStructuredSections: true,
    };
    const result = serialiseProfileSections(profile);
    expect(result).toContain('## Role\n\nPM at Acme.');
    expect(result).toContain('## Goals\n\nShip v2.');
  });

  it('preserves section order', () => {
    const profile: ParsedProfile = {
      frontmatter: '',
      preamble: '',
      sections: [
        { id: 'goals', heading: 'Goals', body: 'Ship v2.', isKnown: true },
        { id: 'unknown', heading: 'My Notes', body: 'Some notes.', isKnown: false },
        { id: 'role', heading: 'Role', body: 'PM.', isKnown: true },
      ],
      hasStructuredSections: true,
    };
    const result = serialiseProfileSections(profile);
    const goalsIdx = result.indexOf('## Goals');
    const notesIdx = result.indexOf('## My Notes');
    const roleIdx = result.indexOf('## Role');
    expect(goalsIdx).toBeLessThan(notesIdx);
    expect(notesIdx).toBeLessThan(roleIdx);
  });

  it('strips trailing whitespace from lines', () => {
    const profile: ParsedProfile = {
      frontmatter: '',
      preamble: 'Hello   ',
      sections: [
        { id: 'role', heading: 'Role', body: 'PM at Acme.  ', isKnown: true },
      ],
      hasStructuredSections: true,
    };
    const result = serialiseProfileSections(profile);
    const lines = result.split('\n');
    for (const line of lines) {
      expect(line).toBe(line.trimEnd());
    }
  });
});

// ---------------------------------------------------------------------------
// Round-trip fidelity
// ---------------------------------------------------------------------------

describe('round-trip: parse → serialise → parse', () => {
  const testCases = [
    {
      name: 'standard sections',
      input: [
        '---',
        'name: Alice',
        '---',
        '',
        '## Role',
        '',
        'Product manager at Acme Corp.',
        '',
        '## Goals',
        '',
        'Ship v2 by Q2.',
        '',
        '## Communication',
        '',
        'Prefer async communication.',
      ].join('\n'),
    },
    {
      name: 'mixed known and unknown sections',
      input: [
        '## About Me',
        '',
        'I lead the product team.',
        '',
        '## Custom Section',
        '',
        'Something specific.',
        '',
        '## Goals & Objectives',
        '',
        'Ship on time.',
      ].join('\n'),
    },
    {
      name: 'code fences with fake headings',
      input: [
        '## Role',
        '',
        '```',
        '## Not a heading',
        '```',
        '',
        'Real content.',
      ].join('\n'),
    },
    {
      name: 'preamble with sections',
      input: [
        'Some preamble text.',
        '',
        '## Goals',
        '',
        'Be great.',
      ].join('\n'),
    },
  ];

  for (const { name, input } of testCases) {
    it(`round-trips: ${name}`, () => {
      const parsed1 = parseProfileSections(input);
      const serialised = serialiseProfileSections(parsed1);
      const parsed2 = parseProfileSections(serialised);

      expect(parsed2.frontmatter).toBe(parsed1.frontmatter);
      expect(parsed2.preamble).toBe(parsed1.preamble);
      expect(parsed2.sections).toHaveLength(parsed1.sections.length);

      for (let i = 0; i < parsed1.sections.length; i++) {
        expect(parsed2.sections[i].id).toBe(parsed1.sections[i].id);
        expect(parsed2.sections[i].heading).toBe(parsed1.sections[i].heading);
        expect(parsed2.sections[i].body).toBe(parsed1.sections[i].body);
        expect(parsed2.sections[i].isKnown).toBe(parsed1.sections[i].isKnown);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// calculateProfileCompletionFromSections
// ---------------------------------------------------------------------------

describe('calculateProfileCompletionFromSections', () => {
  it('scores 20 for a profile with empty sections', () => {
    const profile: ParsedProfile = {
      frontmatter: '',
      preamble: '',
      sections: [
        { id: 'role', heading: 'Role', body: '', isKnown: true },
      ],
      hasStructuredSections: true,
    };
    expect(calculateProfileCompletionFromSections(profile)).toBe(20);
  });

  it('scores 40 for one filled known section (role)', () => {
    const profile: ParsedProfile = {
      frontmatter: '',
      preamble: '',
      sections: [
        { id: 'role', heading: 'Role', body: 'A'.repeat(51), isKnown: true },
        { id: 'goals', heading: 'Goals', body: 'Short', isKnown: true },
      ],
      hasStructuredSections: true,
    };
    expect(calculateProfileCompletionFromSections(profile)).toBe(40);
  });

  it('scores 100 for all sections filled', () => {
    const profile: ParsedProfile = {
      frontmatter: '',
      preamble: '',
      sections: [
        { id: 'role', heading: 'Role', body: 'A'.repeat(51), isKnown: true },
        { id: 'goals', heading: 'Goals', body: 'B'.repeat(51), isKnown: true },
        { id: 'communication', heading: 'Communication', body: 'C'.repeat(51), isKnown: true },
        { id: 'working-style', heading: 'Working Style', body: 'D'.repeat(51), isKnown: true },
      ],
      hasStructuredSections: true,
    };
    expect(calculateProfileCompletionFromSections(profile)).toBe(100);
  });

  it('counts working-style as additional content', () => {
    const profile: ParsedProfile = {
      frontmatter: '',
      preamble: '',
      sections: [
        { id: 'working-style', heading: 'Working Style', body: 'D'.repeat(51), isKnown: true },
      ],
      hasStructuredSections: true,
    };
    expect(calculateProfileCompletionFromSections(profile)).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// calculateProfileCompletion (backward compat wrapper)
// ---------------------------------------------------------------------------

describe('calculateProfileCompletion', () => {
  it('returns 0 when file does not exist', () => {
    expect(calculateProfileCompletion(null, false)).toBe(0);
  });

  it('returns 20 when file exists but content is null', () => {
    expect(calculateProfileCompletion(null, true)).toBe(20);
  });

  it('returns 20 for empty content', () => {
    expect(calculateProfileCompletion('', true)).toBe(20);
  });

  it('detects goals via keyword in unstructured body', () => {
    const content = 'My main priority this quarter is to launch the product.';
    const score = calculateProfileCompletion(content, true);
    expect(score).toBeGreaterThanOrEqual(40);
  });

  it('detects voice via keyword in unstructured body', () => {
    const content = 'I prefer a casual tone in my writing style and communication.'.repeat(5);
    const score = calculateProfileCompletion(content, true);
    expect(score).toBeGreaterThanOrEqual(40);
  });

  it('scores structured profiles using section detection', () => {
    const content = [
      '## Role',
      '',
      'I am a product manager at a mid-size SaaS company leading a team of five designers and engineers.',
      '',
      '## Goals',
      '',
      'Ship the v2 redesign by end of Q2 and increase user retention by 15% through improved onboarding flows.',
    ].join('\n');

    const score = calculateProfileCompletion(content, true);
    expect(score).toBeGreaterThanOrEqual(60);
  });
});
