/**
 * Pause CSS animations when the app window is not the foreground window (FOX-3438).
 *
 * Animations run only when the app is visible AND focused; they are paused (via the
 * `app-hidden` / `app-unfocused` body classes, both bound to the same pause rule in
 * styles/index.css) when the window is hidden/minimized OR visible-but-unfocused.
 *
 * The unfocused case matters on macOS: a visible-but-unfocused window keeps
 * document.hidden === false, so always-mounted `infinite` CSS animations would otherwise
 * keep driving the compositor at vsync and peg the GPU even after the user tabbed away.
 *
 * Lives in its own module (rather than inline in App.tsx) so the visibility/focus wiring
 * is unit-testable in isolation — importing App.tsx pulls in heavy WebGL deps (three /
 * react-force-graph) that crash in the jsdom/happy-dom test environment.
 */
export function installAnimationPauseControls(
  doc: Document = document,
  win: Window = window,
): () => void {
  const handleVisibilityChange = () => {
    if (doc.hidden) {
      doc.body.classList.add('app-hidden');
    } else {
      doc.body.classList.remove('app-hidden');
    }
  };
  const handleBlur = () => {
    doc.body.classList.add('app-unfocused');
  };
  const handleFocus = () => {
    doc.body.classList.remove('app-unfocused');
  };

  // Set initial state. `document.hasFocus()` reflects whether the document currently has
  // focus, so we start paused if the app launched in the background/unfocused.
  handleVisibilityChange();
  if (doc.hasFocus()) {
    handleFocus();
  } else {
    handleBlur();
  }

  doc.addEventListener('visibilitychange', handleVisibilityChange);
  win.addEventListener('blur', handleBlur);
  win.addEventListener('focus', handleFocus);

  return () => {
    doc.removeEventListener('visibilitychange', handleVisibilityChange);
    win.removeEventListener('blur', handleBlur);
    win.removeEventListener('focus', handleFocus);
    // Clean up classes on unmount.
    doc.body.classList.remove('app-hidden');
    doc.body.classList.remove('app-unfocused');
  };
}
