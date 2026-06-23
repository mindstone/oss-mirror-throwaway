/**
 * Lightweight registry for cross-module accessors that would otherwise create
 * import cycles within the meetingBot/* cluster. Each owning module registers
 * its accessor at module-load time; consumers import the registry (which has
 * no upward dependencies aside from `meetingBotTypes`) and call through it.
 *
 * Each accessor returns `null` / `undefined` / a no-op default until the
 * owning service registers, so consumers can call eagerly during module load
 * without having to defer to first call.
 *
 * Add new accessors here when breaking new cycles in this cluster; keep this
 * file dependency-light (only `meetingBotTypes` for shared types) so the
 * registry stays at the bottom of the import graph.
 */

import type { DetectedMeeting, ActiveBotState, LocalRecordingStatus } from './meetingBotTypes';

type GetCurrentMeetingFn = () => DetectedMeeting | null;
type GetActiveBotStateFn = () => ActiveBotState | null;
type IsLocalRecordingCapturingFn = () => boolean;
type GetLocalRecordingStatusFn = () => LocalRecordingStatus;
type StopLocalRecordingResult = { success: boolean; error?: string };
type StopLocalRecordingFn = () => Promise<StopLocalRecordingResult>;

const NO_RECORDING_STATUS: LocalRecordingStatus = {
  isRecording: false,
  isCapturing: false,
  isUploading: false,
};

let getCurrentMeetingFn: GetCurrentMeetingFn | null = null;
let getActiveBotStateFn: GetActiveBotStateFn | null = null;
let isLocalRecordingCapturingFn: IsLocalRecordingCapturingFn | null = null;
let getLocalRecordingStatusFn: GetLocalRecordingStatusFn | null = null;
let stopLocalRecordingFn: StopLocalRecordingFn | null = null;

export function registerCurrentMeetingProvider(fn: GetCurrentMeetingFn): void {
  getCurrentMeetingFn = fn;
}

export function getCurrentMeeting(): DetectedMeeting | null {
  return getCurrentMeetingFn ? getCurrentMeetingFn() : null;
}

export function registerActiveBotStateProvider(fn: GetActiveBotStateFn): void {
  getActiveBotStateFn = fn;
}

export function getActiveBotState(): ActiveBotState | null {
  return getActiveBotStateFn ? getActiveBotStateFn() : null;
}

export function registerIsLocalRecordingCapturingProvider(fn: IsLocalRecordingCapturingFn): void {
  isLocalRecordingCapturingFn = fn;
}

export function isLocalRecordingCapturing(): boolean {
  return isLocalRecordingCapturingFn ? isLocalRecordingCapturingFn() : false;
}

export function registerLocalRecordingStatusProvider(fn: GetLocalRecordingStatusFn): void {
  getLocalRecordingStatusFn = fn;
}

export function getLocalRecordingStatus(): LocalRecordingStatus {
  return getLocalRecordingStatusFn ? getLocalRecordingStatusFn() : NO_RECORDING_STATUS;
}

export function registerStopLocalRecordingHandler(fn: StopLocalRecordingFn): void {
  stopLocalRecordingFn = fn;
}

export async function stopLocalRecording(): Promise<StopLocalRecordingResult> {
  if (stopLocalRecordingFn) {
    return await stopLocalRecordingFn();
  }
  return { success: false, error: 'stopLocalRecording handler not yet registered' };
}
