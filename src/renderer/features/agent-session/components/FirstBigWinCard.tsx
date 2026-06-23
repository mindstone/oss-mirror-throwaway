import { useMemo } from 'react';
import { Clock } from 'lucide-react';
import './FirstBigWinCard.css';

const HEADLINES = [
  "Your day just got shorter.",
  "Two hours back.",
  "A meaningful dent.",
  "The ledger tips in your favor."
];

const QUIPS = [
  "Not bad for a first impression.",
  "The compound interest starts here.",
  "A meeting you didn't have to sit through.",
  "Your future self sends regards.",
  "This is what delegation feels like.",
  "The ROI math just got interesting."
];

const getRandomItem = <T,>(items: T[]): T => items[Math.floor(Math.random() * items.length)];

type FirstBigWinCardProps = {
  todayMinutes: number;
  onDismiss: () => void;
};

export const FirstBigWinCard = ({ todayMinutes, onDismiss }: FirstBigWinCardProps) => {
  const headline = useMemo(() => getRandomItem(HEADLINES), []);
  const quip = useMemo(() => getRandomItem(QUIPS), []);
  
  const displayValue = useMemo(() => {
    const hours = todayMinutes / 60;
    return hours < 10 ? hours.toFixed(1) : Math.round(hours).toString();
  }, [todayMinutes]);

  return (
    <div className="first-big-win-card">
      <div className="first-big-win-card__icon">
        <Clock size={20} />
      </div>
      <div className="first-big-win-card__content">
        <p className="first-big-win-card__headline">{headline}</p>
        <p className="first-big-win-card__stat">
          <span className="first-big-win-card__value">{displayValue}</span>
          <span className="first-big-win-card__unit">hours</span>
          <span className="first-big-win-card__label">reclaimed today</span>
        </p>
        <p className="first-big-win-card__quip">{quip}</p>
      </div>
      <button
        type="button"
        className="first-big-win-card__dismiss"
        onClick={onDismiss}
        aria-label="Dismiss"
      >
        Got it
      </button>
    </div>
  );
};
