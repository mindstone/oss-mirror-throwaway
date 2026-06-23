// packages/shared/src/hooks/useSmoothStream.ts
// Canonical smooth-streaming hook — RAF-based animation that reveals streaming
// text at a steady rate rather than dumping raw chunks.
//
// Ported from desktop ConversationPane.tsx (2026-01-10 triple-review version).
// Includes render throttling and preserve-on-clear (fade-out) support.

import { useState, useEffect, useRef } from 'react';

/**
 * Smooths streaming text by revealing characters at a steady rate using
 * requestAnimationFrame. Decouples network chunks from visual display.
 *
 * Features:
 * - Time-based character reveal (not frame-count based, correct for variable frame rates)
 * - Render throttling: updates React state every 3rd frame (~20fps) to reduce
 *   downstream rendering cost (e.g., markdown re-parsing)
 * - Preserve-on-clear: when `preserveOnClear` is true, keeps current display
 *   text when rawText clears instead of resetting
 *
 * @param rawText - The full text received so far (grows as chunks arrive)
 * @param preserveOnClear - When true, preserves displayed text instead of
 *   resetting when rawText clears. Desktop: pass `isFadingOut` to preserve
 *   during visual fade-out transitions. Cloud/mobile: pass `isStreaming` /
 *   `isSending` to preserve during active stream.
 * @param speed - Milliseconds per character (default 5). Lower = faster.
 *   Desktop uses 5 (~200 chars/sec), cloud/mobile uses 7 (~143 chars/sec).
 * @returns The animated text to display (a prefix of rawText)
 */
export function useSmoothStream(
  rawText: string | undefined,
  preserveOnClear: boolean,
  speed = 5,
): string {
  const [displayText, setDisplayText] = useState('');
  const indexRef = useRef(0);
  const frameRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number | null>(null);
  const frameCountRef = useRef(0);

  useEffect(() => {
    // Preserve displayed content during transitions (fade-out, active stream, etc.)
    if (!rawText && preserveOnClear) {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      return;
    }

    // Buffer cleared (not preserving) — reset completely
    if (!rawText) {
      setDisplayText('');
      indexRef.current = 0;
      lastTimeRef.current = null;
      frameCountRef.current = 0;
      return;
    }

    // Clamp index if rawText shrunk (edge case)
    if (indexRef.current > rawText.length) {
      indexRef.current = rawText.length;
    }

    // Already caught up — set directly, no animation needed
    if (indexRef.current >= rawText.length) {
      setDisplayText(rawText);
      return;
    }

    const animate = (time: number) => {
      if (lastTimeRef.current === null) {
        lastTimeRef.current = time;
      }

      const elapsed = time - lastTimeRef.current;
      const charsToAdvance = Math.floor(elapsed / speed);

      if (charsToAdvance > 0 && indexRef.current < rawText.length) {
        indexRef.current = Math.min(indexRef.current + charsToAdvance, rawText.length);
        lastTimeRef.current = time;
        frameCountRef.current++;
        // Only update React state every 3rd frame (~20fps) to reduce
        // downstream rendering cost (e.g., markdown re-parsing)
        if (frameCountRef.current % 3 === 0 || indexRef.current >= rawText.length) {
          setDisplayText(rawText.slice(0, indexRef.current));
        }
      }

      if (indexRef.current < rawText.length) {
        frameRef.current = requestAnimationFrame(animate);
      } else {
        setDisplayText(rawText.slice(0, indexRef.current));
      }
    };

    frameRef.current = requestAnimationFrame(animate);

    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, [rawText, preserveOnClear, speed]);

  return displayText;
}
