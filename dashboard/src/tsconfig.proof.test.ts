import { describe, it, expectTypeOf } from 'vitest';

// Proves tsconfig has noUncheckedIndexedAccess: true. Without that flag,
// `arr[0]` would be inferred as `number`; with it, the type is
// `number | undefined`, which is what we assert below. If a future
// edit weakens the tsconfig, this test fails at typecheck time.
describe('tsconfig noUncheckedIndexedAccess', () => {
  it('makes array indexing return T | undefined', () => {
    const arr: number[] = [1, 2, 3];
    expectTypeOf(arr[0]).toEqualTypeOf<number | undefined>();
  });
});
