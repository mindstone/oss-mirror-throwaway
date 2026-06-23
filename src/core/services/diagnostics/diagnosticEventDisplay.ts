import type { DiagnosticEventEntry } from './manifest';

export interface FriendlyEventDisplay {
  readonly displayKind: string;
  readonly summary: string;
  readonly tone: 'info' | 'warning' | 'success' | 'destructive';
}

function appendInjectionSuspicion(
  summary: string,
  level: Extract<DiagnosticEventEntry, { kind: 'watchdog_judge_decision' }>['data']['injectionSuspected'],
): string {
  if (level === undefined) return summary;
  if (level === 'none') return `${summary} Injection suspicion: none.`;
  if (level === 'warn') return `${summary} Injection suspicion: warning.`;
  return `${summary} Injection suspicion: override.`;
}

export function getFriendlyEventDisplay(event: DiagnosticEventEntry): FriendlyEventDisplay {
  switch (event.kind) {
    case 'cooldown_enter':
      if (event.data.scope === 'safety-eval') {
        return {
          displayKind: 'safe_eval_cooldown',
          summary: 'A safety check paused briefly after hitting a service limit.',
          tone: 'info',
        };
      }
      return {
        displayKind: event.kind,
        summary: 'Rebel paused requests because a service asked it to slow down.',
        tone: 'warning',
      };
    case 'cooldown_exit':
      return {
        displayKind: event.kind,
        summary: 'Rebel resumed requests after a temporary pause.',
        tone: 'success',
      };
    case 'known_condition':
      return {
        displayKind: event.kind,
        summary: buildKnownConditionSummary(event.data),
        tone: toneForKnownConditionLevel(event.data.level),
      };
    case 'tool_call_error':
      return {
        displayKind: event.kind,
        summary: 'A tool call failed.',
        tone: 'destructive',
      };
    case 'abort_event': {
      let summary = 'A response stopped before finishing.';
      if (event.data.reason === 'judge_killed') {
        summary = 'A time check stopped the response after sustained silence.';
      } else if (event.data.reason === 'consecutive_fail_open_cap') {
        summary = 'A time check stopped the response after failing to connect multiple times.';
      } else if (event.data.reason === 'tool_cancelled_cap') {
        summary = 'A tool kept getting stuck, so the response was stopped.';
      } else if (event.data.reason === 'tool_cancel_unresponsive') {
        summary = 'A cancelled tool did not stop cleanly, so the response was stopped.';
      } else if (event.data.reason === 'tool_repeated_timeout') {
        summary = 'A subagent kept running out of time, so the response was stopped.';
      }
      return {
        displayKind: event.kind,
        summary,
        tone: 'warning',
      };
    }
    case 'watchdog_judge_decision': {
      if (event.data.decision === 'tool_cancelled') {
        return {
          displayKind: event.kind,
          summary: appendInjectionSuspicion(
            'Time check stopped a single tool and let the response continue.',
            event.data.injectionSuspected,
          ),
          tone: 'warning',
        };
      }
      if (event.data.decision === 'auto_extended') {
        const summary = event.data.reason === 'auto_extend_active_subagent_recent_activity'
          ? 'Time check auto-extended because a subagent still looked active.'
          : 'Time check auto-extended because this looked like early normal progress.';
        return {
          displayKind: event.kind,
          summary: appendInjectionSuspicion(summary, event.data.injectionSuspected),
          tone: 'info',
        };
      }
      const summary = event.data.decision === 'extended'
        ? `Time check granted ${(event.data.additionalMs ?? 15 * 60_000) / 60_000} more minutes.`
        : `Time check unreachable — granted ${(event.data.additionalMs ?? 10 * 60_000) / 60_000} more minutes anyway.`;
      return {
        displayKind: event.kind,
        summary: appendInjectionSuspicion(summary, event.data.injectionSuspected),
        tone: event.data.decision === 'extended' ? 'info' : 'warning',
      };
    }
    case 'judge_decision_stale_skip':
      return {
        displayKind: event.kind,
        summary: event.data.decision === 'kill'
          ? 'A time check result was ignored because the tool had already finished.'
          : 'A time check extension was ignored because the tool had already finished.',
        tone: 'info',
      };
    case 'subagent_internal_timeout_recovered':
      return {
        displayKind: event.kind,
        summary: event.data.agentName
          ? `Subagent "${event.data.agentName}" ran out of time and the response continued without it.`
          : 'A subagent ran out of time and the response continued without it.',
        tone: 'info',
      };
    case 'approval_stuck':
      return {
        displayKind: event.kind,
        summary: 'A permission prompt has been waiting for your answer.',
        tone: 'warning',
      };
    case 'tool_advisory':
      return {
        displayKind: event.kind,
        summary: 'Rebel logged a hint about how a tool is behaving.',
        tone: 'info',
      };
    case 'mcp_transition':
      return {
        displayKind: event.kind,
        summary: 'A connected tool server changed state (e.g., started, stopped, or reconnected).',
        tone: 'info',
      };
    case 'auth_event':
      return {
        displayKind: event.kind,
        summary: 'A sign-in or token refresh happened.',
        tone: 'info',
      };
    case 'streaming_invariant':
      return {
        displayKind: event.kind,
        summary: 'Rebel noticed an unexpected pattern in a streamed response.',
        tone: 'warning',
      };
    case 'health_check_timing':
      return {
        displayKind: event.kind,
        summary: 'A health check was slow or timed out.',
        tone: event.data.timedOut ? 'destructive' : 'warning',
      };
    case 'provider_reachability_change':
      return {
        displayKind: event.kind,
        summary: `Provider reachability changed to ${event.data.status}.`,
        tone: event.data.status === 'reachable' ? 'success' : (event.data.status === 'unreachable' ? 'destructive' : 'info'),
      };
    case 'embedding_index_health':
      return {
        displayKind: event.kind,
        summary: `Semantic index state changed: ${event.data.transition.replace(/_/g, ' ')}.`,
        tone: event.data.transition.includes('stale') || event.data.transition.includes('unready') ? 'warning' : 'success',
      };
    case 'worker_stats_pre_turn':
      return {
        displayKind: event.kind,
        summary: 'Pre-turn worker stats snapshot captured since app start.',
        tone: 'info',
      };
    case 'auto_update_state_change':
      return {
        displayKind: event.kind,
        summary: `Auto-update state changed: ${event.data.transition.replace(/_/g, ' ')}.`,
        tone: event.data.transition.includes('failed') ? 'destructive' : 'info',
      };
    case 'fsevents_leak_sweep':
      return {
        displayKind: event.kind,
        summary: `Force-stopped ${event.data.sweptCount} leaked file-watcher instance(s) at app exit.`,
        tone: 'warning',
      };
    case 'quit_deadlock_detected':
      return {
        displayKind: event.kind,
        summary: 'Quit got stuck and a force-exit fallback had to step in to let the app close or update.',
        tone: 'destructive',
      };
    case 'settings_drift_observation':
      return {
        displayKind: event.kind,
        summary: event.data.eventState === 'resolved'
          ? 'Settings drift resolved.'
          : 'Differences observed in settings.',
        tone: event.data.eventState === 'resolved' ? 'success' : 'warning',
      };
    case 'cost_outcome_resolution':
      return {
        displayKind: event.kind,
        summary: 'A cost entry outcome was resolved after the turn finished.',
        tone: 'info',
      };
    case 'cost_outcome_resolution_lost':
      return {
        displayKind: event.kind,
        summary: 'A cost entry outcome could not be resolved before ledger rotation.',
        tone: 'warning',
      };
    case 'cost_outcome_resolution_unmatched':
      return {
        displayKind: event.kind,
        summary: 'A cost outcome resolution did not match any cost entry.',
        tone: 'warning',
      };
    case 'continuity_transition':
      return {
        displayKind: event.kind,
        summary: 'A continuity state change was recorded for sync troubleshooting.',
        tone: event.data.level === 'error' ? 'destructive' : (event.data.level === 'warning' ? 'warning' : 'info'),
      };
    case 'events_per_kind_cap_engaged':
      return {
        displayKind: event.kind,
        summary: `Diagnostic ledger ceiling engaged for "${event.data.kind}" (cap: ${event.data.capLimit}). New events still recorded.`,
        tone: 'warning',
      };
    default: {
      const unhandled: never = event;
      return fallbackDisplay((unhandled as DiagnosticEventEntry).kind);
    }
  }
}

