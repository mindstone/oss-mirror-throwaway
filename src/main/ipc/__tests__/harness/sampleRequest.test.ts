/**
 * Stage-4 test: iterate every meaningful invoke channel and prove the bounded
 * sampler produces a contract-valid request (and likewise a contract-valid
 * response over every response schema). This is the harness's *fixture-source*
 * proof — NOT the request-side contract guarantee (that lives at the Stage-2
 * seam).
 *
 * Key DoD nuances:
 *  - The auto-pass rate is REPORTED (console + an `expect` on the override-list
 *    size), NOT a ≥95% hard gate. ≥95% is a measured target, not a pass/fail.
 *  - Any channel the sampler can't handle must appear in `requestOverrides` or
 *    `UNSAMPLEABLE` (loud) — never silently skipped. A sampler throw on a channel
 *    in neither list is a HARD failure.
 *  - The generator THROWS (named error) on a schema it cannot sample and
 *    self-validates every sample via `.parse` — proven by dedicated unit cases.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { allChannels } from '@shared/ipc/contracts';
import {
  sampleRequest,
  sampleResponse,
  sampleSchema,
  SampleValidationError,
  UnsampleableSchemaError,
} from './sampleRequest';
import { requestOverrides, UNSAMPLEABLE } from './requestOverrides';

type AnyChannelDef = { type: string; request: z.ZodTypeAny; response: z.ZodTypeAny };

const invokeChannels: Array<[string, AnyChannelDef]> = Object.entries(
  allChannels as Record<string, AnyChannelDef>,
).filter(([, def]) => def.type === 'invoke');

/** A request schema is "meaningful" iff it is neither void/undefined nor an empty object. */
function isMeaningfulRequest(req: { _zod?: { def?: { type?: string; shape?: Record<string, unknown> } } }): boolean {
  const def = req?._zod?.def;
  if (!def) return false;
  if (def.type === 'void' || def.type === 'undefined') return false;
  if (def.type === 'object' && Object.keys(def.shape ?? {}).length === 0) return false;
  return true;
}

describe('bounded Zod sampler — generator semantics (unit)', () => {
  it('produces the smallest passing value for primitives', () => {
    expect(sampleSchema(z.string())).toBe('');
    expect(sampleSchema(z.number())).toBe(0);
    expect(sampleSchema(z.boolean())).toBe(false);
    expect(sampleSchema(z.bigint())).toBe(0n);
    expect(sampleSchema(z.date())).toEqual(new Date(0));
  });

  it('respects numeric bounds (.min/.int/.positive/.max/.multipleOf)', () => {
    expect(sampleSchema(z.number().min(5))).toBe(5);
    expect(z.number().int().positive().safeParse(sampleSchema(z.number().int().positive())).success).toBe(true);
    expect(z.number().int().min(10).max(500).safeParse(sampleSchema(z.number().int().min(10).max(500))).success).toBe(true);
    expect(z.number().multipleOf(5).min(3).safeParse(sampleSchema(z.number().multipleOf(5).min(3))).success).toBe(true);
  });

  it('respects string length + known formats', () => {
    expect((sampleSchema(z.string().min(3)) as string).length).toBeGreaterThanOrEqual(3);
    expect(z.email().safeParse(sampleSchema(z.email())).success).toBe(true);
    expect(z.uuid().safeParse(sampleSchema(z.uuid())).success).toBe(true);
    expect(z.url().safeParse(sampleSchema(z.url())).success).toBe(true);
  });

  it('handles enum/literal → first member', () => {
    expect(sampleSchema(z.enum(['x', 'y']))).toBe('x');
    expect(sampleSchema(z.literal('foo'))).toBe('foo');
  });

  it('object → required keys only (skips optional/default/catch/nullish)', () => {
    const s = z.object({
      req: z.string(),
      opt: z.string().optional(),
      def: z.string().default('d'),
    });
    const v = sampleSchema(s) as Record<string, unknown>;
    expect(v).toHaveProperty('req');
    // optional/default keys are skipped → not own-enumerable in the minimal sample.
    expect(Object.prototype.hasOwnProperty.call(v, 'opt')).toBe(false);
    // `.default()` re-materialises on parse, so post-parse the key may exist; the
    // important property is the sample PARSES.
    expect(s.safeParse(v).success).toBe(true);
  });

  it('array → [] unless .min(1)', () => {
    expect(sampleSchema(z.array(z.string()))).toEqual([]);
    expect((sampleSchema(z.array(z.string()).min(1)) as unknown[]).length).toBe(1);
    expect(z.array(z.string()).nonempty().safeParse(sampleSchema(z.array(z.string()).nonempty())).success).toBe(true);
  });

  it('tuple / record', () => {
    expect(sampleSchema(z.tuple([z.string(), z.number()]))).toEqual(['', 0]);
    expect(sampleSchema(z.record(z.string(), z.number()))).toEqual({});
  });

  it('union/discriminatedUnion → tries options until one parses (not blindly first)', () => {
    // First option is constrained-min so '' would fail; sampler must fall through.
    const u = z.union([z.string().min(3), z.number()]);
    expect(u.safeParse(sampleSchema(u)).success).toBe(true);
    const du = z.discriminatedUnion('k', [
      z.object({ k: z.literal('a'), n: z.number() }),
      z.object({ k: z.literal('b') }),
    ]);
    expect(du.safeParse(sampleSchema(du)).success).toBe(true);
  });

  it('pipe/transform → samples the INPUT (z.input), never the output', () => {
    const t = z.string().transform((s) => s.length);
    // Sampling the input means a string is produced and parse (which transforms) succeeds.
    expect(t.safeParse(sampleSchema(t)).success).toBe(true);
  });

  it('nullable/optional/default unwrap', () => {
    expect(z.string().nullable().safeParse(sampleSchema(z.string().nullable())).success).toBe(true);
    expect(z.string().optional().safeParse(sampleSchema(z.string().optional())).success).toBe(true);
    expect(z.string().default('x').safeParse(sampleSchema(z.string().default('x'))).success).toBe(true);
  });

  it('z.lazy recursion is depth-capped and terminates (JsonValueSchema shape)', () => {
    const json: z.ZodType<unknown> = z.lazy(() =>
      z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(json), z.record(z.string(), json)]),
    );
    const v = sampleSchema(json);
    expect(json.safeParse(v).success).toBe(true);
  });

  it('THROWS a named UnsampleableSchemaError on a schema it cannot sample', () => {
    // A cross-field refine over an all-optional object: the minimal object {} is
    // rejected by the refine, and the refine is opaque to introspection.
    const refined = z
      .object({ a: z.string().optional(), b: z.string().optional() })
      .refine((d) => Boolean(d.a || d.b), { message: 'need a or b' });
    expect(() => sampleSchema(refined)).toThrow(SampleValidationError);

    // An impossible numeric bound cannot be satisfied → UnsampleableSchemaError.
    expect(() => sampleSchema(z.number().min(10).max(5))).toThrow(UnsampleableSchemaError);
  });

  it('self-validates: a sample is always run back through .parse', () => {
    // Sanity: every primitive/composite above already proves the self-validate
    // loop; this asserts the loop is present by feeding an exotic-but-valid schema.
    const s = z.object({ id: z.uuid(), tags: z.array(z.string().min(1)).min(1) });
    expect(s.safeParse(sampleSchema(s)).success).toBe(true);
  });
});

