import { useEffect, useMemo } from 'react';
import { type ViewStyle, View } from 'react-native';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

type FloatingOrbsProps = {
  count?: number;
};

type OrbSpec = {
  id: number;
  x: number;
  y: number;
  size: number;
  color: string;
  delayMs: number;
  durationMs: number;
  driftX: number;
  driftY: number;
  minScale: number;
  maxScale: number;
};

const ORB_COLORS = ['rgba(139, 92, 246, 0.15)', 'rgba(196, 181, 253, 0.1)'] as const;

function randomBetween(min: number, max: number) {
  return Math.random() * (max - min) + min;
}

function Orb({ orb, reducedMotion }: { orb: OrbSpec; reducedMotion: boolean }) {
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const scale = useSharedValue(1);

  useEffect(() => {
    if (reducedMotion) {
      translateX.value = 0;
      translateY.value = 0;
      scale.value = 1;
    } else {
      const halfDuration = Math.round(orb.durationMs / 2);

      translateX.value = withDelay(
        orb.delayMs,
        withRepeat(
          withSequence(
            withTiming(orb.driftX, { duration: halfDuration }),
            withTiming(-orb.driftX, { duration: halfDuration }),
          ),
          -1,
        ),
      );

      translateY.value = withDelay(
        orb.delayMs,
        withRepeat(
          withSequence(
            withTiming(-orb.driftY, { duration: halfDuration }),
            withTiming(orb.driftY, { duration: halfDuration }),
          ),
          -1,
        ),
      );

      scale.value = withDelay(
        orb.delayMs,
        withRepeat(
          withSequence(
            withTiming(orb.maxScale, { duration: halfDuration }),
            withTiming(orb.minScale, { duration: halfDuration }),
          ),
          -1,
        ),
      );
    }

    return () => {
      // Cancel all loops so unmounted orbs never keep scheduling UI-thread work.
      cancelAnimation(translateX);
      cancelAnimation(translateY);
      cancelAnimation(scale);
    };
  }, [
    orb.delayMs,
    orb.driftX,
    orb.driftY,
    orb.durationMs,
    orb.maxScale,
    orb.minScale,
    reducedMotion,
    scale,
    translateX,
    translateY,
  ]);

  const animatedStyle = useAnimatedStyle<ViewStyle>(() => {
    const transforms: ViewStyle['transform'] = [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ];

    return { transform: transforms };
  });

  return (
    <Animated.View
      style={[
        {
          position: 'absolute',
          left: `${orb.x}%`,
          top: `${orb.y}%`,
          width: orb.size,
          height: orb.size,
          borderRadius: 9999,
          backgroundColor: orb.color,
        },
        animatedStyle,
      ]}
    />
  );
}

export function FloatingOrbs({ count = 2 }: FloatingOrbsProps) {
  const reducedMotion = useReducedMotion();

  const orbs = useMemo(() => {
    const safeCount = Math.max(0, Math.floor(count));

    return Array.from({ length: safeCount }, (_, id): OrbSpec => ({
      id,
      x: randomBetween(-15, 85),
      y: randomBetween(-10, 75),
      size: randomBetween(150, 250),
      color: ORB_COLORS[id % ORB_COLORS.length],
      delayMs: randomBetween(0, 4000),
      durationMs: randomBetween(30000, 48000),
      driftX: randomBetween(12, 28),
      driftY: randomBetween(10, 24),
      minScale: randomBetween(0.94, 0.98),
      maxScale: randomBetween(1.04, 1.1),
    }));
  }, [count]);

  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
      }}
    >
      {orbs.map((orb) => (
        <Orb key={orb.id} orb={orb} reducedMotion={reducedMotion} />
      ))}
    </View>
  );
}
