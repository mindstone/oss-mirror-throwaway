import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(async () => {
  vi.restoreAllMocks();
  vi.doUnmock('@core/logger');
  const { setInvariantLogger } = await import('../invariant');
  setInvariantLogger(null);
});

describe('invariant', () => {
  it('throws InvariantViolationError on falsy condition', async () => {
    const { invariant, InvariantViolationError } = await import('../invariant');

    expect(() => invariant(false, 'expected failure')).toThrow(InvariantViolationError);
  });

  it('does not throw on truthy condition', async () => {
    const { invariant } = await import('../invariant');

    expect(() => invariant(true, 'should not fail')).not.toThrow();
  });

  it('requireDefined accepts 0 and empty string', async () => {
    const { requireDefined } = await import('../invariant');

    expect(requireDefined(0, 'count')).toBe(0);
    expect(requireDefined('', 'label')).toBe('');
  });

  it('requireDefined accepts other defined-but-falsy / empty values', async () => {
    const { requireDefined } = await import('../invariant');

    expect(requireDefined(false, 'flag')).toBe(false);
    expect(requireDefined(Number.NaN, 'num')).toBeNaN();
    const sym = Symbol('s');
    expect(requireDefined(sym, 'sym')).toBe(sym);
    expect(requireDefined([] as readonly number[], 'list')).toEqual([]);
    const map = new Map<string, number>();
    expect(requireDefined(map, 'map')).toBe(map);
    const set = new Set<number>();
    expect(requireDefined(set, 'set')).toBe(set);
    const nullProto = Object.create(null) as Record<string, unknown>;
    expect(requireDefined(nullProto, 'np')).toBe(nullProto);
  });

  it('requireDefined throws on null and undefined', async () => {
    const { requireDefined, InvariantViolationError } = await import('../invariant');

    expect(() => requireDefined(null, 'a')).toThrow(InvariantViolationError);
    expect(() => requireDefined(undefined, 'b')).toThrow(InvariantViolationError);
  });

  it('preserves Error.cause when the cause is an Error', async () => {
    const invariantModule: typeof import('../invariant') = await import('../invariant');
    const cause = new Error('root cause');

    try {
      invariantModule.invariant(false, 'wrapped failure', cause);
      throw new Error('expected invariant to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(invariantModule.InvariantViolationError);
      expect((error as Error).cause).toBe(cause);
    }
  });

  it('surfaces the assertion error even when the injected logger throws', async () => {
    const invariantModule: typeof import('../invariant') = await import('../invariant');
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const sinkError = new Error('sink failed');
    invariantModule.setInvariantLogger({
      error: () => {
        throw sinkError;
      },
    });

    try {
      invariantModule.invariant(false, 'logger sink cannot mask this');
      throw new Error('expected invariant to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(invariantModule.InvariantViolationError);
      expect((error as Error).message).toBe('logger sink cannot mask this');
    }
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('"event":"invariant.violation"'));
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('sink failed'));
  });

  it('loads without resolving @core/logger', async () => {
    vi.resetModules();
    vi.doMock('@core/logger', () => {
      throw new Error('Cannot find module @core/logger');
    });

    await expect(import('../invariant')).resolves.toHaveProperty('invariant');
  });

  it('rejects promise chains with InvariantViolationError when thrown asynchronously', async () => {
    const { invariant, InvariantViolationError } = await import('../invariant');

    await expect(
      Promise.resolve().then(() => invariant(false, 'async invariant failure')),
    ).rejects.toBeInstanceOf(InvariantViolationError);
  });

  it('assertNever and invariant throw the same error subclass', async () => {
    const { invariant, InvariantViolationError } = await import('../invariant');
    const { assertNever } = await import('../assertNever');

    expect(() => invariant(false, 'runtime failure')).toThrow(InvariantViolationError);
    expect(() => assertNever('unexpected' as never)).toThrow(InvariantViolationError);
  });

  it('assertNever supports optional context in the thrown message', async () => {
    const { assertNever } = await import('../assertNever');

    expect(() => assertNever('unexpected' as never)).toThrow(
      'Unreachable: unhandled discriminant unexpected',
    );
    expect(() => assertNever('unexpected' as never, 'providerRouteDecision')).toThrow(
      'Unreachable: unhandled discriminant (providerRouteDecision) unexpected',
    );
  });
});
