import { z } from 'zod';

export const EvidenceCardSchema = z.object({
  sourceId: z.string(),
  sourceType: z.enum(['email', 'document', 'memory', 'slack', 'web', 'file', 'conversation']),
  relevanceScore: z.number().min(0).max(1),
  quote: z.string(),
  context: z.string(),
  metadata: z.object({
    date: z.string(),
    author: z.string(),
    subject: z.string(),
    sourceTool: z.string(),
  }).partial().optional(),
});

export const ForagerResultSchema = z.object({
  cards: z.array(EvidenceCardSchema),
  sourcesScanned: z.number().int().nonnegative(),
  searchTermsUsed: z.array(z.string()),
});

export type EvidenceCard = z.infer<typeof EvidenceCardSchema>;
export type ForagerResult = z.infer<typeof ForagerResultSchema>;

export type ForagerParseResult =
  | { success: true; data: ForagerResult }
  | { success: false; error: string };

const extractJsonFromText = (text: string): string => {
  const trimmed = text.trim();
  // Try anchored fence first (entire response is a code block)
  const anchoredMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (anchoredMatch) return anchoredMatch[1].trim();
  // Try finding a fenced block within surrounding prose
  const embeddedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (embeddedMatch) return embeddedMatch[1].trim();
  return trimmed;
};

const formatZodError = (error: z.ZodError): string => error.issues
  .map((issue) => {
    const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    return `${path}${issue.message}`;
  })
  .join('; ');

export const parseForagerResult = (text: string): ForagerParseResult => {
  const stripped = extractJsonFromText(text);

  try {
    const parsedJson = JSON.parse(stripped) as unknown;
    const parsed = ForagerResultSchema.safeParse(parsedJson);

    if (!parsed.success) {
      return { success: false, error: formatZodError(parsed.error) };
    }

    return { success: true, data: parsed.data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};
