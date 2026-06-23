import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '@renderer/components/ui';
import { useAudioLevelMeter } from '@renderer/features/voice/hooks/useAudioLevelMeter';

export interface UseQuickCaptureResult {
  isRecording: boolean;
  isTranscribing: boolean;
  audioLevel: number;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
}

type QuickCaptureStartResponse = {
  success: boolean;
  error?: string;
};

type QuickCaptureStopResponse = {
  success: boolean;
  duration?: number;
  transcriptPath?: string;
  error?: string;
};

type QuickCaptureStopRequest = {
  audio: ArrayBuffer;
  mimeType: string;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- preload bridge augments window with a domain API not declared in the base Window type
const getQuickCaptureApi = () => (window as any).quickCaptureApi as {
  start: (request: undefined) => Promise<QuickCaptureStartResponse>;
  stop: (request: QuickCaptureStopRequest) => Promise<QuickCaptureStopResponse>;
} | undefined;

async function invokeQuickCaptureStart(): Promise<QuickCaptureStartResponse> {
  const api = getQuickCaptureApi();
  if (!api) throw new Error('Quick Capture is not available.');
  return api.start(undefined);
}

async function invokeQuickCaptureStop(payload: QuickCaptureStopRequest): Promise<QuickCaptureStopResponse> {
  const api = getQuickCaptureApi();
  if (!api) throw new Error('Quick Capture is not available.');
  return api.stop(payload);
}

function toErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof DOMException && error.message) {
    return error.message;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

export function useQuickCapture(): UseQuickCaptureResult {
  const { showToast } = useToast();

  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [activeStream, setActiveStream] = useState<MediaStream | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mainCaptureStartedRef = useRef(false);
  const mountedRef = useRef(true);
  const isStoppingRef = useRef(false);

  const { level: audioLevel } = useAudioLevelMeter(activeStream);

  const clearRecorderState = useCallback(() => {
    mediaRecorderRef.current = null;
    chunksRef.current = [];
  }, []);

  const releaseStream = useCallback(() => {
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.onended = null;
        track.stop();
      }
      streamRef.current = null;
    }

    if (mountedRef.current) {
      setActiveStream(null);
    }
  }, []);

  const stopRecording = useCallback(async () => {
    if (isStoppingRef.current) {
      return;
    }

    isStoppingRef.current = true;

    try {
      const recorder = mediaRecorderRef.current;
      if (!recorder) {
        releaseStream();
        clearRecorderState();
        mainCaptureStartedRef.current = false;

        if (mountedRef.current) {
          setIsRecording(false);
          setIsTranscribing(false);
        }
        return;
      }

      if (recorder.state !== 'inactive') {
        const stopPromise = new Promise<void>((resolve) => {
          recorder.addEventListener('stop', () => resolve(), { once: true });
        });

        recorder.stop();
        await stopPromise;
      }

      const mimeType = recorder.mimeType || chunksRef.current[0]?.type || 'audio/webm';
      const blob = new Blob(chunksRef.current, { type: mimeType });

      releaseStream();
      clearRecorderState();

      if (mountedRef.current) {
        setIsRecording(false);
      }

      if (!mainCaptureStartedRef.current) {
        return;
      }

      if (mountedRef.current) {
        setIsTranscribing(true);
      }

      try {
        const result = await invokeQuickCaptureStop({
          audio: await blob.arrayBuffer(),
          mimeType,
        });

        if (!result.success || result.error) {
          showToast({
            title: 'Quick Capture failed',
            description: result.error ?? 'Could not transcribe this recording.',
            variant: 'error',
          });
        }
      } catch (error) {
        showToast({
          title: 'Quick Capture failed',
          description: toErrorMessage(error, 'Could not stop and process the recording.'),
          variant: 'error',
        });
      } finally {
        mainCaptureStartedRef.current = false;
        if (mountedRef.current) {
          setIsTranscribing(false);
        }
      }
    } finally {
      isStoppingRef.current = false;
    }
  }, [clearRecorderState, releaseStream, showToast]);

  const startRecording = useCallback(async () => {
    if (isRecording || isTranscribing) {
      return;
    }

    mainCaptureStartedRef.current = false;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      if (!mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      const recorder = new MediaRecorder(stream);
      streamRef.current = stream;
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];
      setActiveStream(stream);

      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      });

      recorder.addEventListener('error', () => {
        showToast({
          title: 'Quick Capture stopped',
          description: 'The microphone recording ended unexpectedly.',
          variant: 'error',
        });
        void stopRecording();
      });

      for (const track of stream.getAudioTracks()) {
        track.onended = () => {
          if (!isStoppingRef.current) {
            void stopRecording();
          }
        };
      }

      recorder.start();
      setIsRecording(true);

      const startResult = await invokeQuickCaptureStart();
      if (!startResult.success) {
        if (recorder.state !== 'inactive') {
          const stopPromise = new Promise<void>((resolve) => {
            recorder.addEventListener('stop', () => resolve(), { once: true });
          });
          recorder.stop();
          await stopPromise;
        }

        releaseStream();
        clearRecorderState();
        setIsRecording(false);

        showToast({
          title: 'Could not start Quick Capture',
          description: startResult.error ?? 'Please try again.',
          variant: 'error',
        });
        return;
      }

      mainCaptureStartedRef.current = true;
    } catch (error) {
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {
          // Ignore stop errors during failure cleanup.
        }
      }

      releaseStream();
      clearRecorderState();
      mainCaptureStartedRef.current = false;
      setIsRecording(false);
      setIsTranscribing(false);

      showToast({
        title: 'Could not access microphone',
        description: toErrorMessage(error, 'Please check microphone permissions and try again.'),
        variant: 'error',
      });
    }
  }, [clearRecorderState, isRecording, isTranscribing, releaseStream, showToast, stopRecording]);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      mainCaptureStartedRef.current = false;

      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {
          // Ignore stop errors while unmounting.
        }
      }

      releaseStream();
      clearRecorderState();
      isStoppingRef.current = false;
    };
  }, [clearRecorderState, releaseStream]);

  return {
    isRecording,
    isTranscribing,
    audioLevel,
    startRecording,
    stopRecording,
  };
}
