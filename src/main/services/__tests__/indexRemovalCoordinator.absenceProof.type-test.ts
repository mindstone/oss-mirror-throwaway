/**
 * indexRemovalCoordinator — F2/R4 by-construction COMPILE-TIME proof (Stage 4c).
 *
 * This file is a TYPE test, not a runtime test: it is compiled by `lint:ts`
 * (tsconfig.node includes the src/main tree) but NOT run by vitest (it's a
 * `.type-test.ts`, not a `.test.ts`). Its job is to make the by-construction claim
 * MECHANICAL: a cloud `absence` purge cannot be EXPRESSED without an
 * AbsenceProof. Each `@ts-expect-error` below is a hole that, if it ever
 * stopped being an error, would fail `lint:ts` — so the guarantee is enforced by
 * the compiler, not by reviewer vigilance.
 */
import {
  removeMetadataStoresEntry,
  type CoordinatorRemovalReason,
} from '../indexRemovalCoordinator';
import {
  tryBuildAbsenceProof,
  type AbsenceProof,
} from '@core/services/cloudLivenessProbe.types';

declare const someEntry: string;
declare const ws: string;

// The legacy loose `absence` kind no longer exists — only the split kinds.
// @ts-expect-error `absence` is not a valid removal kind (split into -unverified / -authorized).
const _legacyAbsence: CoordinatorRemovalReason = { kind: 'absence' };
void _legacyAbsence;

// `absence-unverified` carries NO proof — it can never authorize a cloud purge.
const unverified: CoordinatorRemovalReason = { kind: 'absence-unverified' };
removeMetadataStoresEntry(someEntry, unverified, { workspacePath: ws });

// `absence-authorized` STRUCTURALLY REQUIRES the proof — omitting it is a COMPILE
// error. This is the load-bearing by-construction guarantee (F2/R4): you cannot
// express a cloud-absence purge without an AbsenceProof.
// @ts-expect-error an `absence-authorized` removal cannot be constructed without `proof`.
const _authorizedNoProof: CoordinatorRemovalReason = { kind: 'absence-authorized' };
void _authorizedNoProof;

// `proof` must be a genuine AbsenceProof — a bare object is rejected.
const _authorizedBadProof: CoordinatorRemovalReason = {
  kind: 'absence-authorized',
  // @ts-expect-error a plain object is not an `AbsenceProof` (branded NonNullRealPath roots + literal discriminants).
  proof: { spaceRoot: '/x', walkRootRealPath: '/x', isComplete: true, verdict: 'healthy', healthGeneration: 1 },
};
void _authorizedBadProof;

// The ONLY way to obtain a proof is the smart-constructor, which returns null
// unless the walk was complete + healthy + non-null-root + matching-root. A real
// authorized removal must narrow the nullable proof first.
const maybeProof: AbsenceProof | null = tryBuildAbsenceProof({
  spaceRoot: '/cloud/General',
  walkRootRealPath: '/cloud/General',
  isComplete: true,
  verdict: 'healthy',
  healthGeneration: 1,
});
if (maybeProof) {
  const authorized: CoordinatorRemovalReason = { kind: 'absence-authorized', proof: maybeProof };
  removeMetadataStoresEntry(someEntry, authorized, { workspacePath: ws });
}

// A `degraded`/`unknown` walk yields null → cannot build an authorized removal.
const noProof = tryBuildAbsenceProof({
  spaceRoot: '/cloud/General',
  walkRootRealPath: '/cloud/General',
  isComplete: true,
  verdict: 'degraded',
  healthGeneration: 1,
});
// @ts-expect-error `noProof` is `AbsenceProof | null`; a null proof cannot satisfy `absence-authorized`.
const _authorizedNullable: CoordinatorRemovalReason = { kind: 'absence-authorized', proof: noProof };
void _authorizedNullable;
