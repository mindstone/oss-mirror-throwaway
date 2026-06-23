// SHIM-RETAINED: Cloud server/tests still import this module and require cloud audio-op wiring side effects.
/**
 * @deprecated Canonical implementation moved to @core/services/meeting/transcription.
 * This cloud file remains as a compatibility shim + cloud wiring.
 */

import { setMeetingTranscriptionAudioOps } from '@core/services/meeting/transcription';
import {
  findLastSilenceInTail,
  concatAudioFiles,
  splitAudioAtOffset,
} from './silenceBoundaryService';

setMeetingTranscriptionAudioOps({
  findLastSilenceInTail,
  concatAudioFiles,
  splitAudioAtOffset,
});

export * from '@core/services/meeting/transcription';
