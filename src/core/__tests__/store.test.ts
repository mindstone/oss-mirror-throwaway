import { describe, it, expectTypeOf } from 'vitest';
import type { KeyValueStore } from '@core/store';

/**
 * KeyValueStore is an interface — these tests verify the type exports are correct
 * and the contract compiles as expected. Runtime tests will come when implementations
 * are created in later stages.
 */

interface TestSchema extends Record<string, unknown> {
  name: string;
  count: number;
  tags: string[];
}

describe('KeyValueStore type contract', () => {
  it('exports the KeyValueStore interface', () => {
    expectTypeOf<KeyValueStore>().toBeObject();
  });

  it('accepts a generic schema parameter', () => {
    expectTypeOf<KeyValueStore<TestSchema>>().toBeObject();
  });

  it('typed get returns the correct value type', () => {
    type GetResult = ReturnType<KeyValueStore<TestSchema>['get']>;
    // get can return the value or undefined (single-arg overload)
    expectTypeOf<GetResult>().not.toBeNever();
  });

  it('has required methods', () => {
    expectTypeOf<KeyValueStore<TestSchema>>().toHaveProperty('get');
    expectTypeOf<KeyValueStore<TestSchema>>().toHaveProperty('set');
    expectTypeOf<KeyValueStore<TestSchema>>().toHaveProperty('has');
    expectTypeOf<KeyValueStore<TestSchema>>().toHaveProperty('delete');
    expectTypeOf<KeyValueStore<TestSchema>>().toHaveProperty('clear');
    expectTypeOf<KeyValueStore<TestSchema>>().toHaveProperty('store');
    expectTypeOf<KeyValueStore<TestSchema>>().toHaveProperty('path');
  });

  it('change listeners are optional', () => {
    expectTypeOf<KeyValueStore<TestSchema>['onDidChange']>().toEqualTypeOf<
      KeyValueStore<TestSchema>['onDidChange']
    >();
    expectTypeOf<KeyValueStore<TestSchema>['onDidAnyChange']>().toEqualTypeOf<
      KeyValueStore<TestSchema>['onDidAnyChange']
    >();
  });
});
