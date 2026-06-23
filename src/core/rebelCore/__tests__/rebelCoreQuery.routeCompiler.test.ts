/**
 * Direct unit tests for the pure parent-execution route compiler
 * (`compileStepRoutes`) and its two projections (`buildModelSwitchSchedule`,
 * which is the model-switch timeline). The compiler is the single source both
 * the switch schedule and the parent-route portion of the UI task metadata
 * project from, so these tests pin the route-intent contract by construction.
 *
 * Scope (per PLAN.md Verification Notes):
 *  - sparse overrides → switch-back to default (the HIGH divergence bug)
 *  - escalation + per-step coexistence (no more mutually-exclusive branch)
 *  - escalation one-way ratchet monotonicity
 *  - escalation `to_model` with NO matching profile (stays executable by decoded id)
 *  - model-less plan (no switches)
 *  - single-entry pool (resolution falls back, no silent drop)
 *  - parallel-group conflict (group → default route, logged)
 */
import { describe, it, expect } from 'vitest';
import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
import type { ModelProfile } from '@shared/types';
import type { ThinkingEffort } from '@shared/types/settings';
import type { PlanningStep, RoutingDecision } from '../planningMode';
import {
  compileStepRoutes,
  buildModelSwitchSchedule,
  type CompiledStepRoute,
} from '../rebelCoreQuery';

const WORKING_MODEL = 'claude-sonnet-4-20250514';
const ESCALATED_MODEL = 'claude-opus-4-20250514';
const HAIKU_MODEL = 'claude-haiku-4-5';

const working = unsafeAssertRoutingModelId(WORKING_MODEL);

function profile(model: string, id = model): ModelProfile {
  return {
    id,
    name: `Profile ${id}`,
    providerType: 'anthropic',
    serverUrl: '',
    model,
    routingEligible: true,
    enabled: true,
    createdAt: Date.now(),
  } as unknown as ModelProfile;
}

/** Pool with the escalated + haiku models routing-eligible (the working model
 * is the default/fallback and is always a valid route via currentModel). */
const POOL: ModelProfile[] = [profile(ESCALATED_MODEL, 'escalated'), profile(HAIKU_MODEL, 'haiku')];

function step(id: string, overrides: Partial<PlanningStep> = {}): PlanningStep {
  return { id, description: id, parallel_group: null, ...overrides } as PlanningStep;
}

function mapFor(...ids: string[]): Map<string, string> {
  return new Map(ids.map((id) => [id, `task-${id}`]));
}

function compile(args: {
  steps: PlanningStep[];
  routing?: RoutingDecision;
  pool?: ModelProfile[];
  parallelGroups?: Map<string, string[]>;
  workingProfile?: ModelProfile;
}): CompiledStepRoute[] {
  const ids = args.steps.map((s) => s.id!).filter(Boolean);
  return compileStepRoutes({
    routing: args.routing ?? { default_model: WORKING_MODEL, default_effort: 'low' },
    steps: args.steps,
    stepIdToTaskIdMap: mapFor(...ids),
    routingPool: args.pool ?? POOL,
    workingRoute: {
      model: working,
      effort: 'low',
      ...(args.workingProfile ? { profile: args.workingProfile } : {}),
    },
    parallelGroups: args.parallelGroups ?? new Map(),
  });
}

/**
 * Schedule helper: the orchestration site now compiles ONCE and projects both
 * the schedule and the metadata from that single `CompiledStepRoute[]`. The
 * tests mirror that — compile, then project — so the projection contract is
 * pinned against the same input the runtime uses.
 */
function scheduleFor(args: {
  steps: PlanningStep[];
  routing?: RoutingDecision;
  pool?: ModelProfile[];
  parallelGroups?: Map<string, string[]>;
  defaultEffort?: ThinkingEffort | undefined;
}) {
  const routing = args.routing ?? { default_model: WORKING_MODEL, default_effort: 'low' };
  const compiled = compileStepRoutes({
    routing,
    steps: args.steps,
    stepIdToTaskIdMap: mapFor(...args.steps.map((s) => s.id!).filter(Boolean)),
    routingPool: args.pool ?? POOL,
    workingRoute: { model: working, effort: args.defaultEffort ?? 'low' },
    parallelGroups: args.parallelGroups ?? new Map(),
  });
  return buildModelSwitchSchedule(compiled, working, args.defaultEffort ?? 'low', null);
}

