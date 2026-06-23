import { useCallback, useEffect, useState, useRef } from 'react';
import { Sparkles, ChevronDown, Wrench, Info } from 'lucide-react';
// ESLINT-ALLOW-LIST NOTE: This file is on the allow-list in eslint.config.mjs
// for @typescript-eslint/no-restricted-imports (react-markdown). If you rename
// this file, update the allow-list in Stage F.
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import {
  createGuardedUrlTransform,
  findBlockedUrlScheme,
  preprocessMarkdownForRender,
  redactUrlForLogging,
} from '@rebel/shared';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
  Button,
  Tooltip,
} from './ui';
import { getAuthorAvatar } from '@renderer/features/whats-new/utils/teamAvatars';
import { tracking } from '@renderer/src/tracking';
import { 
  parseChangelogSections, 
  type ChangelogSection, 
  type ChangelogHighlight 
} from '@renderer/features/whats-new/utils/changelogParser';
import styles from './WhatsNewDialog.module.css';

const guardedUrlTransform = createGuardedUrlTransform(defaultUrlTransform);

interface WhatsNewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentVersion?: string;
  /** Callback when user clicks a highlight card to try the feature */
  onTryFeature?: (highlight: ChangelogHighlight) => void;
}

const InlineMarkdown = ({ children }: { children: string }) => {
  const { source, remarkPlugins } = preprocessMarkdownForRender(children);
  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      urlTransform={guardedUrlTransform}
      components={{
        p: ({ children }) => <>{children}</>,
        a: ({ href, title, children }) => {
          const blockedScheme = findBlockedUrlScheme(href);
          if (blockedScheme) {
            console.warn('[Renderer] WhatsNewDialog markdown link blocked (dangerous scheme)', {
              scheme: blockedScheme,
              href: redactUrlForLogging(href),
            });
            return <a>{children}</a>;
          }
          return <a href={href} title={title}>{children}</a>;
        },
        img: ({ src, alt }) => {
          const blockedScheme = findBlockedUrlScheme(src);
          if (blockedScheme) {
            console.warn('[Renderer] WhatsNewDialog markdown image blocked (dangerous scheme)', {
              scheme: blockedScheme,
              src: redactUrlForLogging(src),
            });
            return <img hidden alt={alt || 'Blocked image'} />;
          }
          return <img src={src} alt={alt} />;
        },
        strong: ({ children }) => <strong>{children}</strong>,
        em: ({ children }) => <em className={styles.emphasis}>{children}</em>,
        code: ({ children }) => <code className={styles.inlineCode}>{children}</code>,
      }}
    >
      {source}
    </ReactMarkdown>
  );
};

