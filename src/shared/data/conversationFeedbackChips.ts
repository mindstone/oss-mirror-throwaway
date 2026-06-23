export const PER_SESSION_VOTE_CAP = 20;

export const POSITIVE_CHIPS = [
  'Saved me time',
  'Got it right',
  'Covered what mattered',
  'Used the right sources',
  'Followed my instructions',
  'Tone was right',
  'Found what I missed',
  'Did the work, not just the thinking',
] as const;

export const NEUTRAL_CHIPS = [
  'Partly right',
  'Needed more detail',
  'Too much detail',
  'Tone felt off',
  'Sources needed work',
  'Needed better follow-through',
  'I had to steer too much',
] as const;

export const NEGATIVE_CHIPS = [
  'Got facts wrong',
  'Made things up',
  'Missed what I asked for',
  "Didn't follow instructions",
  "Didn't use my sources",
  'Wrong tone',
  'Too long',
  'Too short',
  'Asked too many questions',
  "Didn't finish the job",
] as const;

export type ConversationFeedbackChipLabel =
  (typeof POSITIVE_CHIPS | typeof NEUTRAL_CHIPS | typeof NEGATIVE_CHIPS)[number];

export function chipsForRating(rating: 1 | 2 | 3 | 4 | 5): readonly string[] {
  if (rating >= 4) return POSITIVE_CHIPS;
  if (rating === 3) return NEUTRAL_CHIPS;
  return NEGATIVE_CHIPS;
}

export function slugifyChip(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}
