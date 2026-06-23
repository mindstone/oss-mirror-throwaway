import type {
  AgentRoutePlanResolvedEvent,
  TurnAuthLabel,
} from '@shared/agentEvents';
import type { RouteStatusLabel } from '../../store/routeLabelCacheStore';

type IsEqual<A, B> = (
  <T>() => T extends A ? 1 : 2
) extends (
  <T>() => T extends B ? 1 : 2
)
  ? true
  : false;

type Assert<T extends true> = T;

type _BroadcastTurnAuthLabelMatchesCanonical =
  Assert<IsEqual<AgentRoutePlanResolvedEvent['turnAuthLabel'], TurnAuthLabel>>;

type _RouteStatusLabelMatchesCanonical =
  Assert<IsEqual<RouteStatusLabel, TurnAuthLabel>>;

export {};
