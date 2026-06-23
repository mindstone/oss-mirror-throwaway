// Single source of truth for the PM 260601 routing-state writer guard
// `no-restricted-syntax` selectors.
//
// Consumed by:
//   - eslint.config.mjs
//       → spread into the `no-restricted-syntax` rule for
//         src/core/rebelCore/rebelCoreQuery.ts (the production wiring).
//   - src/core/rebelCore/__tests__/rebelCoreQuery.routingStateWriterLint.test.ts
//       → linted against synthetic snippets with a minimal NON-type-aware
//         flat config, and asserted to still be wired in the production config.
//
// Why a single source of truth: the test must lint the exact selectors the
// production config applies, otherwise a "passing" test can drift from what
// ESLint really enforces. Keeping the literals here (not copied into the test)
// means removing/altering a selector breaks the test by construction.
//
// Why plain `.mjs` (with a co-located `.d.mts`): eslint.config.mjs is loaded by
// the `eslint` binary as plain Node ESM (no TS loader), so it cannot import a
// `.ts` at config-load time. A `.ts` test statically importing a `.mjs` would
// also fail `tsc -p tsconfig.node.json` (TS7016, no declaration; allowJs off).
// The `.mjs` + `.d.mts` pair satisfies both consumers — same pattern as
// scripts/silentSwallowSurfaceCoverage.mjs.
//
// These selectors are pure AST (no type information), so a non-type-aware lint
// catches the same writes the production type-aware lint does — see
// docs-private/postmortems/260601_routing_switch_application_state_drift_postmortem.md.

// Routing-state writer guard (PM 260601): parent execution state has exactly
// one writer (`activeExecution.commit`), and task routing badges must preserve
// the parent-route/display-overlay split.
export const routingStateWriterGuardSelectors = [
  {
    selector: "VariableDeclaration[kind=/^(let|var)$/] > VariableDeclarator[id.name=/^(activeExecution[A-Z].*|activeSupportsReasoningReplay)$/]",
    message: 'Do not reintroduce piecemeal activeExecution* execution-state mutables. Use the sole-writer activeExecution.commit / commitActiveExecutionState path instead. Override: // eslint-disable-next-line no-restricted-syntax -- routing-state-writer-justified: <reason>. See docs-private/postmortems/260601_routing_switch_application_state_drift_postmortem.md.',
  },
  {
    selector: "AssignmentExpression[operator='='][left.name=/^(activeExecution[A-Z].*|activeSupportsReasoningReplay)$/]",
    message: 'Do not reassign piecemeal activeExecution* execution-state mutables. Use the sole-writer activeExecution.commit / commitActiveExecutionState path instead. Override: // eslint-disable-next-line no-restricted-syntax -- routing-state-writer-justified: <reason>. See docs-private/postmortems/260601_routing_switch_application_state_drift_postmortem.md.',
  },
  {
    selector: "AssignmentExpression[operator='='][left.type='MemberExpression'][left.object.name='taskRoutingMetadata']",
    message: 'taskRoutingMetadata badge writes are guarded: parent-route badge writes must key on parentRouteModelByTaskId and skip isSubAgent; the only legitimate sub-agent/display write is the runtime overlay stamp. Override: // eslint-disable-next-line no-restricted-syntax -- routing-state-writer-justified: <reason>. See docs-private/postmortems/260601_routing_switch_application_state_drift_postmortem.md.',
  },
  {
    selector: "AssignmentExpression[operator='='][left.type='MemberExpression'][left.property.name='model'][left.object.type='MemberExpression'][left.object.object.name='taskRoutingMetadata']",
    message: 'taskRoutingMetadata[taskId].model display-model writes are guarded: parent-route badge writes must key on parentRouteModelByTaskId and skip isSubAgent; the only legitimate sub-agent/display write is the runtime overlay stamp. Override: // eslint-disable-next-line no-restricted-syntax -- routing-state-writer-justified: <reason>. See docs-private/postmortems/260601_routing_switch_application_state_drift_postmortem.md.',
  },
  {
    selector: "CallExpression[callee.object.name='Object'][callee.property.name='assign'][arguments.0.name='taskRoutingMetadata']",
    message: 'Object.assign(taskRoutingMetadata, ...) writes are guarded: parent-route badge writes must key on parentRouteModelByTaskId and skip isSubAgent; the only legitimate sub-agent/display write is the runtime overlay stamp. Override: // eslint-disable-next-line no-restricted-syntax -- routing-state-writer-justified: <reason>. See docs-private/postmortems/260601_routing_switch_application_state_drift_postmortem.md.',
  },
];
