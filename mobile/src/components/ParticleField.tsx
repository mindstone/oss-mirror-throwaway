import { useEffect, useMemo } from 'react';
import { View } from 'react-native';
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

type ParticleType = 'white' | 'blue' | 'purple';

type ParticleFieldProps = {
  count?: number;
};

type ParticleSpec = {
  id: number;
  x: number;
  y: number;
  size: number;
  delayMs: number;
  durationMs: number;
  type: ParticleType;
  travelY: number;
};

const PARTICLE_TYPES: ParticleType[] = ['white', 'blue', 'purple'];
const PARTICLE_COLORS: Record<ParticleType, string> = {
  white: '#ffffff',
  blue: '#c4b5fd',
  purple: '#a78bfa',
};

function randomBetween(min: number, max: number) {
  return Math.random() * (max - min) + min;
}

function randomType(): ParticleType {
  return PARTICLE_TYPES[Math.floor(Math.random() * PARTICLE_TYPES.length)];
}

function Particle({ particle }: { particle: ParticleSpec }) {
  const opacity = useSharedValue(0);
  const translateY = useSharedValue(0);

  useEffect(() => {
    const halfDuration = Math.round(particle.durationMs / 2);

    opacity.value = withDelay(
      particle.delayMs,
      withRepeat(
        withSequence(
          withTiming(0.85, { duration: halfDuration }),
          withTiming(0.2, { duration: halfDuration }),
        ),
        -1,
      ),
    );

    translateY.value = withDelay(
      particle.delayMs,
      withRepeat(
        withSequence(
          withTiming(-particle.travelY, { duration: halfDuration }),
          withTiming(particle.travelY, { duration: halfDuration }),
        ),
        -1,
      ),
    );

    return () => {
      // Explicit cleanup prevents infinite repeats from surviving unmount.
      cancelAnimation(opacity);
      cancelAnimation(translateY);
    };
  }, [opacity, particle.delayMs, particle.durationMs, particle.travelY, translateY]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateY.value }],
  }));

  return (
    <Animated.View
      style={[
        {
          position: 'absolute',
          left: `${particle.x}%`,
          top: `${particle.y}%`,
          width: particle.size,
          height: particle.size,
          borderRadius: 9999,
          backgroundColor: PARTICLE_COLORS[particle.type],
        },
        animatedStyle,
      ]}
    />
  );
}

export function ParticleField({ count = 25 }: ParticleFieldProps) {
  const reducedMotion = useReducedMotion();

  const particles = useMemo(() => {
    const safeCount = Math.max(0, Math.floor(count));

    return Array.from({ length: safeCount }, (_, id): ParticleSpec => ({
      id,
      x: randomBetween(0, 100),
      y: randomBetween(0, 100),
      size: randomBetween(2, 4),
      delayMs: randomBetween(0, 2200),
      durationMs: randomBetween(2600, 5000),
      type: randomType(),
      travelY: randomBetween(4, 12),
    }));
  }, [count]);

  if (reducedMotion) return null;

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
      {particles.map((particle) => (
        <Particle key={particle.id} particle={particle} />
      ))}
    </View>
  );
}
