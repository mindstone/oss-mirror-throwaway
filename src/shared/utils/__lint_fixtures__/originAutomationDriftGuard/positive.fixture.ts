const entry = { origin: 'automation' };
const summary = { origin: 'manual' };
const origin = String('automation');
const currentSessionOrigin = String('manual');

if (entry.origin === 'automation') {
  const blockedEquality = true;
  void blockedEquality;
}

if (summary.origin !== 'automation') {
  const blockedInequality = true;
  void blockedInequality;
}

if (origin === 'automation') {
  const blockedBareOrigin = true;
  void blockedBareOrigin;
}

if (currentSessionOrigin !== 'automation') {
  const blockedCurrentSessionOrigin = true;
  void blockedCurrentSessionOrigin;
}

export {};
