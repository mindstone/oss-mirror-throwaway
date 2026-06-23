import { useCallback, useState } from 'react';
import { FlaskConical, Key, Sparkles, FileText, Compass } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
  Button,
} from './ui';
import styles from './DemoModeDialog.module.css';

interface DemoModeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  showToast?: (options: { title: string; description?: string; variant?: 'default' | 'error' }) => void;
  /** If true, we're restarting demo mode (already in demo) */
  isRestart?: boolean;
}

type DemoOption = 'keep-keys' | 'fresh-start';

export const DemoModeDialog = ({ open, onOpenChange, showToast, isRestart = false }: DemoModeDialogProps) => {
  const [selectedOption, setSelectedOption] = useState<DemoOption>('keep-keys');
  const [seedMockContent, setSeedMockContent] = useState(true);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [isStarting, setIsStarting] = useState(false);

  const handleClose = useCallback(() => {
    if (!isStarting) {
      onOpenChange(false);
    }
  }, [onOpenChange, isStarting]);

  const handleStartDemo = useCallback(async () => {
    setIsStarting(true);
    try {
      const keepApiKeys = selectedOption === 'keep-keys';
      const result = await window.demoApi.enter({ keepApiKeys, seedMockContent, showOnboarding });
      
      if (!result.success) {
        console.error('Failed to start demo mode:', result.error);
        showToast?.({
          title: "Couldn't start demo mode",
          description: result.error ?? 'An unexpected error occurred',
          variant: 'error',
        });
        setIsStarting(false);
      }
      // If successful, app will restart (or spawn new terminal in dev mode)
    } catch (error) {
      console.error('Error starting demo mode:', error);
      showToast?.({
        title: "Couldn't start demo mode",
        description: error instanceof Error ? error.message : 'An unexpected error occurred',
        variant: 'error',
      });
      setIsStarting(false);
    }
  }, [selectedOption, seedMockContent, showOnboarding, showToast]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader onClose={handleClose}>
          <DialogTitle className={styles.title}>
            <FlaskConical className={styles.titleIcon} />
            {isRestart ? 'Restart Demo Mode' : 'Start Demo Mode'}
          </DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className={styles.description}>
            Demo mode creates a temporary, isolated environment. Your real data stays untouched.
          </p>

          <div className={styles.options}>
            <button
              type="button"
              className={`${styles.optionCard} ${selectedOption === 'keep-keys' ? styles.selected : ''}`}
              onClick={() => setSelectedOption('keep-keys')}
              disabled={isStarting}
            >
              <div className={styles.optionIcon}>
                <Key size={24} />
              </div>
              <div className={styles.optionContent}>
                <h3 className={styles.optionTitle}>Keep my API keys</h3>
                <p className={styles.optionDescription}>
                  Start fresh but with your Claude, OpenAI, and ElevenLabs keys ready. 
                  Perfect for demos where you want to show real AI capabilities.
                </p>
              </div>
            </button>

            <button
              type="button"
              className={`${styles.optionCard} ${selectedOption === 'fresh-start' ? styles.selected : ''}`}
              onClick={() => setSelectedOption('fresh-start')}
              disabled={isStarting}
            >
              <div className={styles.optionIcon}>
                <Sparkles size={24} />
              </div>
              <div className={styles.optionContent}>
                <h3 className={styles.optionTitle}>Completely fresh start</h3>
                <p className={styles.optionDescription}>
                  Start with nothing configured. Perfect for showing the full onboarding 
                  experience from the very beginning.
                </p>
              </div>
            </button>
          </div>

          <label className={styles.mockContentOption}>
            <input
              type="checkbox"
              checked={seedMockContent}
              onChange={(e) => setSeedMockContent(e.target.checked)}
              disabled={isStarting}
              className={styles.mockContentCheckbox}
            />
            <FileText size={16} className={styles.mockContentIcon} />
            <span className={styles.mockContentLabel}>
              <strong>Include sample content</strong>
              <span className={styles.mockContentDescription}>
                Add fictional skills, memories, and team files for ACME Corp
              </span>
            </span>
          </label>

          <label className={styles.mockContentOption}>
            <input
              type="checkbox"
              checked={showOnboarding}
              onChange={(e) => setShowOnboarding(e.target.checked)}
              disabled={isStarting}
              className={styles.mockContentCheckbox}
            />
            <Compass size={16} className={styles.mockContentIcon} />
            <span className={styles.mockContentLabel}>
              <strong>Show onboarding</strong>
              <span className={styles.mockContentDescription}>
                Run the setup wizard instead of skipping to the main app
              </span>
            </span>
          </label>

          <p className={styles.note}>
            {isRestart 
              ? 'Rebel will restart with a fresh demo environment. Your current demo data will be discarded.'
              : 'Rebel will restart to enter demo mode. Exit anytime via the header buttons.'}
          </p>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={handleClose} disabled={isStarting}>
            Cancel
          </Button>
          <Button onClick={handleStartDemo} disabled={isStarting}>
            {isStarting ? (isRestart ? 'Restarting…' : 'Starting…') : (isRestart ? 'Restart Demo' : 'Start Demo')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