const VersionSection = ({ 
  section, 
  index,
  isLatest,
  onTryFeature,
  onFeatureViewed,
}: { 
  section: ChangelogSection; 
  index: number;
  isLatest: boolean;
  onTryFeature?: (highlight: ChangelogHighlight) => void;
  onFeatureViewed?: () => void;
}) => {
  const [moreExpanded, setMoreExpanded] = useState(false);
  const hasMore = section.improvements.length > 0;

  return (
    <div
      className={`${styles.versionSection} ${section.isCurrentVersion ? styles.currentVersion : ''}`}
      style={{ animationDelay: `${index * 80}ms` }}
    >
      <div className={styles.versionHeader}>
        <div className={styles.versionMeta}>
          <span className={styles.versionBadge}>
            {section.version}
            {section.isCurrentVersion && (
              <span className={styles.currentLabel}>current</span>
            )}
          </span>
          {section.date && <span className={styles.versionDate}>{section.date}</span>}
        </div>
      </div>

      {section.highlights.length > 0 && (
        <div className={styles.highlightsGrid}>
          {section.highlights.slice(0, isLatest ? 6 : 3).map((highlight, i) => (
            <button 
              type="button"
              key={i} 
              className={`${styles.highlightCard} ${onTryFeature ? styles.highlightCardClickable : ''}`}
              style={{ animationDelay: `${(index * 80) + (i * 40)}ms` }}
              onClick={() => {
                tracking.whatsNew.featureClicked(highlight.title, `${section.version}-${i}`);
                onFeatureViewed?.();
                onTryFeature?.(highlight);
              }}
              disabled={!onTryFeature}
              aria-label={`Try feature: ${highlight.title}${highlight.author ? ` by ${highlight.author}` : ''}`}
            >
              <div className={styles.highlightTitle}>
                {highlight.title}
                {highlight.detail && (
                  <Tooltip
                    content={highlight.detail}
                    placement="top"
                    maxWidth="400px"
                    delayShow={300}
                    clickToToggle
                  >
                    <span
                      className={styles.detailIcon}
                      onClick={(e) => e.stopPropagation()}
                      role="button"
                      tabIndex={0}
                      aria-label="More details"
                    >
                      <Info size={14} />
                    </span>
                  </Tooltip>
                )}
              </div>
              {highlight.description && (
                <div className={styles.highlightDesc}>
                  <InlineMarkdown>{highlight.description}</InlineMarkdown>
                </div>
              )}
              {highlight.author && (
                <div className={styles.authorAttribution}>
                  <img 
                    src={getAuthorAvatar(highlight.author)} 
                    alt=""
                    className={styles.authorAvatar}
                  />
                  <span className={styles.authorName}>Built by <strong>{highlight.author}</strong></span>
                </div>
              )}
            </button>
          ))}
        </div>
      )}

      {hasMore && (
        <div className={styles.moreSection}>
          <button
            className={`${styles.moreToggle} ${moreExpanded ? styles.moreToggleExpanded : ''}`}
            onClick={() => setMoreExpanded(!moreExpanded)}
            aria-expanded={moreExpanded}
          >
            <Wrench size={14} className={styles.moreIcon} />
            <span>{section.improvements.length} more improvement{section.improvements.length !== 1 ? 's' : ''}</span>
            <ChevronDown size={14} className={styles.chevron} />
          </button>
          
          {moreExpanded && (
            <ul className={styles.improvementsList}>
              {section.improvements.map((item, i) => (
                <li key={i} style={{ animationDelay: `${i * 30}ms` }}>
                  <InlineMarkdown>{item}</InlineMarkdown>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};

const INITIAL_VERSIONS = 3;
const LOAD_MORE_COUNT = 5;

export const WhatsNewDialog = ({ open, onOpenChange, currentVersion, onTryFeature }: WhatsNewDialogProps) => {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(INITIAL_VERSIONS);
  
  // Track session stats
  const sessionStartRef = useRef<number>(0);
  const featuresViewedRef = useRef<number>(0);

  useEffect(() => {
    if (open) {
      sessionStartRef.current = Date.now();
      featuresViewedRef.current = 0;
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const fetchChangelog = async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await window.miscApi.getChangelog();
        if (result.success && result.content) {
          setContent(result.content);
        } else {
          setError(result.error || 'Failed to load changelog');
        }
      } catch {
        setError("Couldn't load the changelog.");
      } finally {
        setLoading(false);
      }
    };

    fetchChangelog();
  }, [open]);

  const handleClose = useCallback(() => {
    // Track close with session stats
    if (sessionStartRef.current > 0) {
      const timeSpentMs = Date.now() - sessionStartRef.current;
      tracking.whatsNew.closed(featuresViewedRef.current, timeSpentMs);
    }
    onOpenChange(false);
    setVisibleCount(INITIAL_VERSIONS);
  }, [onOpenChange]);

  const handleLoadMore = useCallback(() => {
    setVisibleCount((prev) => prev + LOAD_MORE_COUNT);
  }, []);

  const sections = content ? parseChangelogSections(content, currentVersion) : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" className={styles.dialogContent}>
        <DialogHeader onClose={handleClose}>
          <div className={styles.headerContent}>
            <div className={styles.headerIconWrapper}>
              <Sparkles size={18} className={styles.headerIcon} />
            </div>
            <DialogTitle>What's New</DialogTitle>
          </div>
        </DialogHeader>
        <DialogBody className={styles.dialogBody}>
          {loading && (
            <div className={styles.loadingState}>
              <div className={styles.loadingSpinner} />
              <span className={styles.loadingText}>Loading updates...</span>
            </div>
          )}
          {error && (
            <div className={styles.errorState}>{error}</div>
          )}
          {!loading && !error && sections.length > 0 && (
            <div className={styles.changelogContent}>
              {sections.slice(0, visibleCount).map((section, index) => (
                <VersionSection
                  key={section.version}
                  section={section}
                  index={index}
                  isLatest={index === 0}
                  onTryFeature={onTryFeature}
                  onFeatureViewed={() => { featuresViewedRef.current += 1; }}
                />
              ))}
              {sections.length > visibleCount && (
                <button
                  className={styles.loadMoreButton}
                  onClick={handleLoadMore}
                >
                  <span>Show older versions</span>
                  <span className={styles.loadMoreCount}>
                    {sections.length - visibleCount} more
                  </span>
                </button>
              )}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button onClick={handleClose}>Got it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
