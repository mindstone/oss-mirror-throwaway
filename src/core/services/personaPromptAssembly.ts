export interface PersonaPromptAssemblyInput {
  persona: string;
  grounding?: string | null;
  diaryEntries?: string[];
  focus?: string | null;
  callerContext?: string | null;
  voiceFraming?: string | string[] | null;
}

function normalizeBlock(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeVoiceFraming(value: PersonaPromptAssemblyInput['voiceFraming']): string | null {
  if (Array.isArray(value)) {
    return normalizeBlock(value.filter((line) => line.trim()).join('\n'));
  }
  return normalizeBlock(value);
}

export function assemblePersonaPrompt({
  persona,
  grounding,
  diaryEntries = [],
  focus,
  callerContext,
  voiceFraming,
}: PersonaPromptAssemblyInput): string {
  const blocks: string[] = [];
  const callerContextBlock = normalizeBlock(callerContext);
  const personaBlock = normalizeBlock(persona);
  const voiceFramingBlock = normalizeVoiceFraming(voiceFraming);
  const groundingBlock = normalizeBlock(grounding);
  const focusBlock = normalizeBlock(focus);
  const diaryBlock = diaryEntries
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => `- ${entry}`)
    .join('\n');

  if (callerContextBlock) blocks.push(callerContextBlock);
  if (personaBlock && voiceFramingBlock) {
    blocks.push([personaBlock, voiceFramingBlock].join('\n'));
  } else if (personaBlock) {
    blocks.push(personaBlock);
  } else if (voiceFramingBlock) {
    blocks.push(voiceFramingBlock);
  }
  if (groundingBlock) {
    blocks.push(['<operator_grounding>', groundingBlock, '</operator_grounding>'].join('\n'));
  }
  if (diaryBlock) {
    blocks.push(['<operator_diary>', diaryBlock, '</operator_diary>'].join('\n'));
  }
  if (focusBlock) {
    blocks.push(['<operator_focus>', focusBlock, '</operator_focus>'].join('\n'));
  }

  return blocks.join('\n\n');
}
