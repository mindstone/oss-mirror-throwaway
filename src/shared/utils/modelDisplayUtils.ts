/** Short display name for a model ID — strips provider prefix and common suffixes. */
export const shortModelName = (modelId: string): string => {
  let name = modelId;
  const slashIdx = name.indexOf('/');
  if (slashIdx >= 0) name = name.slice(slashIdx + 1);

  return name
    .replace(/^gpt-/i, 'GPT-')
    .replace(/^claude-/i, 'Claude ')
    .replace(/^gemini-/i, 'Gemini ')
    .replace(/^grok-/i, 'Grok ')
    .replace(/^o(\d)/i, 'o$1');
};
