const kind = 'automation';
const source = { kind: 'automation' };
const sessionType = 'automation';

if (kind === 'automation') {
  const kindAllowed = true;
  void kindAllowed;
}

if (source.kind === 'automation') {
  const sourceKindAllowed = true;
  void sourceKindAllowed;
}

if (sessionType === 'automation') {
  const sessionTypeAllowed = true;
  void sessionTypeAllowed;
}

export {};
