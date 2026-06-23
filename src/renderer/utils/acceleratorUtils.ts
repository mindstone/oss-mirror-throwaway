const MAC_PLATFORM_REGEX = /mac|darwin|iphone|ipad|ipod/i;

const isMacPlatform = (): boolean => {
  if (typeof navigator === 'undefined') {
    return false;
  }
  const platform = (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? '';
  return MAC_PLATFORM_REGEX.test(platform.toLowerCase());
};

const MODIFIER_DISPLAY = {
  command: '⌘',
  cmd: '⌘',
  commandorcontrol: isMacPlatform() ? '⌘' : 'Ctrl',
  ctrl: isMacPlatform() ? '⌃' : 'Ctrl',
  control: isMacPlatform() ? '⌃' : 'Ctrl',
  alt: isMacPlatform() ? '⌥' : 'Alt',
  option: isMacPlatform() ? '⌥' : 'Alt',
  shift: isMacPlatform() ? '⇧' : 'Shift',
  super: isMacPlatform() ? '⌘' : 'Win'
} as const;

const MODIFIER_ORDER = ['Command', 'Ctrl', 'Alt', 'Shift'] as const;

const SPECIAL_KEYS: Record<string, string> = {
  ' ': 'Space',
  Spacebar: 'Space',
  Escape: 'Esc',
  Esc: 'Esc',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Enter: 'Enter',
  Return: 'Enter',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Tab: 'Tab',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Insert: 'Insert',
  '+': 'Plus',
  '=': 'Equal',
  '-': 'Minus',
  '_': 'Minus'
};

const normalizeBaseKey = (event: KeyboardEvent): string | null => {
  const key = event.key;
  if (SPECIAL_KEYS[key]) {
    return SPECIAL_KEYS[key];
  }

  if (/^F\d{1,2}$/i.test(key)) {
    return key.toUpperCase();
  }

  if (key.length === 1) {
    if (/^[a-z0-9]$/i.test(key)) {
      return key.toUpperCase();
    }
  }

  const digitMatch = event.code?.match(/^Digit(\d)$/);
  if (digitMatch) {
    return digitMatch[1];
  }

  const keyMatch = event.code?.match(/^Key([A-Z])$/i);
  if (keyMatch) {
    return keyMatch[1].toUpperCase();
  }

  return null;
};

const buildModifierList = (event: KeyboardEvent): string[] => {
  const modifiers: string[] = [];
  if (event.metaKey) {
    modifiers.push('Command');
  }
  if (event.ctrlKey) {
    modifiers.push('Ctrl');
  }
  if (event.altKey) {
    modifiers.push('Alt');
  }
  if (event.shiftKey) {
    modifiers.push('Shift');
  }
  return modifiers;
};

export const acceleratorFromEvent = (event: KeyboardEvent): string | null => {
  const modifiers = buildModifierList(event);
  const baseKey = normalizeBaseKey(event);
  if (!baseKey) {
    return null;
  }
  if (modifiers.length === 0) {
    return null;
  }
  const orderedModifiers = MODIFIER_ORDER.filter((modifier) => modifiers.includes(modifier));
  const extraModifiers = modifiers.filter((modifier) => !(MODIFIER_ORDER as readonly string[]).includes(modifier));
  return [...orderedModifiers, ...extraModifiers, baseKey].join('+');
};

const modifierSet = new Set([
  'command',
  'cmd',
  'commandorcontrol',
  'ctrl',
  'control',
  'alt',
  'option',
  'shift',
  'super'
]);

const normalizeSegment = (segment: string): string => segment.trim();

export const formatAcceleratorDisplay = (accelerator?: string | null): string => {
  if (!accelerator) {
    return '';
  }
  const parts = accelerator
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return '';
  }

  const isMac = isMacPlatform();
  const displayParts = parts.map((part) => {
    const normalized = normalizeSegment(part).toLowerCase();
    if (modifierSet.has(normalized)) {
      const symbol = (MODIFIER_DISPLAY as Record<string, string>)[normalized];
      if (normalized === 'commandorcontrol') {
        return symbol;
      }
      return symbol ?? part;
    }
    return part === 'Space' && isMac ? 'Space' : part;
  });

  if (isMac) {
    return displayParts.join(' ');
  }
  return displayParts.join(' + ');
};


