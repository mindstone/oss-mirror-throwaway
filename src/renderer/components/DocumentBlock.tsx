import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from 'react';
import { FileText, Copy, Check, Save } from 'lucide-react';
import { SafeMarkdown } from '@renderer/components/SafeMarkdown';
import { Tabs, TabsList, TabsTrigger } from '@renderer/components/ui/Tabs';
import { SplitButton } from '@renderer/components/ui/SplitButton';
import { Button } from '@renderer/components/ui/Button';
import { Tooltip } from '@renderer/components/ui/Tooltip';
import { writeFileOrFail } from '@renderer/utils/libraryWrites';
import styles from './DocumentBlock.module.css';

interface DocumentBlockProps {
  content: string;
  language: string;
  showToast?: (options: { title: string }) => void;
  coreDirectory?: string;
}

type ViewMode = 'preview' | 'markdown';
type FeedbackTarget = 'markdown-copy' | 'text-copy' | 'save' | null;

const FEEDBACK_DURATION_MS = 1500;
const DOCUMENT_CLAMP_HEIGHT_PX = 640;
const NEW_FILE_SENTINEL_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

const stripMarkdownSyntax = (text: string): string => {
  return text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/!\[([^\]]*)]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
};

const getTitleCandidate = (content: string): string => {
  const lines = content.split(/\r?\n/);
  const heading = lines.find((line) => /^#{1,6}\s+\S/.test(line.trim()));
  if (heading) {
    return heading.trim().replace(/^#{1,6}\s+/, '');
  }
  return lines.find((line) => line.trim().length > 0)?.trim() ?? 'document-draft';
};

const buildDefaultFilename = (content: string): string => {
  const candidate = stripMarkdownSyntax(getTitleCandidate(content))
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim();

  const baseName = candidate || 'document-draft';
  return baseName.toLowerCase().endsWith('.md') ? baseName : `${baseName}.md`;
};

export const DocumentBlock = memo(function DocumentBlock({
  content,
  language,
  showToast,
  coreDirectory,
}: DocumentBlockProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('preview');
  const [isExpanded, setIsExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [feedbackTarget, setFeedbackTarget] = useState<FeedbackTarget>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const feedbackTimerRef = useRef<number | null>(null);

  const normalizedLanguage = language.trim().toLowerCase() || 'plain';
  const defaultName = useMemo(() => buildDefaultFilename(content), [content]);
  const isClamped = !isExpanded;

  const showFeedback = useCallback((target: FeedbackTarget) => {
    setFeedbackTarget(target);
    if (feedbackTimerRef.current !== null) {
      window.clearTimeout(feedbackTimerRef.current);
    }
    feedbackTimerRef.current = window.setTimeout(() => {
      setFeedbackTarget(null);
      feedbackTimerRef.current = null;
    }, FEEDBACK_DURATION_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current !== null) {
        window.clearTimeout(feedbackTimerRef.current);
      }
    };
  }, []);

  const measureOverflow = useCallback(() => {
    const node = contentRef.current;
    if (!node) return;
    setIsOverflowing(node.scrollHeight > DOCUMENT_CLAMP_HEIGHT_PX + 1);
  }, []);

  useEffect(() => {
    measureOverflow();
    const node = contentRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(measureOverflow);
    observer.observe(node);
    return () => observer.disconnect();
  }, [content, measureOverflow, viewMode]);

  const stopToolbarEvent = useCallback((event: MouseEvent<HTMLElement>) => {
    event.stopPropagation();
  }, []);

  const handleCopyMarkdown = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(content);
      showFeedback('markdown-copy');
    } catch (error) {
      console.error('Failed to copy document markdown:', error);
      showToast?.({ title: "Couldn't copy that Markdown" });
    }
  }, [content, showFeedback, showToast]);

  const handleCopyText = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(stripMarkdownSyntax(content));
      showFeedback('text-copy');
    } catch (error) {
      console.error('Failed to copy document text:', error);
      showToast?.({ title: "Couldn't copy that text" });
    }
  }, [content, showFeedback, showToast]);

  const handleSave = useCallback(async () => {
    if (!coreDirectory) {
      showToast?.({ title: 'Choose a workspace before saving' });
      return;
    }

    try {
      const result = await writeFileOrFail({
        path: defaultName,
        content,
        baseContentHash: NEW_FILE_SENTINEL_HASH,
      });
      if (result.result === 'conflict') {
        showToast?.({ title: 'Save failed: a file with that name already exists' });
        return;
      }
      showFeedback('save');
      showToast?.({ title: 'Document saved' });
    } catch (error) {
      console.error('Failed to save document draft:', error);
      showToast?.({ title: "Couldn't save that document" });
    }
  }, [content, coreDirectory, defaultName, showFeedback, showToast]);

  const handleSaveAs = useCallback(async () => {
    try {
      const result = await window.appApi.saveTextAs({ content, defaultName });
      if (!result.saved) return;
      showFeedback('save');
      showToast?.({ title: 'Document saved' });
    } catch (error) {
      console.error('Failed to save document draft as:', error);
      showToast?.({ title: "Couldn't save that document" });
    }
  }, [content, defaultName, showFeedback, showToast]);

  return (
    <section className={styles.card} data-language={normalizedLanguage}>
      <header
        className={styles.toolbar}
        onClick={stopToolbarEvent}
        onMouseDown={stopToolbarEvent}
      >
        <div className={styles.titleGroup}>
          <FileText size={16} strokeWidth={2} aria-hidden />
          <span>Document draft</span>
        </div>

        <Tabs value={viewMode} onValueChange={(value) => setViewMode(value as ViewMode)} className={styles.tabs}>
          <TabsList variant="default" className={styles.tabsList}>
            <TabsTrigger value="preview" className={styles.tabTrigger}>
              Preview
            </TabsTrigger>
            <TabsTrigger value="markdown" className={styles.tabTrigger}>
              Markdown
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <div className={styles.actions}>
          <Tooltip content={feedbackTarget === 'markdown-copy' ? 'Copied' : 'Copy raw Markdown'} delayShow={300}>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={styles.actionButton}
              onClick={(event) => {
                event.stopPropagation();
                void handleCopyMarkdown();
              }}
            >
              {feedbackTarget === 'markdown-copy' ? <Check aria-hidden /> : <Copy aria-hidden />}
              <span>Copy as Markdown</span>
            </Button>
          </Tooltip>

          <Tooltip content={feedbackTarget === 'text-copy' ? 'Copied' : 'Copy readable text'} delayShow={300}>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={styles.actionButton}
              onClick={(event) => {
                event.stopPropagation();
                void handleCopyText();
              }}
            >
              {feedbackTarget === 'text-copy' ? <Check aria-hidden /> : <Copy aria-hidden />}
              <span>Copy as Text</span>
            </Button>
          </Tooltip>

          <SplitButton
            size="sm"
            variant="outline"
            onClick={() => {
              void handleSave();
            }}
            dropdownItems={[
              {
                label: 'Save as...',
                icon: Save,
                onClick: () => {
                  void handleSaveAs();
                },
              },
            ]}
          >
            {feedbackTarget === 'save' ? <Check size={14} aria-hidden /> : <Save size={14} aria-hidden />}
            <span>{feedbackTarget === 'save' ? 'Saved' : 'Save'}</span>
          </SplitButton>
        </div>
      </header>

      <div className={styles.body}>
        <div
          ref={contentRef}
          className={styles.content}
          data-clamped={isClamped ? 'true' : undefined}
        >
          {viewMode === 'preview' ? (
            <SafeMarkdown className="document-block-preview" breaks>{content}</SafeMarkdown>
          ) : (
            <pre className={styles.rawPre}>
              <code>{content}</code>
            </pre>
          )}
          {isOverflowing && isClamped && <div className={styles.fade} aria-hidden />}
        </div>

        {isOverflowing && (
          <div className={styles.expandRow}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={styles.expandButton}
              onClick={(event) => {
                event.stopPropagation();
                setIsExpanded((current) => !current);
              }}
            >
              {isExpanded ? 'Show less' : 'Show full document'}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
});

DocumentBlock.displayName = 'DocumentBlock';
