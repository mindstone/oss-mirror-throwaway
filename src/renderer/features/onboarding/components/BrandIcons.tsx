import gmailPng from '@renderer/assets/brand/gmail.png';
import outlookPng from '@renderer/assets/brand/outlook.png';
import outlookCalendarPng from '@renderer/assets/brand/outlook-calendar.png';
import googleDrivePng from '@renderer/assets/brand/google-drive.png';
import oneDrivePng from '@renderer/assets/brand/onedrive.png';
import slackPng from '@renderer/assets/brand/slack.png';
import teamsPng from '@renderer/assets/brand/teams.png';
import googleCalendarPng from '@renderer/assets/brand/google-calendar.png';
import styles from '../OnboardingWizard.module.css';

export const GmailIcon = ({ className }: { className?: string }) => (
  <img className={className} src={gmailPng} alt="" aria-hidden />
);

export const OutlookIcon = ({ className }: { className?: string }) => (
  <img className={className} src={outlookPng} alt="" aria-hidden />
);

export const OutlookCalendarIcon = ({ className }: { className?: string }) => (
  <img className={className} src={outlookCalendarPng} alt="" aria-hidden />
);

export const GoogleDriveIcon = ({ className }: { className?: string }) => (
  <img className={className} src={googleDrivePng} alt="" aria-hidden />
);

export const OneDriveIcon = ({ className }: { className?: string }) => (
  <img className={className} src={oneDrivePng} alt="" aria-hidden />
);

export const SlackIcon = ({ className }: { className?: string }) => (
  <img className={className} src={slackPng} alt="" aria-hidden />
);

export const TeamsIcon = ({ className }: { className?: string }) => (
  <img className={className} src={teamsPng} alt="" aria-hidden />
);

export const GoogleCalendarIcon = ({ className }: { className?: string }) => (
  <img className={className} src={googleCalendarPng} alt="" aria-hidden />
);

export const EmailLogoStack = () => (
  <div className={styles.brandStack} aria-hidden>
    <div className={`${styles.brandBubble} ${styles.brandPrimary}`}>
      <GmailIcon className={styles.brandIcon} />
    </div>
    <div className={`${styles.brandBubble} ${styles.brandSecondary}`}>
      <OutlookIcon className={styles.brandIcon} />
    </div>
  </div>
);

export const DriveLogoStack = () => (
  <div className={styles.brandStack} aria-hidden>
    <div className={`${styles.brandBubble} ${styles.brandPrimary}`}>
      <GoogleDriveIcon className={styles.brandIcon} />
    </div>
    <div className={`${styles.brandBubble} ${styles.brandSecondary}`}>
      <OneDriveIcon className={styles.brandIcon} />
    </div>
  </div>
);

export const CalendarLogoStack = () => (
  <div className={styles.brandStack} aria-hidden>
    <div className={`${styles.brandBubble} ${styles.brandPrimary}`}>
      <GoogleCalendarIcon className={styles.brandIcon} />
    </div>
    <div className={`${styles.brandBubble} ${styles.brandSecondary}`}>
      <OutlookCalendarIcon className={styles.brandIcon} />
    </div>
  </div>
);

export const ChatLogoStack = () => (
  <div className={styles.brandStack} aria-hidden>
    <div className={`${styles.brandBubble} ${styles.brandPrimary}`}>
      <SlackIcon className={styles.brandIcon} />
    </div>
    <div className={`${styles.brandBubble} ${styles.brandSecondary}`}>
      <TeamsIcon className={styles.brandIcon} />
    </div>
  </div>
);
