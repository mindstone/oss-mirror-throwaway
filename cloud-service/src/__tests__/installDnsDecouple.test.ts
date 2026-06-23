/**
 * Regression guard for the dead-code class a reviewer caught during the
 * 260617 DNS-starvation fix: the cloud leaf installer (`./installDnsDecouple`)
 * existed but was not imported by `server.ts`, so the decoupled DNS dispatcher
 * was never installed in cloud boot.
 *
 * Two complementary checks:
 *  (1) importing `./installDnsDecouple` triggers `installGlobalUndiciDnsDecouple`
 *      (the leaf module's whole job is a side-effect-on-import install);
 *  (2) `server.ts` imports `./installDnsDecouple` BEFORE `./bootstrap` — ESM
 *      evaluation order is the contract, so a transitive top-level fetch in the
 *      bootstrap graph can't beat the dispatcher install. A source-order
 *      assertion guards the ordering without booting the (heavy) server graph.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const { installSpy } = vi.hoisted(() => ({ installSpy: vi.fn() }));

vi.mock('@core/utils/dnsThreadpoolDecouple', () => ({
  installGlobalUndiciDnsDecouple: installSpy,
}));

describe('cloud installDnsDecouple leaf installer', () => {
  it('installs the decoupled DNS dispatcher as a side-effect on import', async () => {
    expect(installSpy).not.toHaveBeenCalled();
    await import('../installDnsDecouple');
    expect(installSpy).toHaveBeenCalledTimes(1);
  });
});

describe('cloud server.ts import ordering', () => {
  it('imports ./installDnsDecouple before ./bootstrap (ESM evaluation-order contract)', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // Strip block AND line comments first so a commented-out import (the exact
    // dead-code regression class we guard) can't false-green the order check —
    // including a multi-line `/* ... */` block that wraps a bare import line.
    const serverSource = readFileSync(path.join(here, '..', 'server.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

    // Match ACTUAL (non-commented) import statements anchored at line start, so a
    // commented-out import (the exact dead-code regression class) is NOT counted.
    const dnsImportRe = /^\s*import\s+'\.\/installDnsDecouple';/m;
    const bootstrapImportRe = /^\s*import\s+\{[^}]*\}\s+from\s+'\.\/bootstrap';/m;

    const dnsMatch = dnsImportRe.exec(serverSource);
    const bootstrapMatch = bootstrapImportRe.exec(serverSource);

    // Both imports must be present as live statements...
    expect(dnsMatch, 'server.ts must import ./installDnsDecouple (not commented out)').not.toBeNull();
    expect(bootstrapMatch, 'server.ts must import ./bootstrap').not.toBeNull();
    // ...and the DNS decouple install must come first so the global dispatcher
    // is in place before bootstrap's static-import graph can issue any fetch.
    expect(dnsMatch!.index).toBeLessThan(bootstrapMatch!.index);
  });
});
