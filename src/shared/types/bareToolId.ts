/**
 * Branded type for bare (non-compound) tool identifiers.
 *
 * The tool safety system uses bare tool names (e.g., "gmail_send_email") as the
 * canonical identifier for trusted-tool lookups and safety evaluations. Compound
 * formats like "packageId/toolId" must never reach comparison sites.
 *
 * This branded type enforces that contract at compile time: any value typed as
 * BareToolId has been validated through `bareToolId()` or `getEffectiveToolIdentifier()`.
 * Passing an unvalidated `string` where `BareToolId` is expected is a type error.
 *
 * @see `bareToolId()` in `@shared/utils/trustedToolNormalization` to create a BareToolId
 * @see `toolSafetyService.getEffectiveToolIdentifier()` which also returns BareToolId
 * @see `docs/project/SAFETY_SYSTEM_OVERVIEW.md` § "Canonical tool identity contract"
 */
export type BareToolId = string & { readonly __brand: 'BareToolId' };
