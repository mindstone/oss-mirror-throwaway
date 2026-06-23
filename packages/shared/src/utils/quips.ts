const PROCESSING_QUIPS: readonly string[] = [
  'Surveying the territory.',
  'Consulting my inner committee.',
  'Building Rome. Give me a minute.',
  'The jury is still out. The jury is me.',
  'Cross-examining the evidence.',
  'Excavating carefully.',
  'Letting the question settle.',
  'Checking the sight lines.',
  'Dusting off the first layer.',
  'Running a quick sanity lap.',
  'Tuning the orchestra.',
  'Orienting the map to true north.',
];

let lastQuipIndex = -1;

export function getProcessingQuip(): string {
  let index: number;
  do {
    index = Math.floor(Math.random() * PROCESSING_QUIPS.length);
  } while (index === lastQuipIndex && PROCESSING_QUIPS.length > 1);
  lastQuipIndex = index;
  return PROCESSING_QUIPS[index];
}
