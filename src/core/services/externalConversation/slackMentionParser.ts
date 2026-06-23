export interface SlackTextElement {
  type: 'text';
  text: string;
}

export interface SlackUserElement {
  type: 'user';
  user_id: string;
}

export interface SlackUnknownElement {
  type: string;
  elements?: SlackRichTextElement[];
  text?: string;
  user_id?: string;
}

export type SlackRichTextElement =
  | SlackTextElement
  | SlackUserElement
  | SlackUnknownElement
  | SlackRichTextContainer;

export interface SlackRichTextContainer {
  type: 'rich_text' | 'rich_text_section' | 'rich_text_quote' | 'rich_text_preformatted';
  elements?: SlackRichTextElement[];
}

export type SlackBlock =
  | SlackRichTextContainer
  | {
    type: string;
    elements?: SlackRichTextElement[];
  };

const SLACK_MENTION_REGEX = /<@(U[A-Z0-9]+)(\|[^>]*)?>/g;

function stripCodeSpans(text: string): string {
  let output = '';
  let index = 0;
  while (index < text.length) {
    if (text.startsWith('```', index)) {
      const end = text.indexOf('```', index + 3);
      index = end === -1 ? text.length : end + 3;
      continue;
    }
    if (text[index] === '`') {
      const end = text.indexOf('`', index + 1);
      index = end === -1 ? text.length : end + 1;
      continue;
    }
    output += text[index];
    index += 1;
  }
  return output;
}

function collectMentionIdsFromElements(elements: readonly SlackRichTextElement[] | undefined, mentionedIds: Set<string>): void {
  for (const element of elements ?? []) {
    if (element.type === 'rich_text_preformatted') {
      continue;
    }
    const userId = element.type === 'user' ? element.user_id : undefined;
    if (typeof userId === 'string' && /^U[A-Z0-9]+$/.test(userId)) {
      mentionedIds.add(userId);
      continue;
    }
    if (
      (element.type === 'rich_text'
        || element.type === 'rich_text_section'
        || element.type === 'rich_text_quote')
      && Array.isArray(element.elements)
    ) {
      collectMentionIdsFromElements(element.elements, mentionedIds);
    }
  }
}

function collectTextFromElements(elements: readonly SlackRichTextElement[] | undefined): string {
  let result = '';
  for (const element of elements ?? []) {
    if (element.type === 'rich_text_preformatted') {
      continue;
    }
    if (element.type === 'text') {
      result += element.text;
      continue;
    }
    if (element.type === 'rich_text_section' && Array.isArray(element.elements)) {
      result += collectTextFromElements(element.elements);
    }
  }
  return result;
}

export function extractMentionedUserIds({
  text,
  blocks,
}: {
  text?: string;
  blocks?: SlackBlock[];
}): Set<string> {
  const mentionedIds = new Set<string>();
  const searchableText = text ? stripCodeSpans(text) : '';
  for (const match of searchableText.matchAll(SLACK_MENTION_REGEX)) {
    mentionedIds.add(match[1]);
  }
  for (const block of blocks ?? []) {
    if (block.type === 'rich_text_preformatted') {
      continue;
    }
    collectMentionIdsFromElements(Array.isArray(block.elements) ? block.elements : undefined, mentionedIds);
  }
  return mentionedIds;
}

export function extractMessageText({
  text,
  blocks,
}: {
  text?: string;
  blocks?: SlackBlock[];
}): string {
  if (typeof text === 'string' && text.trim().length > 0) {
    return text;
  }
  const sectionTexts: string[] = [];
  for (const block of blocks ?? []) {
    if (block.type !== 'rich_text' || !Array.isArray(block.elements)) {
      continue;
    }
    for (const element of block.elements) {
      if (element.type === 'rich_text_section') {
        const sectionText = collectTextFromElements(element.elements);
        if (sectionText.trim().length > 0) {
          sectionTexts.push(sectionText);
        }
      }
    }
  }
  return sectionTexts.join('\n');
}
