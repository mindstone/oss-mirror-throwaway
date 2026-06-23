/**
 * Re-export of the canonical bounded detail parser.
 *
 * The real implementation lives in `@rebel/shared` (dependency-free, so the
 * package boundary stays clean and cloud-client / packages/shared can import it
 * without reaching into `src/shared`). This thin re-export is the entry point
 * for renderer / main / shared / core / cloud-service consumers. See
 * docs/plans/260616_detail-parse-class-kill/PLAN.md.
 */
export * from '@rebel/shared/utils/safeParseDetail';
