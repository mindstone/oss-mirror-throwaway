import type { Permission } from '../api/types';

// ── Types ───────────────────────────────────────────────────────────────

export type SecuritySeverity = 'info' | 'warn' | 'block';

export interface SecurityFinding {
  severity: SecuritySeverity;
  message: string;
  pattern: string;
}

export interface PluginSecurityReport {
  passed: boolean;
  maxSeverity: SecuritySeverity;
  findings: SecurityFinding[];
  summary: string[];
  warnings: string[];   // kept for backwards compat
  apiUsage: string[];
}

export interface ReviewPluginSecurityOptions {
  permissions?: Permission[];
}

// ── Internal Types ──────────────────────────────────────────────────────

interface SuspiciousPattern {
  usage: string;
  regex: RegExp;
  warning: string;
  /** Base severity when no permission applies */
  severity: SecuritySeverity;
}

const REACT_HOOK_NAMES = [
  'useState',
  'useEffect',
  'useMemo',
  'useCallback',
  'useRef',
  'useReducer',
  'useContext',
  'useLayoutEffect',
  'useImperativeHandle',
  'useTransition',
  'useDeferredValue',
  'useId',
] as const;

const PLUGIN_HOOK_NAMES = [
  'usePluginStorage',
  'useMemorySearch',
  'useConversations',
  'useRebel',
  'useSources',
  'useSourceDocument',
  'useAi',
  'useMeetings',
  'useClipboard',
  'useRebelEvent',
  'usePreTurnHook',
  'usePostTurnHook',
  'useExternalFetch',
  'usePluginRoute',
  'useTopics',
  'useTopicContent',
  'useEntities',
  'useSkillFile',
  'useGoals',
  'useActiveSession',
  'useConversation',
] as const;

