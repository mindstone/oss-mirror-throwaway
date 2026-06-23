import { describe, expect, it } from 'vitest';
import {
  formatSkillAuthorLine,
  formatSkillLastModifiedLine,
  getSharedSkillWarningCopy,
} from './skillAttribution';

const currentUser = {
  id: 'user-123',
  name: 'Anna Maria',
  email: 'anna@example.com',
  image: null,
};

describe('skillAttribution', () => {
  it('renders "by You" for the current user', () => {
    expect(
      formatSkillAuthorLine(
        {
          author: 'Anna Maria',
          author_id: 'user-123',
          author_email: 'anna@example.com',
        },
        currentUser,
      ),
    ).toBe('by You');
  });

  it('does not treat matching email as "You" when the stable id differs', () => {
    expect(
      formatSkillAuthorLine(
        {
          author: 'Anna Maria',
          author_id: 'different-user',
          author_email: 'anna@example.com',
        },
        currentUser,
      ),
    ).toBe('by Anna Maria');
  });

  it('renders "by You" for the current user even without explicit author_source', () => {
    expect(
      formatSkillAuthorLine(
        {
          author: 'Anna Maria',
          author_id: 'user-123',
          author_email: 'anna@example.com',
        },
        currentUser,
      ),
    ).toBe('by You');
  });

  it('returns null when no author metadata exists at all', () => {
    expect(formatSkillAuthorLine({}, currentUser)).toBeNull();
    expect(formatSkillAuthorLine(undefined, currentUser)).toBeNull();
  });

  it('does not treat matching email as "You" when the stable id is missing', () => {
    expect(
      formatSkillAuthorLine(
        {
          author: 'Anna Maria',
          author_email: 'anna@example.com',
        },
        currentUser,
      ),
    ).toBe('by Anna Maria');
  });

  it('formats date-only last_modified_at values without shifting the calendar day', () => {
    const expectedDate = new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(new Date(2026, 2, 25));

    expect(
      formatSkillLastModifiedLine(
        {
          last_modified_at: '2026-03-25',
          last_modified_by: 'Rebel',
          last_modified_by_id: 'rebel',
          last_modified_context: "from Anna Maria's input",
        },
        currentUser,
      ),
    ).toBe(`Last modified ${expectedDate} by Rebel, prompted by Anna Maria`);
  });

  it('uses non-shared wording in the editor warning copy', () => {
    expect(
      getSharedSkillWarningCopy(
        {
          author: 'Ioannis',
          author_id: 'user-999',
          author_email: 'ioannis@example.com',
        },
        currentUser,
      ),
    ).toContain('This skill was created by Ioannis.');
  });
});