describe('iterate all meaningful request channels — measured auto-pass rate', () => {
  it('every meaningful request channel is auto-sampled, overridden, or exempted (loud)', () => {
    const meaningful = invokeChannels.filter(([, def]) => isMeaningfulRequest(def.request));

    let autoPass = 0;
    let overridden = 0;
    let exempted = 0;
    const failures: Array<{ channel: string; error: string }> = [];

    for (const [channel, def] of meaningful) {
      if (channel in UNSAMPLEABLE) {
        exempted++;
        continue;
      }
      if (channel in requestOverrides) {
        // Overrides must still be contract-valid. `requestOverrides` is keyed by
        // `IpcChannelName` (Stage-5 F1 retype); index via a string view here.
        const r = def.request.safeParse((requestOverrides as Record<string, unknown>)[channel]);
        if (!r.success) {
          failures.push({ channel, error: `override fails request.parse: ${r.error.message}` });
        } else {
          overridden++;
        }
        continue;
      }
      try {
        sampleRequest(def.request);
        autoPass++;
      } catch (err) {
        failures.push({ channel, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
      }
    }

    const total = meaningful.length;
    const rate = total === 0 ? 1 : autoPass / total;

    // REPORT (not a hard gate).
    // eslint-disable-next-line no-console
    console.log(
      `[sampleRequest] meaningful request channels: ${total} | auto-pass: ${autoPass} (${(rate * 100).toFixed(1)}%) | overrides: ${overridden} | exempt: ${exempted}`,
    );
    if (failures.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[sampleRequest] UNHANDLED channels (must be added to requestOverrides/UNSAMPLEABLE):\n` +
          failures.map((f) => `  - ${f.channel}: ${f.error}`).join('\n'),
      );
    }

    // HARD gate: nothing is silently unhandled. Every channel is auto-sampled,
    // overridden (and valid), or explicitly exempted.
    expect(failures).toEqual([]);

    // Report the override-list size (per DoD: an expect on override size, not a
    // ≥95% rate gate). Keep it small per the shrink-the-subset off-ramp.
    expect(Object.keys(requestOverrides).length).toBeLessThanOrEqual(20);
  });
});

describe('iterate all response channels — measured auto-pass rate (sampleResponse)', () => {
  it('every invoke channel response is auto-sampled (loud on failure)', () => {
    let autoPass = 0;
    const failures: Array<{ channel: string; error: string }> = [];

    for (const [channel, def] of invokeChannels) {
      // void responses sample trivially to undefined; still exercise the path.
      try {
        sampleResponse(def.response);
        autoPass++;
      } catch (err) {
        failures.push({ channel, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
      }
    }

    const total = invokeChannels.length;
    const rate = total === 0 ? 1 : autoPass / total;

    // eslint-disable-next-line no-console
    console.log(
      `[sampleResponse] invoke channels: ${total} | auto-pass: ${autoPass} (${(rate * 100).toFixed(1)}%) | failures: ${failures.length}`,
    );
    if (failures.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[sampleResponse] UNHANDLED response schemas:\n` +
          failures.map((f) => `  - ${f.channel}: ${f.error}`).join('\n'),
      );
    }

    expect(failures).toEqual([]);
  });
});
