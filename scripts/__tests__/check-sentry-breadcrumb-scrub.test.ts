import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { STEPS } from '../run-validate-fast';
import {
  analyzeBreadcrumbHookSource,
  collectBrandImportViolations,
} from '../check-sentry-breadcrumb-scrub';

const TARGET_SCRIPT = 'validate:sentry-breadcrumb-scrub';
const TARGET_COMMAND = 'npx tsx scripts/check-sentry-breadcrumb-scrub.ts';

interface PackageJson {
  scripts?: Record<string, string>;
}

function readPackageJson(): PackageJson {
  const packageJsonPath = join(__dirname, '..', '..', 'package.json');
  return JSON.parse(readFileSync(packageJsonPath, 'utf8')) as PackageJson;
}

describe('check-sentry-breadcrumb-scrub', () => {
  it('passes allowlisted and delete-based log breadcrumb scrub paths', () => {
    const mainResult = analyzeBreadcrumbHookSource(
      `
      SentryMain.init({
        beforeBreadcrumb(breadcrumb) {
          if (breadcrumb.data) {
            breadcrumb.data = breadcrumb.category === 'log'
              ? redactLogBreadcrumbData(breadcrumb.data as Record<string, unknown>)
              : (redactObjectDeep(breadcrumb.data) as Record<string, unknown>);
          }
          return breadcrumb;
        },
      });
      `,
      'src/main/sentry.ts',
    );

    const rendererResult = analyzeBreadcrumbHookSource(
      `
      const beforeBreadcrumb = (breadcrumb: Breadcrumb): Breadcrumb | null => {
        if (breadcrumb.data) {
          if ('renderer.log' === breadcrumb.category) {
            delete breadcrumb.data;
          } else {
            breadcrumb.data = redactObjectDeep(breadcrumb.data) as Record<string, unknown>;
          }
        }
        return breadcrumb;
      };
      `,
      'src/renderer/src/sentry.ts',
    );

    expect(mainResult.violations).toEqual([]);
    expect(rendererResult.violations).toEqual([]);
  });

  it('passes the branded attach-helper sink shape', () => {
    const result = analyzeBreadcrumbHookSource(
      `
      SentryMain.init({
        beforeBreadcrumb(breadcrumb) {
          if (breadcrumb.data) {
            if (breadcrumb.category === 'log') {
              attachLogBreadcrumbData(
                breadcrumb,
                redactLogBreadcrumbData(breadcrumb.data as Record<string, unknown>),
              );
            } else {
              breadcrumb.data = redactObjectDeep(breadcrumb.data) as Record<string, unknown>;
            }
          }
          return breadcrumb;
        },
      });
      `,
      'src/main/sentry.ts',
    );

    expect(result.violations).toEqual([]);
  });

  it('reports an attach-helper call whose payload is not the allowlist scrubber', () => {
    const result = analyzeBreadcrumbHookSource(
      `
      SentryMain.init({
        beforeBreadcrumb(breadcrumb) {
          if (breadcrumb.data) {
            if (breadcrumb.category === 'log') {
              attachLogBreadcrumbData(breadcrumb, breadcrumb.data as never);
            } else {
              breadcrumb.data = redactObjectDeep(breadcrumb.data) as Record<string, unknown>;
            }
          }
          return breadcrumb;
        },
      });
      `,
      'src/main/sentry.ts',
    );

    expect(result.violations).not.toEqual([]);
  });

  it('restricts brandSanitizedLogBreadcrumbData imports to sanctioned sanitizers', () => {
    const offending = {
      filePath: 'src/main/somewhere.ts',
      source: `import { brandSanitizedLogBreadcrumbData } from '@shared/utils/safeTelemetryBreadcrumbData';`,
    };
    const sanctioned = {
      filePath: 'src/core/utils/logFieldFilter.ts',
      source: `import { brandSanitizedLogBreadcrumbData } from '@shared/utils/safeTelemetryBreadcrumbData';`,
    };
    const testFile = {
      filePath: 'src/shared/utils/__tests__/safeTelemetryBreadcrumbData.test.ts',
      source: `import { brandSanitizedLogBreadcrumbData } from '../safeTelemetryBreadcrumbData';`,
    };

    expect(collectBrandImportViolations([sanctioned, testFile])).toEqual([]);
    const violations = collectBrandImportViolations([offending, sanctioned, testFile]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.filePath).toBe('src/main/somewhere.ts');
  });

  it('passes compound log and tagged-log breadcrumb scrub paths', () => {
    const result = analyzeBreadcrumbHookSource(
      `
      Sentry.init({
        beforeBreadcrumb(breadcrumb) {
          if (breadcrumb.data) {
            if (breadcrumb.category === 'log' || breadcrumb.category?.startsWith('log.')) {
              breadcrumb.data = redactLogBreadcrumbData(breadcrumb.data as Record<string, unknown>);
            } else {
              breadcrumb.data = redactObjectDeep(breadcrumb.data) as Record<string, unknown>;
            }
          }
          return breadcrumb;
        },
      });
      `,
      'cloud-service/src/bootstrap.ts',
    );

    expect(result.violations).toEqual([]);
  });

  it('reports a log breadcrumb routed through the generic redactor', () => {
    const result = analyzeBreadcrumbHookSource(
      `
      SentryMain.init({
        beforeBreadcrumb(breadcrumb) {
          if (breadcrumb.data) {
            if (breadcrumb.category === 'log') {
              breadcrumb.data = redactObjectDeep(breadcrumb.data) as Record<string, unknown>;
            } else {
              breadcrumb.data = redactObjectDeep(breadcrumb.data) as Record<string, unknown>;
            }
          }
          return breadcrumb;
        },
      });
      `,
      'src/main/sentry.ts',
    );

    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations.map((violation) => violation.problem).join('\n')).toContain(
      'redactObjectDeep(...) is applied to breadcrumb.data outside a clearly non-log branch',
    );
  });

  it('reports breadcrumb data redaction with no log-category guard', () => {
    const result = analyzeBreadcrumbHookSource(
      `
      const beforeBreadcrumb = (breadcrumb: Breadcrumb): Breadcrumb | null => {
        if (breadcrumb.data) {
          breadcrumb.data = redactObjectDeep(breadcrumb.data) as Record<string, unknown>;
        }
        return breadcrumb;
      };
      `,
      'src/renderer/src/sentry.ts',
    );

    expect(result.violations).toEqual([
      expect.objectContaining({
        problem: expect.stringContaining('without a log-category guard'),
      }),
    ]);
  });

  it('reports a no-op allowlist call that does not scrub breadcrumb.data', () => {
    const result = analyzeBreadcrumbHookSource(
      `
      Sentry.init({
        beforeBreadcrumb(breadcrumb) {
          if (breadcrumb.data) {
            if (breadcrumb.category === 'log' || breadcrumb.category?.startsWith('log.')) {
              redactLogBreadcrumbData(somethingElse);
              breadcrumb.data = breadcrumb.data;
            } else {
              breadcrumb.data = redactObjectDeep(breadcrumb.data) as Record<string, unknown>;
            }
          }
          return breadcrumb;
        },
      });
      `,
      'cloud-service/src/bootstrap.ts',
    );

    expect(result.violations).toEqual([
      expect.objectContaining({
        problem: expect.stringContaining('does not clearly use an allowlisted breadcrumb.data sink'),
      }),
      expect.objectContaining({
        problem: expect.stringContaining('without the sanctioned allowlist scrubber'),
      }),
    ]);
  });

  it('reports a new unknown beforeBreadcrumb hook file', () => {
    const result = analyzeBreadcrumbHookSource(
      `
      const beforeBreadcrumb = (breadcrumb: Breadcrumb): Breadcrumb | null => {
        if (breadcrumb.data && breadcrumb.category === 'renderer.log') {
          delete breadcrumb.data;
        }
        return breadcrumb;
      };
      `,
      'src/new-sentry-surface/sentry.ts',
    );

    expect(result.violations).toEqual([
      expect.objectContaining({
        problem: expect.stringContaining('unclassified file'),
      }),
    ]);
  });

  it('is wired into validate:fast and package.json', () => {
    const packageJson = readPackageJson();
    const step = STEPS.find((candidate) => candidate.name === TARGET_SCRIPT);

    expect(packageJson.scripts?.[TARGET_SCRIPT]).toBe(TARGET_COMMAND);
    expect(step?.command).toBe(TARGET_COMMAND);
  });
});
