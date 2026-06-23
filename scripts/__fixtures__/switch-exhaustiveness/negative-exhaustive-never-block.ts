type Example = 'handled' | 'recovered';

export function classify(value: Example): string {
  switch (value) {
    case 'handled':
      return 'handled';
    case 'recovered':
      return 'recovered';
    default: {
      // Compile-time exhaustiveness pattern: the `never` assertion fails the
      // tsc build if a new union member is added without a case. This is the
      // canonical TS-only pattern (no runtime call); Stage 3 deliberately
      // does NOT flag it. Behavioral-safety review noted that runtime-invalid
      // discriminants silently land in the fallback path, but the cheap
      // non-type-aware Stage 3 rule cannot distinguish that risk - Stage 6's
      // type-aware rule is the proper guard.
      const _exhaustive: never = value;
      void _exhaustive;
      return 'fallback';
    }
  }
}
