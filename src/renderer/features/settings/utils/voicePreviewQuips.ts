/**
 * Voice preview quips in Rebel's brand voice.
 * All variations on "testing the sound" with dry wit and cultural depth.
 */

export const VOICE_PREVIEW_QUIPS: readonly string[] = [
  // Dry wit
  'Testing, testing. The acoustics in here are interesting.',
  'One, two, three. Still here. Still me.',
  'Sound check. The frequency is... adequate.',
  'Voice confirmed. The resemblance to myself is uncanny.',
  
  // Self-aware
  'This is what I sound like. Take your time deciding.',
  'If you are hearing this, congratulations. Audio works.',
  'Just making sure all the frequencies are present and accounted for.',
  'A brief sample of my vocal stylings. You are welcome.',
  
  // Cultural depth
  'The acoustics are favorable. Shall we proceed?',
  'A brief audition for your consideration.',
  'Tuning the instrument before the performance.',
  'Consider this my opening statement.',
  
  // Confident humility
  'This voice is ready when you are.',
  'Vocal cords in order. Metaphorically speaking.',
  'All systems nominal. Voice included.',
  'Present and ready for duty.',
  
  // Calm reassurance
  'Just a quick hello before we get started.',
  'Everything sounds as it should. Carry on.',
  'Voice module operational. The jury remains optimistic.',
  'A measured preview for your auditory approval.',
] as const;

let previewQuipIndex = 0;

/**
 * Get the next preview quip in rotation.
 * Cycles through all quips to provide variety.
 */
export const getNextPreviewQuip = (): string => {
  const quip = VOICE_PREVIEW_QUIPS[previewQuipIndex];
  previewQuipIndex = (previewQuipIndex + 1) % VOICE_PREVIEW_QUIPS.length;
  return quip;
};