const NETWORK_PATTERNS: SuspiciousPattern[] = [
  {
    usage: 'fetch()',
    regex: /\bfetch\s*\(/,
    warning: 'Network access detected: raw fetch() bypasses mediated path.',
    severity: 'block',
  },
  {
    usage: 'XMLHttpRequest',
    regex: /\bXMLHttpRequest\b/,
    warning: 'Network access detected: XMLHttpRequest bypasses mediated path.',
    severity: 'block',
  },
  {
    usage: 'WebSocket',
    regex: /\bWebSocket\b/,
    warning: 'Network access detected: WebSocket bypasses mediated path.',
    severity: 'block',
  },
  {
    usage: 'EventSource',
    regex: /\bEventSource\b/,
    warning: 'Network access detected: EventSource bypasses mediated path.',
    severity: 'block',
  },
  {
    usage: 'navigator.sendBeacon()',
    regex: /\bnavigator\s*(?:\.|\?\.)\s*sendBeacon\s*\(/,
    warning: 'Network exfiltration API detected: navigator.sendBeacon() bypasses mediated path.',
    severity: 'block',
  },
  {
    usage: 'dynamic import()',
    regex: /\bimport\s*\(/,
    warning: 'Dynamic import() detected (can load external code).',
    severity: 'warn',
  },
];

const DOM_PATTERNS: SuspiciousPattern[] = [
  {
    usage: 'document.querySelector()',
    regex: /\bdocument\s*\.\s*querySelector(?:All)?\s*\(/,
    warning: 'Direct DOM querying detected via document.querySelector().',
    severity: 'warn',
  },
  {
    usage: 'document.getElementById()',
    regex: /\bdocument\s*\.\s*getElementById\s*\(/,
    warning: 'Direct DOM lookup detected via document.getElementById().',
    severity: 'warn',
  },
  {
    usage: 'document.createElement()',
    regex: /\bdocument\s*\.\s*createElement\s*\(/,
    warning: 'Direct DOM creation detected via document.createElement().',
    severity: 'warn',
  },
  {
    usage: 'innerHTML',
    regex: /\binnerHTML\b/,
    warning: 'innerHTML usage detected (XSS risk).',
    severity: 'warn',
  },
  {
    usage: 'document.cookie',
    regex: /\bdocument\s*(?:\.|\?\.)\s*cookie\b/,
    warning: 'document.cookie access detected.',
    severity: 'warn',
  },
  {
    usage: 'localStorage',
    regex: /\blocalStorage\b/,
    warning: 'localStorage access detected — use usePluginStorage instead.',
    severity: 'warn',
  },
  {
    usage: 'sessionStorage',
    regex: /\bsessionStorage\b/,
    warning: 'sessionStorage access detected — use usePluginStorage instead.',
    severity: 'warn',
  },
];

const DYNAMIC_EXECUTION_PATTERNS: SuspiciousPattern[] = [
  {
    usage: 'eval()',
    regex: /\beval\s*\(/,
    warning: 'Dynamic code execution detected: eval().',
    severity: 'block',
  },
  {
    usage: 'Function()',
    regex: /\bFunction\s*\(/,
    warning: 'Dynamic code execution detected: Function().',
    severity: 'block',
  },
  {
    usage: "setTimeout('...')",
    regex: /\bsetTimeout\s*\(\s*['"`]/,
    warning: 'setTimeout called with a string argument (dynamic execution).',
    severity: 'block',
  },
  {
    usage: "setInterval('...')",
    regex: /\bsetInterval\s*\(\s*['"`]/,
    warning: 'setInterval called with a string argument (dynamic execution).',
    severity: 'block',
  },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function detectHookUsage(source: string, hooks: readonly string[]): string[] {
  return hooks.filter((hookName) => {
    const pattern = new RegExp(`\\b${escapeRegExp(hookName)}\\s*\\(`);
    return pattern.test(source);
  });
}

interface PatternMatch {
  usage: string;
  warning: string;
  severity: SecuritySeverity;
}

function detectSuspiciousPatterns(
  source: string,
  patterns: readonly SuspiciousPattern[],
): PatternMatch[] {
  const matches: PatternMatch[] = [];

  for (const pattern of patterns) {
    if (!pattern.regex.test(source)) {
      continue;
    }

    matches.push({
      usage: pattern.usage,
      warning: pattern.warning,
      severity: pattern.severity,
    });
  }

  return matches;
}

function formatHookList(hooks: string[]): string {
  return hooks.map((hook) => `${hook}()`).join(', ');
}

// ── Severity helpers ────────────────────────────────────────────────────

const SEVERITY_ORDER: Record<SecuritySeverity, number> = { info: 0, warn: 1, block: 2 };

function maxSeverityOf(a: SecuritySeverity, b: SecuritySeverity): SecuritySeverity {
  return SEVERITY_ORDER[a] >= SEVERITY_ORDER[b] ? a : b;
}

/**
 * Check if the source references the mediated external fetch API
 * (useExternalFetch hook or rebel.fetch imperative call).
 */
function usesMediatedFetch(source: string): boolean {
  return /\buseExternalFetch\s*[(<]/.test(source) || /\brebel\s*\.\s*fetch\s*\(/.test(source);
}

// ── Main review function ────────────────────────────────────────────────

export function reviewPluginSecurity(
  source: string,
  options?: ReviewPluginSecurityOptions,
): PluginSecurityReport {
  const permissions = options?.permissions ?? [];
  const hasExternalFetchPermission = permissions.includes('external-fetch');

  const reactHooks = detectHookUsage(source, REACT_HOOK_NAMES);
  const pluginHooks = detectHookUsage(source, PLUGIN_HOOK_NAMES);
  const networkMatches = detectSuspiciousPatterns(source, NETWORK_PATTERNS);
  const domMatches = detectSuspiciousPatterns(source, DOM_PATTERNS);
  const dynamicExecMatches = detectSuspiciousPatterns(source, DYNAMIC_EXECUTION_PATTERNS);

  const findings: SecurityFinding[] = [];
  let computedMaxSeverity: SecuritySeverity = 'info';

  // React hooks → info
  for (const hook of reactHooks) {
    findings.push({
      severity: 'info',
      message: `React hook detected: ${hook}().`,
      pattern: hook,
    });
  }

  // Plugin hooks → info
  for (const hook of pluginHooks) {
    findings.push({
      severity: 'info',
      message: `Plugin hook detected: ${hook}().`,
      pattern: hook,
    });
  }

  // Network patterns — permission-aware for mediated fetch references only
  for (const match of networkMatches) {
    // raw fetch() can be downgraded ONLY if:
    // 1. The plugin also references useExternalFetch/rebel.fetch (mediated path)
    // 2. The plugin declares external-fetch permission
    // This handles the common case where the regex matches `useExternalFetch` internally calling fetch.
    // Raw fetch/XMLHttpRequest/WebSocket always block regardless of permissions.
    const isMediatedFetchReference =
      match.usage === 'fetch()' && hasExternalFetchPermission && usesMediatedFetch(source);

    const severity: SecuritySeverity = isMediatedFetchReference ? 'info' : match.severity;
    findings.push({
      severity,
      message: match.warning,
      pattern: match.usage,
    });
    computedMaxSeverity = maxSeverityOf(computedMaxSeverity, severity);
  }

  // DOM patterns → always warn
  for (const match of domMatches) {
    findings.push({
      severity: match.severity,
      message: match.warning,
      pattern: match.usage,
    });
    computedMaxSeverity = maxSeverityOf(computedMaxSeverity, match.severity);
  }

  // Dynamic execution → always block
  for (const match of dynamicExecMatches) {
    findings.push({
      severity: match.severity,
      message: match.warning,
      pattern: match.usage,
    });
    computedMaxSeverity = maxSeverityOf(computedMaxSeverity, match.severity);
  }

  // ── Build backwards-compat arrays ─────────────────────────────────────

  const warnings = findings
    .filter((f) => f.severity === 'warn' || f.severity === 'block')
    .map((f) => f.message);

  const apiUsage: string[] = [
    ...reactHooks.map((hook) => `React hook: ${hook}()`),
    ...pluginHooks.map((hook) => `Plugin hook: ${hook}()`),
    ...networkMatches.map((m) => `Network API: ${m.usage}`),
    ...domMatches.map((m) => `DOM API: ${m.usage}`),
    ...dynamicExecMatches.map((m) => `Dynamic execution: ${m.usage}`),
  ];

  const summary: string[] = [];

  if (reactHooks.length > 0) {
    summary.push(`React hooks detected: ${formatHookList(reactHooks)}.`);
  }

  if (pluginHooks.length > 0) {
    summary.push(`Plugin hooks detected: ${formatHookList(pluginHooks)}.`);
  }

  if (networkMatches.length > 0) {
    summary.push(`Network-related APIs detected: ${networkMatches.map((m) => m.usage).join(', ')}.`);
  }

  if (domMatches.length > 0) {
    summary.push(`DOM-related APIs detected: ${domMatches.map((m) => m.usage).join(', ')}.`);
  }

  if (dynamicExecMatches.length > 0) {
    summary.push(`Dynamic execution patterns detected: ${dynamicExecMatches.map((m) => m.usage).join(', ')}.`);
  }

  if (summary.length === 0) {
    summary.push('No notable API usage detected by static review.');
  }

  if (warnings.length === 0) {
    summary.push('No suspicious patterns detected by static review.');
  } else {
    summary.push(`${warnings.length} warning${warnings.length === 1 ? '' : 's'} detected.`);
  }

  return {
    passed: computedMaxSeverity !== 'block',
    maxSeverity: computedMaxSeverity,
    findings,
    summary,
    warnings,
    apiUsage,
  };
}
