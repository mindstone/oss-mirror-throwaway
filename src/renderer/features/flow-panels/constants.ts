/**
 * Flow panel constants.
 *
 * Extracted to break the circular dependency between FlowPanelsProvider
 * and plugins/types (both need FLOW_SURFACES).
 */

export const FLOW_SURFACES = ['home', 'focus', 'sessions', 'usecases', 'library', 'automations', 'tasks', 'team', 'settings'] as const;
