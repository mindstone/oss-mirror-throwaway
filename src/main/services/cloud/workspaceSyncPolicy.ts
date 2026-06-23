// The pure conflict-copy suppression gate moved to `@shared/conflictSuppression`
// so the per-user Fly cloud-service can share ONE copy without importing any
// `@main` module (which would create the first cloud→desktop-main coupling).
// This re-export keeps every existing desktop import site working unchanged.
export * from '@shared/conflictSuppression';
