import type { ReactNode } from 'react';
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody } from '@renderer/components/ui';
import styles from './ClaudeMaxSetupDialog.module.css';

const ANTHROPIC_CONSOLE_URL = 'https://platform.claude.com/settings/keys';

interface ClaudeMaxSetupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface StepProps {
  title: string;
  children: ReactNode;
}

const Step = ({ title, children }: StepProps) => (
  <section className={styles.instructionStep}>
    <h3 className={styles.stepTitle}>{title}</h3>
    <div className={styles.stepBody}>{children}</div>
  </section>
);

const openAnthropicConsole = () => {
  window.open(ANTHROPIC_CONSOLE_URL, '_blank', 'noopener,noreferrer');
};

export function ClaudeMaxSetupDialog({ open, onOpenChange }: ClaudeMaxSetupDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader onClose={() => onOpenChange(false)}>
          <DialogTitle>How to create an API key</DialogTitle>
        </DialogHeader>

        <DialogBody className={styles.dialogBody}>
          <p className={styles.intro}>
            To connect Rebel to Claude, you need an API key from Anthropic. It&apos;s free to create and takes about
            30 seconds.
          </p>

          <div className={styles.platformInstructions}>
            <Step title="Step 1: Open the Anthropic Console">
              <p>Click the button below to open the API key page in your browser.</p>
              <div>
                <Button type="button" variant="outline" size="sm" onClick={openAnthropicConsole}>
                  Open Anthropic Console
                </Button>
              </div>
            </Step>

            <Step title="Step 2: Sign in or create an account">
              <p>If you already have an Anthropic account, sign in. If not, create one — it&apos;s free.</p>
            </Step>

            <Step title="Step 3: Create a new key">
              <p>Click &quot;Create Key&quot; and name it &quot;Rebel&quot; (or anything you&apos;ll recognize later).</p>
            </Step>

            <Step title="Step 4: Copy the key">
              <p>
                Click the copy icon next to your new key. It starts with <code>sk-ant-</code>.
              </p>
              <p className={styles.callout}>Treat this key like a password — don&apos;t share it.</p>
            </Step>

            <Step title="Step 5: Paste it in Rebel">
              <p>Come back here and paste the key into the API key field. Rebel validates it automatically.</p>
            </Step>
          </div>

          <section className={styles.troubleshootingSection}>
            <h3>Common questions</h3>

            <div className={styles.troubleshootingItem}>
              <h4>Do I need a subscription?</h4>
              <p>No. API keys work with a regular Anthropic account — no Claude subscription required.</p>
            </div>

            <div className={styles.troubleshootingItem}>
              <h4>How much does it cost?</h4>
              <p>Most conversations land somewhere around $0.05-$0.50 depending on length and model usage.</p>
            </div>

            <div className={styles.troubleshootingItem}>
              <h4>What if I need a new key later?</h4>
              <p>You can create another one in the Anthropic Console and paste the new key into Rebel.</p>
            </div>
          </section>


        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
