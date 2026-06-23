/**
 * Re-export of the canonical bounded detail parser (now in `@rebel/shared`).
 *
 * This path is kept stable so the agent-session callers that already import
 * `safeParseDetail` / `MAX_DETAIL_PARSE_BYTES` / `SafeParseDetailResult` from
 * here are unaffected. The real implementation — including the throttled
 * too-large breadcrumb that previously lived here — now lives in
 * `packages/shared/src/utils/safeParseDetail.ts`. See
 * docs/plans/260616_detail-parse-class-kill/PLAN.md.
 */
export * from '@rebel/shared/utils/safeParseDetail';