describe('compileStepRoutes — parent-execution effective routes', () => {
  it('sparse overrides switch back to default when a later step omits model', () => {
    const steps = [
      step('s1'),
      step('s2', { model: ESCALATED_MODEL, effort: 'high' }),
      step('s3'), // model-less — must return to the default route, not stay on ESCALATED
    ];
    const routes = compile({ steps });
    expect(routes.map((r) => r.model)).toEqual([working, ESCALATED_MODEL, working]);
    expect(routes.map((r) => r.source)).toEqual(['default', 'per-step', 'default']);
  });

  it('projects a switch schedule that switches back to default (the HIGH divergence fix)', () => {
    const steps = [
      step('s1'),
      step('s2', { model: ESCALATED_MODEL, effort: 'high' }),
      step('s3'),
    ];
    const schedule = scheduleFor({ steps });
    // s2 → ESCALATED, s3 → back to WORKING.
    expect(schedule.map((sw) => sw.toModel)).toEqual([ESCALATED_MODEL, working]);
    expect(schedule.map((sw) => sw.stepId)).toEqual(['s2', 's3']);
  });

  it('route-identity: emits a switch when consecutive steps pick same-model DIFFERENT-profile routes', () => {
    // The live `profile:<id>` contract lets the planner disambiguate two profiles
    // that resolve to the SAME model (e.g. same model via two providers). The
    // compiled routes correctly carry the distinct profiles, but the switch
    // schedule must also fire on the profile change — otherwise step 2 runs on
    // step 1's client (wrong provider/credential).
    const SAME = HAIKU_MODEL;
    const pool = [profile(SAME, 'haiku-a'), profile(SAME, 'haiku-b')];
    const steps = [
      step('s1', { model: 'profile:haiku-a' }),
      step('s2', { model: 'profile:haiku-b' }),
    ];
    const compiled = compileStepRoutes({
      routing: { default_model: WORKING_MODEL, default_effort: 'low' },
      steps,
      stepIdToTaskIdMap: mapFor('s1', 's2'),
      routingPool: pool,
      workingRoute: { model: working, effort: 'low' },
      parallelGroups: new Map(),
    });
    // Compiler resolves each profile:<id> ref to its distinct profile:
    expect(compiled.map((r) => r.profile?.id)).toEqual(['haiku-a', 'haiku-b']);
    const schedule = buildModelSwitchSchedule(compiled, working, 'low', null);
    // Both steps must switch: s1 (working → haiku/haiku-a) AND s2 (haiku-a → haiku-b).
    expect(schedule.map((sw) => sw.stepId)).toContain('s2');
    expect(schedule.find((sw) => sw.stepId === 's2')?.toProfile?.id).toBe('haiku-b');
  });

  it('coexists escalation with per-step overrides and ratchets one-way', () => {
    const routing: RoutingDecision = {
      default_model: WORKING_MODEL,
      default_effort: 'low',
      escalation: { at_step: 's2', to_model: ESCALATED_MODEL, to_effort: 'high' },
    };
    const steps = [
      step('s1', { model: HAIKU_MODEL }),
      step('s2'), // escalation engages here
      step('s3', { model: HAIKU_MODEL }), // ratchet holds → stays ESCALATED, not HAIKU
    ];
    const routes = compile({ steps, routing });
    expect(routes.map((r) => r.model)).toEqual([HAIKU_MODEL, ESCALATED_MODEL, ESCALATED_MODEL]);
    expect(routes[1]?.source).toBe('escalation');
    expect(routes[2]?.source).toBe('escalation');
  });

  it('keeps escalation monotonic: never reverts after the escalation step', () => {
    const routing: RoutingDecision = {
      default_model: WORKING_MODEL,
      escalation: { at_step: 's1', to_model: ESCALATED_MODEL },
    };
    const steps = [step('s1'), step('s2'), step('s3', { model: WORKING_MODEL })];
    const routes = compile({ steps, routing });
    expect(routes.every((r) => r.model === ESCALATED_MODEL)).toBe(true);
  });

  it('keeps escalation to_model executable by decoded id when no profile matches', () => {
    const routing: RoutingDecision = {
      default_model: WORKING_MODEL,
      escalation: { at_step: 's2', to_model: HAIKU_MODEL },
    };
    // Pool WITHOUT haiku — the profile lookup misses, but the decoded id stays executable.
    const poolWithoutHaiku = [profile(ESCALATED_MODEL, 'escalated')];
    const steps = [step('s1'), step('s2')];
    const routes = compile({ steps, routing, pool: poolWithoutHaiku });
    expect(routes[1]?.model).toBe(HAIKU_MODEL);
    expect(routes[1]?.source).toBe('escalation');
    expect(routes[1]?.profile).toBeUndefined();
  });

  it('produces no switches for a model-less plan', () => {
    const steps = [step('s1'), step('s2'), step('s3')];
    const routes = compile({ steps });
    expect(routes.every((r) => r.model === working)).toBe(true);
    const schedule = scheduleFor({ steps });
    expect(schedule).toEqual([]);
  });

  it('falls back to the previous route (no silent drop) when a per-step ref is not in the pool', () => {
    // Single-entry pool: only the escalated model is eligible. A per-step ref to
    // an unresolvable model must NOT drop — it falls back to the previous route.
    const singleEntryPool = [profile(ESCALATED_MODEL, 'escalated')];
    const steps = [
      step('s1', { model: ESCALATED_MODEL }),
      step('s2', { model: 'totally-unknown-model' }),
    ];
    const routes = compile({ steps, pool: singleEntryPool });
    expect(routes[0]?.model).toBe(ESCALATED_MODEL);
    // s2 unresolved → falls back to s1's route (ESCALATED), not dropped, not default.
    expect(routes[1]?.model).toBe(ESCALATED_MODEL);
    expect(routes).toHaveLength(2);
  });

  it('runs a parallel group on the default route when members conflict', () => {
    const steps = [
      step('g1', { parallel_group: 'g', model: ESCALATED_MODEL }),
      step('g2', { parallel_group: 'g', model: HAIKU_MODEL }),
    ];
    const groups = new Map<string, string[]>([['g', ['g1', 'g2']]]);
    const routes = compile({ steps, parallelGroups: groups });
    // Conflict → both members run the single group route, which is the default.
    expect(routes.map((r) => r.model)).toEqual([working, working]);
    expect(routes.every((r) => r.source === 'group')).toBe(true);
  });

  it('runs a parallel group on the agreed non-default route when all members match', () => {
    const steps = [
      step('g1', { parallel_group: 'g', model: ESCALATED_MODEL, effort: 'high' }),
      step('g2', { parallel_group: 'g', model: ESCALATED_MODEL, effort: 'high' }),
    ];
    const groups = new Map<string, string[]>([['g', ['g1', 'g2']]]);
    const routes = compile({ steps, parallelGroups: groups });
    expect(routes.map((r) => r.model)).toEqual([ESCALATED_MODEL, ESCALATED_MODEL]);
    expect(routes.every((r) => r.source === 'group')).toBe(true);
  });

  it('route-identity: a parallel group whose members pick same-model DIFFERENT profiles disagrees → default route', () => {
    // Both members resolve to the SAME model via DIFFERENT profiles. Keying group
    // agreement on model+effort alone would wrongly treat them as agreeing and run
    // the group on one member's profile; profile-aware agreement makes them
    // disagree, so the group falls back to the default route.
    const SAME = HAIKU_MODEL;
    const pool = [profile(SAME, 'haiku-a'), profile(SAME, 'haiku-b')];
    const steps = [
      step('g1', { parallel_group: 'g', model: 'profile:haiku-a' }),
      step('g2', { parallel_group: 'g', model: 'profile:haiku-b' }),
    ];
    const groups = new Map<string, string[]>([['g', ['g1', 'g2']]]);
    const routes = compile({ steps, pool, parallelGroups: groups });
    expect(routes.map((r) => r.model)).toEqual([working, working]);
    expect(routes.every((r) => r.source === 'group')).toBe(true);
  });

  it('route-identity: a parallel group whose members agree on the SAME profile uses that route', () => {
    // Sanity counterpart: same model AND same profile → genuine agreement → group
    // runs on that non-default profile route (not default).
    const SAME = HAIKU_MODEL;
    const pool = [profile(SAME, 'haiku-a')];
    const steps = [
      step('g1', { parallel_group: 'g', model: 'profile:haiku-a' }),
      step('g2', { parallel_group: 'g', model: 'profile:haiku-a' }),
    ];
    const groups = new Map<string, string[]>([['g', ['g1', 'g2']]]);
    const routes = compile({ steps, pool, parallelGroups: groups });
    expect(routes.map((r) => r.model)).toEqual([SAME, SAME]);
    expect(routes.map((r) => r.profile?.id)).toEqual(['haiku-a', 'haiku-a']);
    expect(routes.every((r) => r.source === 'group')).toBe(true);
  });

  it('scoped parent-execution parity: the schedule-implied active model per step equals the compiled parent route', () => {
    // PARITY (parent-execution scope, per PLAN.md): the model the switch
    // schedule would leave the parent execution client on at each step MUST
    // equal the compiled parent-route model for that step. Both come from the
    // same compiler output, so this can never disagree — the test pins it.
    const routing: RoutingDecision = {
      default_model: WORKING_MODEL,
      default_effort: 'low',
      escalation: { at_step: 's3', to_model: ESCALATED_MODEL, to_effort: 'high' },
    };
    const steps = [
      step('s1'), // default
      step('s2', { model: HAIKU_MODEL }), // per-step
      step('s3'), // escalation engages (ratchet)
      step('s4', { model: HAIKU_MODEL }), // ratchet holds → ESCALATED
    ];
    const compiled = compile({ steps, routing });
    const schedule = scheduleFor({ steps, routing });

    // Replay the schedule to derive the active model at each step (the model
    // execution would actually run on), then compare to the compiled route.
    const switchByStepId = new Map(schedule.map((sw) => [sw.stepId, sw.toModel]));
    let active = working as string;
    for (const route of compiled) {
      if (switchByStepId.has(route.stepId)) {
        active = switchByStepId.get(route.stepId)!;
      }
      expect(route.model).toBe(active);
    }
  });

  // Stage 2 (DA-F7): the iteration-count fallback threshold is the route's
  // 1-based plan ordinal, NOT scraped from trailing digits of the step id. This
  // is the backstop for when the task store never marks a step
  // in_progress/completed — it must track plan position, not stringly-typed ids.
  it('sources fallbackIterationThreshold from the plan ordinal, not the step id digits', () => {
    const routing: RoutingDecision = {
      default_model: WORKING_MODEL,
      default_effort: 'low',
      escalation: { at_step: 'phase-two', to_model: ESCALATED_MODEL, to_effort: 'high' },
    };
    // Step ids carry NO trailing digits — the old digit-scraper would have
    // returned null and disabled the fallback entirely. The ordinal source makes
    // it the 2nd seeded step → threshold 2.
    const steps = [step('phase-one'), step('phase-two'), step('phase-three')];
    const schedule = scheduleFor({ steps, routing });
    expect(schedule).toHaveLength(1);
    expect(schedule[0]?.stepId).toBe('phase-two');
    expect(schedule[0]?.toModel).toBe(ESCALATED_MODEL);
    // 'phase-two' is the 2nd seeded step → ordinal 2 → fallback threshold 2.
    expect(schedule[0]?.fallbackIterationThreshold).toBe(2);
  });

  it('ordinal-sourced threshold equals the compiled route ordinal for every switch', () => {
    const steps = [
      step('alpha'),
      step('beta', { model: ESCALATED_MODEL, effort: 'high' }),
      step('gamma'),
      step('delta', { model: HAIKU_MODEL }),
    ];
    const compiled = compile({ steps });
    const schedule = scheduleFor({ steps });
    const ordinalByStepId = new Map(compiled.map((r) => [r.stepId, r.ordinal]));
    for (const sw of schedule) {
      expect(sw.fallbackIterationThreshold).toBe(ordinalByStepId.get(sw.stepId));
    }
  });

  // Stage 6 (Claude-F1, was Stage 2 pinning gap): a parallel group whose
  // membership straddles escalation.at_step now gets ONE atomic COMPILE-TIME
  // route assignment (and, via buildModelSwitchSchedule, a single schedule entry
  // keyed to the group's first member).
  //
  // SCOPE OF THE GUARANTEE (corrected per GPT-5.5 cross-family review): this is
  // COMPILE-TIME route + schedule atomicity, NOT runtime pre-dispatch atomicity.
  // The compiler re-points escalation engagement to the group's FIRST member when
  // at_step is grouped, so the whole group resolves to ONE route and the schedule
  // emits a single escalation switch at the group boundary — PARITY with how every
  // NON-grouped per-step switch is compiled. It does NOT change WHEN the switch
  // applies: like all switches it applies in `betweenTurns` after the keyed task
  // reaches in_progress (pinned by the runtime integration test in
  // rebelCoreQuery.escalation.test.ts — a later group's first batch can still run
  // one iteration on the pre-escalation model). Before Stage 6 the compiler split
  // the group's route mid-batch (g1 on default, g2/g3 escalated); this test now
  // asserts the corrected single-route assignment.
  //
  // FOLLOW-UP (out of Stage 6 scope): true pre-dispatch switching for a later
  // group's first concurrent tool batch (apply a due switch BEFORE a step's tool
  // batch dispatches, instead of at the next betweenTurns) is a separate,
  // system-wide agent-loop capability — deliberately not done this run.
  it('assigns a parallel group ONE atomic route when escalation.at_step is a LATER group member (Stage 6, compile-time)', () => {
    const routing: RoutingDecision = {
      default_model: WORKING_MODEL,
      default_effort: 'low',
      // Escalation engages at g2 — a MEMBER (not the first) of the parallel group.
      escalation: { at_step: 'g2', to_model: ESCALATED_MODEL, to_effort: 'high' },
    };
    const steps = [
      step('s0'),
      step('g1', { parallel_group: 'grp' }),
      step('g2', { parallel_group: 'grp' }),
      step('g3', { parallel_group: 'grp' }),
      step('s4'),
    ];
    const groups = new Map<string, string[]>([['grp', ['g1', 'g2', 'g3']]]);
    const routes = compile({ steps, routing, parallelGroups: groups });
    const byStep = new Map(routes.map((r) => [r.stepId, r]));

    // s0 (pre-group) is unescalated.
    expect(byStep.get('s0')?.model).toBe(working);
    // ATOMIC ROUTE: the WHOLE group resolves to the escalation route —
    // engagement re-pointed to the first member (g1), so g1, g2 (== at_step) and
    // g3 all carry the escalation route in the compiled output.
    expect(byStep.get('g1')?.model).toBe(ESCALATED_MODEL);
    expect(byStep.get('g2')?.model).toBe(ESCALATED_MODEL);
    expect(byStep.get('g3')?.model).toBe(ESCALATED_MODEL);
    expect(byStep.get('g1')?.source).toBe('escalation');
    // The one-way ratchet still holds AFTER the group: the post-group step stays
    // escalated.
    expect(byStep.get('s4')?.model).toBe(ESCALATED_MODEL);

    // SCHEDULE: a single escalation switch keyed to the group's FIRST member
    // (g1 → task-g1), so the runtime trigger is the group boundary, not g2.
    const schedule = scheduleFor({ steps, routing, parallelGroups: groups });
    const escalationSwitches = schedule.filter((sw) => sw.isEscalation);
    expect(escalationSwitches).toHaveLength(1);
    expect(escalationSwitches[0]?.stepId).toBe('g1');
    expect(escalationSwitches[0]?.taskId).toBe('task-g1');
    expect(escalationSwitches[0]?.toModel).toBe(ESCALATED_MODEL);
  });

  // Stage 6: escalation at_step is the group's FIRST member — still one atomic
  // route (engagement already lands at the boundary, ratchet covers the rest).
  it('assigns a parallel group ONE atomic route when escalation.at_step is the FIRST group member (Stage 6, compile-time)', () => {
    const routing: RoutingDecision = {
      default_model: WORKING_MODEL,
      default_effort: 'low',
      escalation: { at_step: 'g1', to_model: ESCALATED_MODEL, to_effort: 'high' },
    };
    const steps = [
      step('s0'),
      step('g1', { parallel_group: 'grp' }),
      step('g2', { parallel_group: 'grp' }),
      step('g3', { parallel_group: 'grp' }),
      step('s4'),
    ];
    const groups = new Map<string, string[]>([['grp', ['g1', 'g2', 'g3']]]);
    const routes = compile({ steps, routing, parallelGroups: groups });
    const byStep = new Map(routes.map((r) => [r.stepId, r]));

    expect(byStep.get('s0')?.model).toBe(working);
    expect(byStep.get('g1')?.model).toBe(ESCALATED_MODEL);
    expect(byStep.get('g2')?.model).toBe(ESCALATED_MODEL);
    expect(byStep.get('g3')?.model).toBe(ESCALATED_MODEL);
    expect(byStep.get('s4')?.model).toBe(ESCALATED_MODEL);
  });

  // Stage 6 GUARD: non-group escalation is UNCHANGED — escalation engages at
  // exactly at_step, earlier steps stay unescalated, the ratchet holds onward.
  it('leaves NON-group escalation engagement unchanged (engages exactly at at_step)', () => {
    const routing: RoutingDecision = {
      default_model: WORKING_MODEL,
      default_effort: 'low',
      escalation: { at_step: 's2', to_model: ESCALATED_MODEL, to_effort: 'high' },
    };
    const steps = [step('s1'), step('s2'), step('s3')];
    const routes = compile({ steps, routing });
    const byStep = new Map(routes.map((r) => [r.stepId, r]));

    expect(byStep.get('s1')?.model).toBe(working); // before at_step: unescalated
    expect(byStep.get('s2')?.model).toBe(ESCALATED_MODEL); // at_step: escalates
    expect(byStep.get('s2')?.source).toBe('escalation');
    expect(byStep.get('s3')?.model).toBe(ESCALATED_MODEL); // ratchet onward
  });

  // ---- Edge-case / cross-boundary battery (hot-region hardening) ----

  // F2 (switch-back telemetry): a DEFAULT-source route must carry the WORKING
  // profile, not `undefined`. This is what lets the switch-back applier restore
  // activeExecutionProfileId + the working profile's limits instead of
  // reconstructing the default by bare model string. Pins the compiler half of
  // the F2 fix (the applier half is pinned in the escalation integration suite).
  it('F2: a switch-back-to-default route carries the working profile (not undefined)', () => {
    const workingProfile = profile(WORKING_MODEL, 'working-profile');
    const steps = [
      step('s1'), // default
      step('s2', { model: ESCALATED_MODEL, effort: 'high' }), // per-step → escalated profile
      step('s3'), // model-less → BACK to default
      step('s4', { model: WORKING_MODEL }), // explicit working ref → also default route
    ];
    const routes = compile({ steps, workingProfile });
    const byStep = new Map(routes.map((r) => [r.stepId, r]));

    // Default-source routes carry the working profile.
    expect(byStep.get('s1')?.source).toBe('default');
    expect(byStep.get('s1')?.profile?.id).toBe('working-profile');
    // The back-switch (s3) restores the working profile, NOT undefined.
    expect(byStep.get('s3')?.source).toBe('default');
    expect(byStep.get('s3')?.profile?.id).toBe('working-profile');
    // An EXPLICIT working-model per-step ref is also the default route + profile.
    expect(byStep.get('s4')?.source).toBe('default');
    expect(byStep.get('s4')?.profile?.id).toBe('working-profile');
    // The non-default per-step keeps its OWN (escalated) profile, not the working one.
    expect(byStep.get('s2')?.source).toBe('per-step');
    expect(byStep.get('s2')?.profile?.id).toBe('escalated');
  });

  // F2 REGRESSION GUARD (GPT High must-address): the compiler must NEVER
  // propagate a working profile whose model differs from the working-route
  // model. A mismatched pair (stale settings working profile + planner-routed
  // default model) would make a switch-back build a client for the PROFILE's
  // model while the schedule/UI claim the route model — model/UI divergence.
  // The compiler drops the mismatched profile (→ bare-model resolution), so
  // default-source routes carry profile undefined, never the wrong profile.
  it('F2: drops a working profile whose model does not match the working route model', () => {
    const mismatchedProfile = profile(ESCALATED_MODEL, 'mismatched-escalated');
    const steps = [
      step('s1'), // default
      step('s2', { model: HAIKU_MODEL }),
      step('s3'), // back to default
    ];
    const ids = steps.map((s) => s.id!).filter(Boolean);
    const routes = compileStepRoutes({
      routing: { default_model: WORKING_MODEL, default_effort: 'low' },
      steps,
      stepIdToTaskIdMap: mapFor(...ids),
      routingPool: POOL,
      // Mismatched: working model is WORKING but profile.model is ESCALATED.
      workingRoute: { model: working, effort: 'low', profile: mismatchedProfile },
      parallelGroups: new Map(),
    });
    const byStep = new Map(routes.map((r) => [r.stepId, r]));
    expect(byStep.get('s1')?.source).toBe('default');
    expect(byStep.get('s1')?.profile).toBeUndefined();
    expect(byStep.get('s3')?.source).toBe('default');
    expect(byStep.get('s3')?.profile).toBeUndefined();
  });

  it('F2: the back-switch in the schedule carries the working profile as toProfile', () => {
    const workingProfile = profile(WORKING_MODEL, 'working-profile');
    const steps = [
      step('s1', { model: ESCALATED_MODEL, effort: 'high' }),
      step('s2'), // back to default
    ];
    const ids = steps.map((s) => s.id!).filter(Boolean);
    const compiled = compileStepRoutes({
      routing: { default_model: WORKING_MODEL, default_effort: 'low' },
      steps,
      stepIdToTaskIdMap: mapFor(...ids),
      routingPool: POOL,
      workingRoute: { model: working, effort: 'low', profile: workingProfile },
      parallelGroups: new Map(),
    });
    const schedule = buildModelSwitchSchedule(compiled, working, 'low', workingProfile.id);
    // s1 → ESCALATED (its profile), s2 → back to WORKING (working profile restored).
    expect(schedule.map((sw) => sw.toModel)).toEqual([ESCALATED_MODEL, working]);
    expect(schedule[0]?.toProfile?.id).toBe('escalated');
    expect(schedule[1]?.toProfile?.id).toBe('working-profile');
  });

  // F3 (escalation kind): the schedule must flag ONLY the escalation switch as
  // isEscalation — ordinary per-step / back-to-default switches are not
  // escalations (drives the user-facing copy: "Escalating to…" vs "Routing to…").
  it('F3: only the escalation switch is flagged isEscalation; per-step + back switches are not', () => {
    const routing: RoutingDecision = {
      default_model: WORKING_MODEL,
      default_effort: 'low',
      escalation: { at_step: 's4', to_model: ESCALATED_MODEL, to_effort: 'high' },
    };
    const steps = [
      step('s1'), // default
      step('s2', { model: HAIKU_MODEL }), // per-step switch (NOT escalation)
      step('s3'), // back to default (NOT escalation)
      step('s4'), // escalation engages here
    ];
    const schedule = scheduleFor({ steps, routing });
    const byStep = new Map(schedule.map((sw) => [sw.stepId, sw]));
    expect(byStep.get('s2')?.isEscalation).toBe(false); // per-step
    expect(byStep.get('s3')?.isEscalation).toBe(false); // back-to-default
    expect(byStep.get('s4')?.isEscalation).toBe(true);  // escalation
    // Exactly one escalation switch in the schedule.
    expect(schedule.filter((sw) => sw.isEscalation)).toHaveLength(1);
  });

  // Failed-switch × MULTIPLE pending switches (compiler/schedule half): the
  // schedule must enumerate every parent-route change so the applier can hold
  // only the failing one. This pins the schedule shape the integration parity
  // test relies on — two distinct non-default targets each get their own switch.
  it('emits one switch per distinct parent-route change across multiple pending targets', () => {
    const steps = [
      step('s1'), // default
      step('s2', { model: ESCALATED_MODEL, effort: 'high' }), // switch #1
      step('s3', { model: HAIKU_MODEL }), // switch #2 (different target)
      step('s4'), // switch #3 → back to default
    ];
    const schedule = scheduleFor({ steps });
    expect(schedule.map((sw) => sw.toModel)).toEqual([ESCALATED_MODEL, HAIKU_MODEL, working]);
    // Each switch targets a distinct step; none is pre-triggered.
    expect(schedule.map((sw) => sw.stepId)).toEqual(['s2', 's3', 's4']);
    expect(schedule.every((sw) => sw.triggered === false)).toBe(true);
  });
});
