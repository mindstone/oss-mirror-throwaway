---
description: "Renderer animation patterns — CSS particles, canvas starfields, gradients, Lottie assets, pausing and frame-rate limits"
last_updated: "2026-02-01"
---

# Animations

This document covers the ambient visual effects and animations used in Mindstone Rebel, their implementation patterns, and performance considerations.


## See Also

- [ONBOARDING_SETUP_WIZARD.md](ONBOARDING_SETUP_WIZARD.md) - Onboarding screens where animations are prominently featured
- [UI_OVERVIEW.md](UI_OVERVIEW.md) - Overall UI layout and interaction design
- `src/renderer/features/onboarding/` - Onboarding components with CSS particle animations
- `src/renderer/styles/layout/app-shell.css` - Aurora background drift animations


## Animation Types

### 1. CSS Particle Animations (Twinkle Stars)

**Location:** `src/renderer/features/onboarding/UseCaseReveal.module.css` and other onboarding CSS modules

Lightweight CSS-only twinkling star effect used as background ambiance. Particles are positioned absolutely with randomized delays and durations.

```css
.particle {
  animation: twinkle 2.6s ease-in-out infinite;
}
@keyframes twinkle {
  0% { transform: translateY(0px) scale(0.8); opacity: 0; }
  10% { opacity: 0.9; }
  50% { transform: translateY(-52px) scale(1.08); opacity: 0.75; }
  80% { opacity: 0.0; }
  100% { transform: translateY(-160px) scale(0.9); opacity: 0; }
}
```

**Used in:**
- Onboarding screens (welcome step, use case reveal)

### 2. Canvas Starfield (Orbiting Stars)

**Pattern:** `requestAnimationFrame`-based canvas animations

More sophisticated animation using `requestAnimationFrame` and HTML5 Canvas. Stars orbit around anchor points with varying speeds, sizes, and twinkle phases. This pattern is used in onboarding and other ambient animations.

**Key features:**
- Frame rate limited to 30fps for battery efficiency
- Uses radial gradients for soft glow effects
- Dynamically responds to component state

### 3. Background Gradients

**Location:** `src/renderer/styles/layout/app-shell.css`

Static gradient backgrounds provide visual depth. The app shell uses layered gradients for ambient visual effects. Note: Animated aurora drift was previously used but has been simplified to static gradients for performance.

### 4. Lottie Animation (Voice Orb)

**Asset location:** `src/renderer/assets/animations/voice-orb.lottie`

Vector animation asset for voice mode orb. Note: This asset is available for future use but may not be actively integrated in the current UI.


## Performance Optimization

### Visibility-Based Pausing

Canvas animations pause when the document is hidden to save CPU:

```typescript
const loop = useCallback((timestamp: number) => {
  // Pause animation when document is hidden (save CPU)
  if (document.hidden) {
    rafRef.current = window.requestAnimationFrame(loop);
    return;
  }
  // ... animation logic
}, []);
```

**Applied to:**
- Onboarding canvas animations
- `useAudioLevelMeter.ts` - audio visualization

### Frame Rate Limiting

All canvas animations are throttled to 30fps:

```typescript
const FRAME_INTERVAL_MS = 1000 / 30; // ~33ms between frames

if (timestamp - lastFrameRef.current < FRAME_INTERVAL_MS) {
  rafRef.current = window.requestAnimationFrame(loop);
  return;
}
```

### CSS Animation Optimization

- Use `will-change: transform, opacity` sparingly on animated elements
- Avoid animating layout properties (width, height, top, left)
- Prefer `transform` and `opacity` for GPU-accelerated animations
- CSS animations are automatically throttled by browsers when tabs are hidden

### Reduced Motion Support

All animations respect the user's motion preferences:

```css
@media (prefers-reduced-motion: reduce) {
  .morphBlob { animation: none; }
  .particle { animation: none !important; }
}
```


## Implementation Patterns

### Adding a New Canvas Animation

1. Create refs for canvas, animation frame ID, and any persistent state:
   ```typescript
   const canvasRef = useRef<HTMLCanvasElement | null>(null);
   const rafRef = useRef<number | null>(null);
   ```

2. Implement the animation loop with visibility and frame rate checks:
   ```typescript
   const loop = useCallback((timestamp: number) => {
     if (document.hidden) {
       rafRef.current = requestAnimationFrame(loop);
       return;
     }
     // Frame rate limiting...
     // Drawing logic...
     rafRef.current = requestAnimationFrame(loop);
   }, [dependencies]);
   ```

3. Clean up on unmount:
   ```typescript
   useEffect(() => {
     rafRef.current = requestAnimationFrame(loop);
     return () => {
       if (rafRef.current) cancelAnimationFrame(rafRef.current);
     };
   }, [loop]);
   ```

### Adding CSS Particle Effects

1. Generate particles with randomized positions in a `useMemo`:
   ```typescript
   const particles = useMemo(() => {
     return new Array(count).fill(0).map((_, i) => ({
       key: i,
       left: Math.random() * 100,
       top: Math.random() * 100,
       delay: Math.random() * 3.5
     }));
   }, []);
   ```

2. Render with inline styles for position/delay:
   ```tsx
   <div className={styles.particles} aria-hidden>
     {particles.map((p) => (
       <div
         key={p.key}
         className={styles.particle}
         style={{ left: `${p.left}%`, top: `${p.top}%`, animationDelay: `${p.delay}s` }}
       />
     ))}
   </div>
   ```


## Troubleshooting

### High CPU Usage

1. Verify canvas animations check `document.hidden`
2. Confirm frame rate limiting is in place (30fps target)
3. Check for animations running on hidden/unmounted components
4. Use browser DevTools Performance tab to profile

### Animations Not Pausing

- CSS animations: Modern browsers auto-throttle in hidden tabs
- Canvas animations: Check for `document.hidden` check at start of loop
- Ensure cleanup runs on component unmount

### Janky/Stuttering Animations

- Increase frame interval (lower fps target)
- Reduce particle count
- Simplify canvas drawing operations
- Verify no synchronous heavy operations in animation loop
