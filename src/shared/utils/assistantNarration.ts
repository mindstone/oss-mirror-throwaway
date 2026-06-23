const MARKDOWN_HEADER_RE = /^#{1,6}\s+\S/m;
const CODE_BLOCK_RE = /```/;
const BULLET_LIST_RE = /^\s*[-*]\s+\S/m;
const NUMBERED_LIST_RE = /^\s*\d+\.\s+\S/m;

/**
 * Matches standalone `<invoke name="...">...</invoke>` blocks that the model
 * sometimes emits as plain text instead of structured tool_use content blocks.
 * Only matches outside markdown code fences to avoid false positives when the
 * model is explaining XML in a code block.
 *
 * See: rebel://conversation/378ced04-1346-4282-b07b-f58b62d99b92
 */
const INVOKE_XML_RE = /<invoke\s+name="[^"]*">\s*(?:<parameter\s+name="[^"]*">[^<]*<\/parameter>\s*)*<\/invoke>/g;

/**
 * Strip leaked `<invoke>` XML tool invocations from assistant text.
 *
 * The model occasionally emits raw XML tool calls as text content instead of
 * structured tool_use blocks. This strips them to prevent XML noise from
 * reaching the user-visible conversation. Only strips outside markdown code
 * fences to avoid false positives with legitimate XML explanations.
 */
export const stripLeakedInvokeXml = (text: string): string => {
  if (!text.includes('<invoke')) return text;

  // Split on code fences, only strip from non-code sections
  const parts = text.split(/(```[\s\S]*?```)/);
  let changed = false;
  const cleaned = parts.map((part, i) => {
    // Odd-indexed parts are inside code fences — leave them alone
    if (i % 2 === 1) return part;
    const stripped = part.replace(INVOKE_XML_RE, '');
    if (stripped !== part) changed = true;
    return stripped;
  }).join('');

  if (!changed) return text;

  // Collapse runs of blank lines left behind by stripping
  return cleaned.replace(/\n{3,}/g, '\n\n').trim();
};

const LONG_NARRATION_PATTERNS = [
  /^(?:that error is from|good[.,!\s]|excellent\b|now i\b|let me\b|i(?:'|\u2019)ll\b|i will\b|brilliant\b|you(?:'|\u2019)re right\b|i love this\b|good pushback\b|good instinct\b)/i,
  /\b(?:let me|now i(?:\s+\w+){0,3}|i(?:'|\u2019)ll|i will|i can proceed|i now have|i have what i need|pick up from where|use this time to|while .* still running|still running\b|handle .* gracefully|synthesi[sz]e the evidence|read the dependency skill files|clean data\.|approved!\s|good pushback|good instinct)\b/i,
];

const hasStructure = (text: string): boolean => (
  MARKDOWN_HEADER_RE.test(text)
  || CODE_BLOCK_RE.test(text)
  || BULLET_LIST_RE.test(text)
  || NUMBERED_LIST_RE.test(text)
);

/**
 * Detects assistant process narration that should not be surfaced as live
 * "Behind the scenes" prose. This preserves the existing short-chatter pruning
 * behaviour while also catching longer first-person/internal-progress text.
 */
export const isAssistantProcessNarration = (text: string): boolean => {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }

  if (hasStructure(trimmed)) {
    return false;
  }

  // Preserve existing behaviour: short, unstructured pre-tool chatter is narration.
  if (trimmed.length < 300) {
    return true;
  }

  return LONG_NARRATION_PATTERNS.some((pattern) => pattern.test(trimmed));
};

export const getAssistantStepDisplayText = (
  text: string,
  options?: {
    toolLabels?: string[];
    fileSummary?: string | null;
    allowGenericFallback?: boolean;
  }
): string => {
  if (text.trim().length > 0 && !isAssistantProcessNarration(text)) {
    return text;
  }

  const toolLabels = options?.toolLabels
    ?.map((label) => label.trim())
    .filter((label) => label.length > 0) ?? [];

  if (toolLabels.length > 0) {
    return toolLabels.slice(0, 2).join(' · ');
  }

  const fileSummary = options?.fileSummary?.trim();
  if (fileSummary) {
    return fileSummary;
  }

  if (!options?.allowGenericFallback) {
    return text;
  }

  return 'Working...';
};
