import type { AuthUser } from '@shared/ipc/schemas/auth';
import type { SkillFrontmatter } from '../hooks/useSkillsIndex';

type SkillPersonFields = {
  name?: string;
  id?: string;
  email?: string;
};


const LONG_DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

const SHORT_DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
});

function normalizeEmail(email?: string): string | null {
  const trimmed = email?.trim().toLowerCase();
  return trimmed || null;
}

function isCurrentUser(person: SkillPersonFields, currentUser: AuthUser | null): boolean {
  if (!currentUser) {
    return false;
  }

  return Boolean(person.id && currentUser.id === person.id);
}

function getDisplayName(name?: string): string | null {
  const trimmed = name?.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.toLowerCase() === 'rebel') {
    return 'Rebel';
  }

  return trimmed;
}

function getEmailFallback(email?: string): string | null {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    return null;
  }
  return normalized.split('@')[0] ?? normalized;
}

function normalizeContext(context?: string): string | null {
  const trimmed = context?.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.replace(/^\((.*)\)$/, '$1').trim() || null;
}

function formatLastModifiedContext(context: string | null, actorLabel: string | null): string {
  if (!context) {
    return '';
  }

  if (actorLabel === 'Rebel') {
    const promptedByMatch = context.match(/^from (.+?)'s input$/i);
    if (promptedByMatch?.[1]) {
      return `, prompted by ${promptedByMatch[1]}`;
    }

    if (/^prompted by /i.test(context)) {
      return `, ${context}`;
    }
  }

  return ` (${context})`;
}

function formatDate(rawDate?: string, compact = false): string | null {
  if (!rawDate) {
    return null;
  }

  const dateOnlyMatch = rawDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const parsedDate = dateOnlyMatch
    ? new Date(Number(dateOnlyMatch[1]), Number(dateOnlyMatch[2]) - 1, Number(dateOnlyMatch[3]))
    : new Date(rawDate);
  if (Number.isNaN(parsedDate.getTime())) {
    return rawDate;
  }

  return (compact ? SHORT_DATE_FORMAT : LONG_DATE_FORMAT).format(parsedDate);
}

export function getSkillActorLabel(person: SkillPersonFields, currentUser: AuthUser | null): string | null {
  if (person.id === 'rebel' || person.name?.trim().toLowerCase() === 'rebel') {
    return 'Rebel';
  }

  if (isCurrentUser(person, currentUser)) {
    return 'You';
  }

  return getDisplayName(person.name) ?? getEmailFallback(person.email);
}


export function formatSkillAuthorLine(
  frontmatter: Pick<SkillFrontmatter, 'author' | 'author_id' | 'author_email'> | undefined,
  currentUser: AuthUser | null,
): string | null {
  const authorLabel = getSkillActorLabel(
    {
      name: frontmatter?.author,
      id: frontmatter?.author_id,
      email: frontmatter?.author_email,
    },
    currentUser,
  );

  return authorLabel ? `by ${authorLabel}` : null;
}

export function formatSkillLastModifiedLine(
  frontmatter:
    | Pick<
        SkillFrontmatter,
        | 'last_modified_by'
        | 'last_modified_by_id'
        | 'last_modified_by_email'
        | 'last_modified_at'
        | 'last_modified_context'
      >
    | undefined,
  currentUser: AuthUser | null,
  options?: { compactDate?: boolean },
): string | null {
  const formattedDate = formatDate(frontmatter?.last_modified_at, options?.compactDate);
  const actorLabel = getSkillActorLabel(
    {
      name: frontmatter?.last_modified_by,
      id: frontmatter?.last_modified_by_id,
      email: frontmatter?.last_modified_by_email,
    },
    currentUser,
  );
  const contextSuffix = normalizeContext(frontmatter?.last_modified_context);

  if (!formattedDate && !actorLabel) {
    return null;
  }

  let result = formattedDate ? `Last modified ${formattedDate}` : 'Last modified';

  if (actorLabel) {
    result += ` by ${actorLabel}`;
  }

  result += formatLastModifiedContext(contextSuffix, actorLabel);

  return result;
}

export function getSharedSkillWarningCopy(
  frontmatter: Pick<SkillFrontmatter, 'author' | 'author_id' | 'author_email'> | undefined,
  currentUser: AuthUser | null,
): string {
  const authorLine = formatSkillAuthorLine(frontmatter, currentUser);

  if (authorLine === 'by You') {
    return 'You created this skill. Improve with Rebel if you want help making a clean update for your team.';
  }

  if (authorLine) {
    return `This skill was created ${authorLine}. Improve with Rebel if you want help making a clean update for your team.`;
  }

  return 'Improve with Rebel if you want help making a clean update for your team.';
}

export interface SharedSkillDirectEditGuard {
  authorLabel: string;
  copy: string;
}

export function getSharedSkillDirectEditGuard(
  frontmatter: Pick<SkillFrontmatter, 'author' | 'author_id' | 'author_email'> | undefined,
  currentUser: AuthUser | null,
): SharedSkillDirectEditGuard | null {
  const authorLabel = getSkillActorLabel(
    {
      name: frontmatter?.author,
      id: frontmatter?.author_id,
      email: frontmatter?.author_email,
    },
    currentUser,
  );

  if (!authorLabel || authorLabel === 'You') {
    return null;
  }

  return {
    authorLabel,
    copy: `This shared skill was created by ${authorLabel}. Before saving direct edits to the shared version, confirm that you want to update it yourself. Autosave waits until you confirm.`,
  };
}
