/**
 * Sentry-issue noise patterns mirrored from `docs/project/SENTRY_TRIAGE.md`
 * § Project-Specific Noise Categories.
 *
 * Issues whose title matches one of these substrings are treated as triage-skip
 * candidates by the autopilot poller and auto-archived with substatus
 * `archived_until_escalating` — the same outcome a human would apply via the
 * Sentry UI's "Archive > Until Escalating" button. If a noise issue starts
 * spiking it re-surfaces on the next escalation, so this is reversible.
 *
 * Patterns are intentionally specific function/error strings (not broad
 * regex) so a real bug whose title incidentally contains a noisy substring
 * is not over-archived. When SENTRY_TRIAGE.md grows new noise categories,
 * mirror them here and add a corresponding test case.
 */

export type NoiseCategory =
  | 'chromium_native'
  | 'macos_system'
  | 'user_environment'
  | 'network_failure'
  | 'squirrel_updater';

interface NoiseRule {
  category: NoiseCategory;
  patterns: readonly string[];
}

const NOISE_RULES: readonly NoiseRule[] = [
  {
    category: 'chromium_native',
    patterns: [
      'partition_alloc::internal::OnNoMemoryInternal',
      '__pthread_kill',
      'logging::LogMessage::HandleFatal',
    ],
  },
  {
    category: 'macos_system',
    patterns: [
      '-[NSApplication _crashOnException:]',
      '-[AVCaptureDALDevice',
    ],
  },
  {
    category: 'user_environment',
    patterns: ['ENOSPC', 'EACCES'],
  },
  {
    category: 'network_failure',
    patterns: ['ENOTFOUND', 'ENETUNREACH', 'ETIMEDOUT'],
  },
  {
    category: 'squirrel_updater',
    patterns: ['Command failed: 4294967295'],
  },
];

export type NoiseMatch = { match: true; category: NoiseCategory } | { match: false };

/**
 * Returns the noise category when `title` contains one of the documented
 * patterns, otherwise `{ match: false }`. Case-sensitive — Sentry titles
 * preserve original casing for symbol names and errno strings.
 */
export function matchesNoiseTitle(title: string): NoiseMatch {
  for (const rule of NOISE_RULES) {
    for (const pattern of rule.patterns) {
      if (title.includes(pattern)) {
        return { match: true, category: rule.category };
      }
    }
  }
  return { match: false };
}
