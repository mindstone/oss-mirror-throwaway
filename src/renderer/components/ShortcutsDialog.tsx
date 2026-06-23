import { useCallback } from 'react';
import { Compass, Mic, Type, Maximize2, FolderOpen, Inbox } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
} from './ui';
import styles from './ShortcutsDialog.module.css';

interface ShortcutsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl';

type ShortcutCategory = 'navigation' | 'voice' | 'text' | 'view' | 'workspace' | 'actions';

type Shortcut = {
  keys: string[];
  description: string;
  category: ShortcutCategory;
};

const SHORTCUTS: Shortcut[] = [
  { keys: [MOD, 'N'], description: 'New conversation', category: 'navigation' },
  { keys: [MOD, 'Shift', 'N'], description: 'Scratchpad', category: 'navigation' },
  { keys: [MOD, 'I'], description: 'Open Actions', category: 'navigation' },
  { keys: [MOD, 'Enter'], description: 'Done / Auto-done', category: 'navigation' },
  { keys: ['Ctrl', 'Tab'], description: 'Next session', category: 'navigation' },
  { keys: ['Ctrl', 'Shift', 'Tab'], description: 'Previous session', category: 'navigation' },
  { keys: ['Ctrl', 'Alt', 'Space'], description: 'Voice activation', category: 'voice' },
  { keys: ['Enter'], description: 'Stop recording', category: 'voice' },
  { keys: ['Esc'], description: 'Exit voice / Stop turn', category: 'voice' },
  { keys: [MOD, '↑'], description: 'Edit last message', category: 'text' },
  { keys: [isMac ? '⌥' : 'Alt', 'Enter'], description: 'Queue message (when busy; same as Enter)', category: 'text' },
  { keys: isMac ? ['Ctrl', '⌘', 'F'] : ['F11'], description: 'Fullscreen', category: 'view' },
  { keys: [MOD, '+'], description: 'Zoom in', category: 'view' },
  { keys: [MOD, '−'], description: 'Zoom out', category: 'view' },
  { keys: [MOD, '0'], description: 'Reset zoom', category: 'view' },
  { keys: [MOD, 'F'], description: 'Find in file', category: 'workspace' },
  { keys: [MOD, 'S'], description: 'Save file', category: 'workspace' },
  { keys: [MOD, 'Shift', 'O'], description: 'Go to heading', category: 'workspace' },
  { keys: [MOD, '\\'], description: 'Focus mode', category: 'workspace' },
  { keys: ['J'], description: 'Next item', category: 'actions' },
  { keys: ['K'], description: 'Previous item', category: 'actions' },
  { keys: ['Enter'], description: 'Execute CTA', category: 'actions' },
  { keys: ['D'], description: 'Mark as done', category: 'actions' },
  { keys: ['X'], description: 'Delete item', category: 'actions' },
  { keys: ['Space'], description: 'Toggle selection', category: 'actions' },
  { keys: [MOD, 'A'], description: 'Select all', category: 'actions' },
];

const CATEGORIES: { id: ShortcutCategory; label: string; icon: typeof Compass }[] = [
  { id: 'navigation', label: 'Navigation', icon: Compass },
  { id: 'actions', label: 'Actions', icon: Inbox },
  { id: 'voice', label: 'Voice', icon: Mic },
  { id: 'text', label: 'Editing', icon: Type },
  { id: 'workspace', label: 'Library', icon: FolderOpen },
  { id: 'view', label: 'View', icon: Maximize2 },
];

const KeyCombo = ({ keys }: { keys: string[] }) => (
  <span className={styles.keyCombo}>
    {keys.map((key, i) => (
      <kbd key={i} className={styles.key}>{key}</kbd>
    ))}
  </span>
);

export const ShortcutsDialog = ({ open, onOpenChange }: ShortcutsDialogProps) => {
  const handleClose = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader onClose={handleClose}>
          <DialogTitle>Keyboard Shortcuts</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div className={styles.grid}>
            {CATEGORIES.map(({ id, label, icon: Icon }) => {
              const shortcuts = SHORTCUTS.filter((s) => s.category === id);
              return (
                <div key={id} className={styles.category}>
                  <div className={styles.categoryHeader}>
                    <Icon size={14} className={styles.categoryIcon} />
                    <span className={styles.categoryLabel}>{label}</span>
                  </div>
                  <div className={styles.shortcuts}>
                    {shortcuts.map((shortcut, i) => (
                      <div key={i} className={styles.shortcut}>
                        <span className={styles.description}>{shortcut.description}</span>
                        <KeyCombo keys={shortcut.keys} />
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
};
