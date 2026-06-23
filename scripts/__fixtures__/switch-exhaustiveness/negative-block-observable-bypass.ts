type Example = 'handled' | 'unexpected';

export function classify(value: Example): string | undefined {
  switch (value) {
    case 'handled':
      return 'handled';
    default: {
      // Stage 3 deliberately does NOT fire on multi-statement blocks even
      // when they bail at the end. This is the "explicit observable failure"
      // pattern AGENTS.md endorses: log + degraded-state-signal + bail.
      console.warn('[classify] unrecognised value', { value });
      return undefined;
    }
  }
}
