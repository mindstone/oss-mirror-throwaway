// Type declarations for busy-wait-persistence-guard-selectors.mjs (the SSoT is
// plain .mjs so eslint.config.mjs can import it at config-load time without a TS
// loader; these declarations give the .ts/.js consumers full type safety).

export interface RestrictedSyntaxSelector {
  readonly selector: string;
  readonly message: string;
}

export const busyWaitPersistenceGuardSelectors: readonly RestrictedSyntaxSelector[];