function toneForKnownConditionLevel(
  level: Extract<DiagnosticEventEntry, { kind: 'known_condition' }>['data']['level'],
): FriendlyEventDisplay['tone'] {
  switch (level) {
    case 'error':
      return 'destructive';
    case 'warning':
      return 'warning';
    case 'info':
      return 'info';
    default: {
      const unhandled: never = level;
      return unhandled;
    }
  }
}

const FRIENDLY_KNOWN_CONDITION_SUMMARIES: Readonly<Record<string, string>> = {
  conversation_title_unavailable: "Couldn't generate a conversation title.",
  time_saved_unavailable: "Couldn't estimate time saved.",
  bts_structured_output_fallback: 'Falling back to a different response format.',
};

function buildKnownConditionSummary(
  data: Extract<DiagnosticEventEntry, { kind: 'known_condition' }>['data'],
): string {
  const condition = data && typeof data.condition === 'string' ? data.condition : null;
  if (condition) {
    return FRIENDLY_KNOWN_CONDITION_SUMMARIES[condition] ?? `Known issue: ${condition}`;
  }
  return 'Known issue tracked.';
}

function fallbackDisplay(kind: DiagnosticEventEntry['kind']): FriendlyEventDisplay {
  return {
    displayKind: kind,
    summary: `${kind} event recorded.`,
    tone: 'info',
  };
}
