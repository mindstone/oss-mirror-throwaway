// mobile/src/utils/rebelGreeting.ts
//
// Personality-forward, time-of-day-aware greetings for the Rebel mobile
// home screen. Stays mobile-local (not in packages/shared) because the
// copy is tuned to the mobile surface and Rebel's dry brand voice.

const MORNING = [
  "Morning. Let's make today count.",
  'Rise and conquer.',
  'Good morning. Your attention is requested.',
];
const AFTERNOON = [
  'Afternoon. Still standing.',
  'Back at it.',
  'Afternoon. Still impressive.',
];
const EVENING = [
  'Evening shift. Respect.',
  'Still here. Dedication recognized.',
  'Burning the midnight oil. Noted.',
];
const GENERIC = [
  'Ready when you are.',
  'At your service. Reluctantly.',
  "What's on your mind?",
];

function pick(arr: string[]): string {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function getRebelGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return pick(MORNING);
  if (hour < 17) return pick(AFTERNOON);
  if (hour < 21) return pick(EVENING);
  return pick(GENERIC);
}
