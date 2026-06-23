// Type declarations for routing-state-writer-selectors.mjs (the SSoT is plain
// .mjs so eslint.config.mjs can import it at config-load time without a TS
// loader; these declarations give the .ts consumers full type safety).

export interface RestrictedSyntaxSelector {
  readonly selector: string;
  readonly message: string;
}

export const routingStateWriterGuardSelectors: readonly RestrictedSyntaxSelector[];
