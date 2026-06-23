import styles from './HomepageLoadingSkeleton.module.css';
import { LoadingTipOverlay } from './LoadingTipOverlay';

export function HomepageLoadingSkeleton() {
  return (
    <div className={styles.container} role="status" aria-live="polite" aria-busy="true" data-testid="homepage-loading-skeleton">
      <span className="visually-hidden">Loading homepage</span>
      <LoadingTipOverlay eyebrowLabel="Did you know?" />

      <div className={styles.shell}>
        <div className={styles.chromeBar}>
          <div className={styles.chromeLeft}>
            <div className={`${styles.skeletonLine} ${styles.brandMark}`} />
            <div className={`${styles.skeletonLine} ${styles.brandLabel}`} />
          </div>
          <div className={styles.chromeRight}>
            <div className={`${styles.skeletonLine} ${styles.chromeAction}`} />
            <div className={`${styles.skeletonLine} ${styles.chromeAction}`} />
          </div>
        </div>

        <div className={styles.chatStage}>
          <div className={`${styles.messageRow} ${styles.messageRowAssistant}`}>
            <div className={`${styles.messageBubble} ${styles.messageBubbleAssistant} ${styles.messageBubbleTall}`}>
              <div className={`${styles.skeletonLine} ${styles.lineTiny}`} />
              <div className={`${styles.skeletonLine} ${styles.lineLong}`} />
              <div className={`${styles.skeletonLine} ${styles.lineMedium}`} />
            </div>
          </div>

          <div className={`${styles.messageRow} ${styles.messageRowUser} ${styles.rowCompact}`}>
            <div className={`${styles.messageBubble} ${styles.messageBubbleUser} ${styles.messageBubbleCompact}`}>
              <div className={`${styles.skeletonLine} ${styles.lineUserMedium}`} />
            </div>
          </div>

          <div className={`${styles.messageRow} ${styles.messageRowAssistant} ${styles.rowLoose}`}>
            <div className={`${styles.messageBubble} ${styles.messageBubbleAssistant} ${styles.messageBubbleWide}`}>
              <div className={`${styles.skeletonLine} ${styles.lineShort}`} />
              <div className={`${styles.skeletonLine} ${styles.lineLong}`} />
              <div className={`${styles.skeletonLine} ${styles.lineLongSoft}`} />
              <div className={`${styles.skeletonLine} ${styles.lineMedium}`} />
              <div className={styles.inlineChips}>
                <div className={`${styles.skeletonLine} ${styles.inlineChip}`} />
                <div className={`${styles.skeletonLine} ${styles.inlineChip} ${styles.inlineChipWide}`} />
              </div>
            </div>
          </div>

          <div className={`${styles.messageRow} ${styles.messageRowUser}`}>
            <div className={`${styles.messageBubble} ${styles.messageBubbleUser} ${styles.messageBubbleMedium}`}>
              <div className={`${styles.skeletonLine} ${styles.lineUserWide}`} />
              <div className={`${styles.skeletonLine} ${styles.lineUserShort}`} />
            </div>
          </div>

          <div className={`${styles.messageRow} ${styles.messageRowAssistant} ${styles.rowCompact}`}>
            <div className={`${styles.messageBubble} ${styles.messageBubbleAssistant} ${styles.messageBubbleCompact}`}>
              <div className={`${styles.skeletonLine} ${styles.lineMedium}`} />
            </div>
          </div>
        </div>

        <div className={styles.composerArea}>
          <div className={styles.composerBar}>
            <div className={`${styles.skeletonLine} ${styles.composerInput}`} />
            <div className={`${styles.skeletonLine} ${styles.composerButton}`} />
          </div>
          <div className={styles.composerMeta}>
            <div className={`${styles.skeletonLine} ${styles.metaPill}`} />
            <div className={`${styles.skeletonLine} ${styles.metaPill} ${styles.metaPillWide}`} />
          </div>
        </div>
      </div>
    </div>
  );
}
