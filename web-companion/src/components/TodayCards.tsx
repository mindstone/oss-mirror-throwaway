import { Link } from 'react-router-dom';
import { useTodayCards, type TodayCard } from '@rebel/cloud-client';
import { ShieldIcon, ZapIcon } from './icons';
import styles from './TodayCards.module.css';

function TodayCardRow({ card }: { card: TodayCard }) {
  const isApproval = card.type === 'approval';

  return (
    <div className={`${styles.card} ${isApproval ? styles.cardApproval : styles.cardInbox}`}>
      <div
        className={`${styles.iconWrap} ${
          isApproval ? styles.iconWrapApproval : styles.iconWrapInbox
        }`}
      >
        {isApproval ? (
          <ShieldIcon size={16} className={styles.iconApproval} />
        ) : (
          <ZapIcon size={16} className={styles.iconInbox} />
        )}
      </div>

      <div className={styles.cardBody}>
        <p className={styles.cardTitle}>{card.title}</p>
        <p className={styles.cardSubtitle}>{card.subtitle}</p>
      </div>

      <Link to={isApproval ? '/approvals' : '/inbox'} className={styles.ctaButton}>
        {card.ctaLabel}
      </Link>
    </div>
  );
}

export function TodayCards() {
  const { cards, totalCount, isLoading } = useTodayCards();

  if (isLoading || cards.length === 0) return null;

  return (
    <section className={styles.section} data-testid="home-today-cards">
      <h2 className={styles.sectionTitle}>Today</h2>

      <div className={styles.cards}>
        {cards.map((card) => (
          <TodayCardRow
            key={card.type === 'approval' ? 'approval' : card.item.id}
            card={card}
          />
        ))}
      </div>

      {totalCount > 3 && (
        <Link to="/inbox" className={styles.overflowLink}>
          See all {totalCount} items
        </Link>
      )}
    </section>
  );
}
