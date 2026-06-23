import { memo, useMemo, useState, useCallback } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import fm from 'front-matter';
import { ScrollText, Play, FileText, ChevronDown, Wrench, Link2, Clock, Lightbulb, X, Info, Share2, UserCog, Sparkles, User, History, Code } from 'lucide-react';
import { Button, Badge, Tooltip } from '@renderer/components/ui';
import { cn } from '@renderer/lib/utils';
import { tracking } from '@renderer/src/tracking';
import { useAuth } from '@renderer/features/auth/hooks/useAuth';
import styles from './SkillCard.module.css';
import type { SkillFrontmatter as LibrarySkillFrontmatter } from '../hooks/useSkillsIndex';
import type { SpaceStorageProvider } from '@shared/types';
import { formatSkillAuthorLine, formatSkillLastModifiedLine } from '../utils/skillAttribution';
import { SkillHistoryPanel } from './SkillHistoryPanel';
import { shouldIgnoreCardClick } from './views/cardClickGuard';

type ParsedSkillFrontmatter = Partial<LibrarySkillFrontmatter>;

interface ParsedSkill {
  frontmatter: ParsedSkillFrontmatter;
  body: string;
  isValid: boolean;
}

function normalizeEmail(email?: string): string | null {
  const normalized = email?.trim().toLowerCase();
  return normalized || null;
}

function hasSkillHistoryContributorAccess(
  frontmatter: ParsedSkillFrontmatter,
  sharing: 'private' | 'restricted' | 'team' | 'company-wide' | 'public' | undefined,
  user: ReturnType<typeof useAuth>['user'],
): boolean {
  if (!user || !sharing || sharing === 'private') {
    return false;
  }

  if (frontmatter.author_id === user.id) {
    return true;
  }

  if (!frontmatter.author_id && normalizeEmail(frontmatter.author_email) === normalizeEmail(user.email)) {
    return true;
  }

  if (frontmatter.contributors?.includes(user.id)) {
    return true;
  }

  if (frontmatter.last_modified_by_id === user.id) {
    return true;
  }

  if (
    !frontmatter.last_modified_by_id &&
    normalizeEmail(frontmatter.last_modified_by_email) === normalizeEmail(user.email)
  ) {
    return true;
  }

  return false;
}

export function canShowSkillHistory(
  frontmatter: ParsedSkillFrontmatter,
  sharing: 'private' | 'restricted' | 'team' | 'company-wide' | 'public' | undefined,
  user: ReturnType<typeof useAuth>['user'],
  storageProvider?: SpaceStorageProvider,
): boolean {
  return hasSkillHistoryContributorAccess(frontmatter, sharing, user) && storageProvider === 'google_drive';
}

function ensureStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.filter((s): s is string => typeof s === 'string');
  if (typeof value === 'string' && value.length > 0) return [value];
  return undefined;
}

function parseSkillContent(content: string): ParsedSkill {
  try {
    const parsed = fm<ParsedSkillFrontmatter>(content);
    const raw = parsed.attributes || {};
    const frontmatter: ParsedSkillFrontmatter = { ...raw };
    if ('use_cases' in raw) frontmatter.use_cases = ensureStringArray(raw.use_cases);
    if ('tools_required' in raw) frontmatter.tools_required = ensureStringArray(raw.tools_required);
    if ('dependencies' in raw) frontmatter.dependencies = ensureStringArray(raw.dependencies);
    if ('contributed' in raw) frontmatter.contributed = ensureStringArray(raw.contributed);
    if ('contributors' in raw) frontmatter.contributors = ensureStringArray(raw.contributors);
    const hasStructuredContent =
      Object.keys(frontmatter).length > 0 || parsed.body.trim().length > 0;
    return {
      frontmatter,
      body: parsed.body,
      isValid: hasStructuredContent,
    };
  } catch {
    return {
      frontmatter: {},
      body: content,
      isValid: false,
    };
  }
}

const FRONTMATTER_FIELD_LABELS: Record<string, string> = {
  description: 'Description',
  name: 'Name',
  model: 'Model',
  effort: 'Effort',
  use_cases: 'Use Cases',
  last_updated: 'Last Updated',
  tools_required: 'Tools Required',
  agent_type: 'Agent Type',
  dependencies: 'Dependencies',
  extends: 'Extends',
  extension_type: 'Extension Type',
  author: 'Author',
  author_id: 'Author ID',
  author_email: 'Author Email',
  author_source: 'Author Source',
  contributed: 'Contributors',
  contributors: 'Contributor IDs',
  last_modified_by: 'Last Modified By',
  last_modified_by_id: 'Last Modified By ID',
  last_modified_by_email: 'Last Modified By Email',
  last_modified_at: 'Last Modified At',
  last_modified_context: 'Modification Context',
  coach_type: 'Coach Type',
  proactive_interval_minutes: 'Proactive Interval (min)',
};

function getDisplayableMetadataEntries(
  frontmatter: ParsedSkillFrontmatter,
): Array<{ key: string; label: string; value: string }> {
  const entries: Array<{ key: string; label: string; value: string }> = [];

  for (const [key, value] of Object.entries(frontmatter)) {
    if (value == null || value === '') continue;

    const label = FRONTMATTER_FIELD_LABELS[key] ?? key;
    let displayValue: string;

    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      displayValue = value.join(', ');
    } else if (typeof value === 'object') {
      displayValue = JSON.stringify(value, null, 2);
    } else {
      displayValue = String(value);
    }

    entries.push({ key, label, value: displayValue });
  }

  return entries;
}

import type { SkillQualityBand, SkillImproveQualityContext } from '../utils/skillQualityUtils';
import { getSkillQualityBadgeData, buildImproveQualityContext } from '../utils/skillQualityUtils';
import { QualityLegendTooltip, QUALITY_BAND_ICONS } from './QualityLegendTooltip';
import { SkillImprovementPanel } from './SkillImprovementPanel';

export type SkillSourceType = 'platform' | 'space' | 'workspace';
export type SkillCardPresentation = 'grid' | 'detail';

export interface SkillCardProps {
  presentation?: SkillCardPresentation;
  content: string;
  savedContent?: string | null;
  frontmatter?: ParsedSkillFrontmatter;
  documentPath?: string | null;
  relativePath: string;
  fileName: string;
  /** Source type of the skill (platform = Rebel system, space = Chief-of-Staff etc, workspace = root skills/) */
  skillSource?: SkillSourceType;
  sharing?: 'private' | 'restricted' | 'team' | 'company-wide' | 'public';
  storageProvider?: SpaceStorageProvider;
  /** Whether this platform skill has a personal supplement in Chief-of-Staff */
  hasPersonalSupplement?: boolean;
  hasUnsavedChanges?: boolean;
  /** Paths to example files (relative to workspace root) */
  examplePaths?: string[];
  /** Quality score from skill scan (0-100) */
  qualityScore?: number;
  /** Quality band label from skill scan */
  qualityBand?: SkillQualityBand;
  /** Highest-impact quality improvement hint from skill scan */
  qualityTopImprovement?: {
    dimension: string;
    suggestion: string;
  };
  onUseSkill?: () => void;
  onShowRaw: () => void;
  onClose?: () => void;
  /** Called when user clicks "Back to Skills" — resets the Library to its default browse lens. Falls back to onClose. */
  onBackToSkills?: () => void;
  /** Called when user wants to personalise a platform skill */
  onPersonalise?: () => void;
  /** Called when user wants to share a personal skill */
  onShare?: () => void;
  /** Called when user wants to improve the skill with Rebel */
  onImproveSkill?: (skillRelativePath: string, qualityContext?: SkillImproveQualityContext) => void;
  /** Called when user wants to view an example file */
  onViewExample?: (examplePath: string) => void;
  /** Open a skill/document path in the current editor flow. Required for version-history actions. */
  onOpenFilePath: (path: string) => Promise<void> | void;
  /** Prepare the editor state before a restore starts */
  onBeforeRestoreVersion?: () => boolean;
  /** Clear any temporary restore lock when the restore does not complete */
  onRestoreAttemptAborted?: () => void;
  /** When restore succeeds without an open editor buffer — release external-commit lock */
  onRestoreExternalCommitReleased?: () => void;
  /** Replace the current open skill buffer after a successful restore */
  onRestoreVersionApplied?: (documentPath: string, content: string) => void;
}

interface CollapsibleSectionProps {
  title: string;
  count: number;
  icon: React.ReactNode;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  /** Optional help text shown in a tooltip info icon next to the title */
  info?: string;
}

const CollapsibleSection = ({
  title,
  count,
  icon,
  expanded,
  onToggle,
  children,
  info,
}: CollapsibleSectionProps) => (
  <div className={cn(styles.section, expanded && styles.sectionExpanded)}>
    <button
      type="button"
      className={styles.sectionHeader}
      onClick={onToggle}
      aria-expanded={expanded}
    >
      <ChevronDown 
        size={14} 
        className={cn(styles.sectionChevron, expanded && styles.sectionChevronExpanded)} 
      />
      <span className={styles.sectionIconWrapper}>{icon}</span>
      <span className={styles.sectionTitle}>{title}</span>
      {info && (
        <Tooltip content={info} placement="top">
          <span className={styles.sectionInfoIcon} aria-label={`${title} info`}>
            <Info size={12} />
          </span>
        </Tooltip>
      )}
      <span className={styles.sectionSpacer} />
      <Badge variant="muted" size="sm" className={styles.sectionCount}>
        {count}
      </Badge>
    </button>
    {expanded && (
      <div className={styles.sectionContent}>
        {children}
      </div>
    )}
  </div>
);

const SkillCardComponent = ({
  presentation = 'detail',
  content,
  savedContent,
  frontmatter: canonicalFrontmatter,
  documentPath,
  relativePath,
  fileName,
  skillSource,
  sharing,
  storageProvider,
  hasPersonalSupplement,
  hasUnsavedChanges,
  examplePaths,
  qualityScore,
  qualityBand,
  qualityTopImprovement,
  onUseSkill,
  onShowRaw,
  onClose,
  onBackToSkills,
  onPersonalise,
  onShare,
  onImproveSkill,
  onViewExample,
  onOpenFilePath,
  onBeforeRestoreVersion,
  onRestoreAttemptAborted,
  onRestoreExternalCommitReleased,
  onRestoreVersionApplied,
}: SkillCardProps) => {
  const isGridPresentation = presentation === 'grid';
  const { user } = useAuth();
  const [useCasesExpanded, setUseCasesExpanded] = useState(false);
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [dependenciesExpanded, setDependenciesExpanded] = useState(false);
  const [examplesExpanded, setExamplesExpanded] = useState(false);
  const [metadataExpanded, setMetadataExpanded] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const parsed = useMemo(() => parseSkillContent(content), [content]);
  const { frontmatter, isValid } = parsed;
  const savedFrontmatter = useMemo(
    () => parseSkillContent(savedContent ?? content).frontmatter,
    [content, savedContent],
  );
  const provenanceFrontmatter = canonicalFrontmatter ?? savedFrontmatter;

  const skillName = fileName.replace(/\.md$/i, '');

  const handleUseSkill = useCallback(() => {
    tracking.spark.skillUsed(relativePath, skillName);
    onUseSkill?.();
  }, [relativePath, skillName, onUseSkill]);

  const improveQualityContext = useMemo(
    () => buildImproveQualityContext(qualityScore, qualityBand, qualityTopImprovement),
    [qualityScore, qualityBand, qualityTopImprovement]
  );

  const handleImproveSkill = useCallback(() => {
    onImproveSkill?.(relativePath, improveQualityContext);
  }, [onImproveSkill, relativePath, improveQualityContext]);

  const category = useMemo(() => {
    const match = relativePath.match(/[/\\]skills[/\\]([^/\\]+)[/\\]/i);
    return match?.[1] ?? 'uncategorized';
  }, [relativePath]);

  const formattedCategory = useMemo(() => {
    return category
      .split(/[-_]/)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }, [category]);

  const authorLine = useMemo(
    () => formatSkillAuthorLine(provenanceFrontmatter, user),
    [provenanceFrontmatter, user],
  );

  const createdByLine = useMemo(
    () => (authorLine ? `Created ${authorLine}` : null),
    [authorLine],
  );

  const lastModifiedLine = useMemo(
    () => formatSkillLastModifiedLine(provenanceFrontmatter, user),
    [provenanceFrontmatter, user],
  );

  const updatedByLine = useMemo(
    () => (lastModifiedLine ? lastModifiedLine.replace(/^Last modified\b/, 'Last updated') : null),
    [lastModifiedLine],
  );

  const historyEligible = useMemo(
    () => canShowSkillHistory(savedFrontmatter, sharing, user, storageProvider),
    [savedFrontmatter, sharing, user, storageProvider],
  );

  const historyUnavailableReason = useMemo(
    () => {
      if (!hasSkillHistoryContributorAccess(savedFrontmatter, sharing, user)) {
        return null;
      }
      if (storageProvider === 'google_drive') {
        return null;
      }
      return 'Version history is currently available for shared skills stored in Google Drive.';
    },
    [savedFrontmatter, sharing, storageProvider, user],
  );

  const metadataEntries = useMemo(
    () => getDisplayableMetadataEntries(frontmatter),
    [frontmatter],
  );

  const useCases = frontmatter.use_cases ?? [];
  const toolsRequired = frontmatter.tools_required ?? [];
  const dependencies = frontmatter.dependencies ?? [];
  const hasUseCases = useCases.length > 0;
  const hasTools = toolsRequired.length > 0;
  const hasDependencies = dependencies.length > 0;
  const qualityInfo = getSkillQualityBadgeData(qualityScore, qualityBand);
  const hasQualitySection = Boolean(qualityInfo || qualityTopImprovement?.suggestion);
  const gridSummary = useMemo(() => {
    if (!isGridPresentation) return null;
    const summaries: string[] = [];
    if (useCases.length > 0) {
      summaries.push(`${useCases.length} use case${useCases.length === 1 ? '' : 's'}`);
    }
    if (toolsRequired.length > 0) {
      summaries.push(`${toolsRequired.length} tool${toolsRequired.length === 1 ? '' : 's'}`);
    }
    if (dependencies.length > 0) {
      summaries.push(`${dependencies.length} dependenc${dependencies.length === 1 ? 'y' : 'ies'}`);
    }
    if (examplePaths && examplePaths.length > 0) {
      summaries.push(`${examplePaths.length} example${examplePaths.length === 1 ? '' : 's'}`);
    }
    return summaries.length > 0 ? summaries.join(' · ') : null;
  }, [dependencies.length, examplePaths, isGridPresentation, toolsRequired.length, useCases.length]);

  const handleGridOpen = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (!isGridPresentation) return;
    if (shouldIgnoreCardClick(event)) return;
    onShowRaw();
  }, [isGridPresentation, onShowRaw]);

  const handleGridKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (!isGridPresentation) return;
    if (event.currentTarget !== event.target) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onShowRaw();
    }
  }, [isGridPresentation, onShowRaw]);

  const cardClassName = cn(styles.card, isGridPresentation ? styles.cardGrid : styles.cardDetail);

  if (!isValid) {
    return (
      <article
        className={cardClassName}
        tabIndex={isGridPresentation ? -1 : undefined}
        data-testid={isGridPresentation ? 'skill-card-grid-root' : undefined}
        onClick={isGridPresentation ? handleGridOpen : undefined}
        onKeyDown={isGridPresentation ? handleGridKeyDown : undefined}
      >
        <header className={styles.header}>
          <div className={styles.headerTop}>
            <div className={styles.titleGroup}>
              <div className={styles.iconBadge}>
                <ScrollText size={16} />
              </div>
              <div className={styles.titleText}>
                <h2 className={styles.title}>{skillName}</h2>
                <span className={styles.path}>{relativePath}</span>
              </div>
            </div>
            {(onBackToSkills || onClose) && (
              <Button
                variant="ghost"
                size="sm"
                className={styles.closeButton}
                onClick={onBackToSkills ?? onClose}
                aria-label="Close"
              >
                <X size={16} />
              </Button>
            )}
          </div>
        </header>

        <div className={styles.body}>
          <p className={styles.description}>
            This skill overview could not be rendered cleanly, so the raw instructions are the safer bet.
          </p>
        </div>

        <footer className={styles.footer}>
          <div className={styles.footerLeft}>
            <Button
              variant="ghost"
              onClick={(event) => {
                event.stopPropagation();
                onShowRaw();
              }}
              size="sm"
              aria-label="Open instructions"
            >
              <FileText size={14} />
              Open instructions
            </Button>
          </div>
        </footer>
      </article>
    );
  }

  return (
    <article
      className={cardClassName}
      tabIndex={isGridPresentation ? -1 : undefined}
      data-testid={isGridPresentation ? 'skill-card-grid-root' : undefined}
      onClick={isGridPresentation ? handleGridOpen : undefined}
      onKeyDown={isGridPresentation ? handleGridKeyDown : undefined}
    >
      {/* Header */}
      <header className={styles.header}>
        <div className={styles.headerTop}>
          <div className={styles.titleGroup}>
            <div className={styles.iconBadge}>
              <ScrollText size={16} />
            </div>
            <div className={styles.titleText}>
              <h2 className={styles.title}>{skillName}</h2>
              <span className={styles.path}>{relativePath}</span>
            </div>
          </div>
          {(onBackToSkills || onClose) && (
            <Button
              variant="ghost"
              size="sm"
              className={styles.closeButton}
              onClick={onBackToSkills ?? onClose}
              aria-label="Close"
            >
              <X size={16} />
            </Button>
          )}
        </div>
        <div className={styles.badgeRow}>
          <Badge variant="outline" size="sm">
            {formattedCategory}
          </Badge>
          {frontmatter.agent_type && (
            <Badge variant="outline" size="sm">
              {frontmatter.agent_type === 'subagent' ? 'Subagent' : 'Main Agent'}
            </Badge>
          )}
          {skillSource === 'platform' && hasPersonalSupplement && (
            <Badge variant="default" size="sm">
              Personalised
            </Badge>
          )}
          {qualityInfo && (() => {
            const band = qualityBand ?? 'seedling';
            const QualityIcon = QUALITY_BAND_ICONS[band];
            if (isGridPresentation) {
              return (
                <span
                  className={cn(styles.qualityBadge, styles.qualityBadgeInline, styles[qualityInfo.badgeClassName])}
                  aria-label={`${qualityInfo.label} — ${qualityInfo.score} out of 100. ${qualityInfo.description}`}
                  data-testid="skill-card-grid-quality-badge"
                >
                  <QualityIcon size={12} aria-hidden />
                  <span className={styles.qualityBadgeLabel}>{qualityInfo.label}</span>
                  <span className={styles.qualityBadgeScore}>{qualityInfo.score}</span>
                </span>
              );
            }
            return (
              <Tooltip content={<QualityLegendTooltip activeBand={band} score={qualityInfo.score} topImprovement={qualityTopImprovement} />} placement="top">
                <span
                  className={cn(styles.qualityBadge, styles[qualityInfo.badgeClassName])}
                  aria-label={`${qualityInfo.label} — ${qualityInfo.score} out of 100. ${qualityInfo.description}`}
                >
                  <QualityIcon size={12} aria-hidden />
                  <span className={styles.qualityBadgeLabel}>{qualityInfo.label}</span>
                </span>
              </Tooltip>
            );
          })()}
        </div>
        {!isGridPresentation && (createdByLine || updatedByLine) && (
          <div className={styles.provenance}>
            {createdByLine && (
              <div className={styles.provenanceRow}>
                <User size={12} />
                <span>{createdByLine}</span>
              </div>
            )}
            {updatedByLine && (
              <div className={styles.provenanceRow}>
                <Clock size={12} />
                <span>{updatedByLine}</span>
              </div>
            )}
          </div>
        )}
      </header>

      {/* Content */}
      <div className={styles.body}>
        {/* Description */}
        {frontmatter.description && (
          <p
            className={cn(styles.description, isGridPresentation && styles.descriptionClamped)}
            data-testid={isGridPresentation ? 'skill-card-grid-description' : undefined}
          >
            {frontmatter.description}
          </p>
        )}
        {isGridPresentation ? (
          gridSummary ? (
            <p className={styles.gridSummary} data-testid="skill-card-grid-summary">
              {gridSummary}
            </p>
          ) : null
        ) : (
          <>
            {/* Sections */}
            <div className={styles.sections}>
              {/* Use Cases */}
              {hasUseCases && (
                <CollapsibleSection
                  title="Use Cases"
                  count={useCases.length}
                  icon={<Lightbulb size={12} />}
                  expanded={useCasesExpanded}
                  onToggle={() => setUseCasesExpanded(!useCasesExpanded)}
                >
                  <ul className={styles.list}>
                    {useCases.map((useCase, idx) => (
                      <li key={idx} className={styles.listItem}>
                        {useCase}
                      </li>
                    ))}
                  </ul>
                </CollapsibleSection>
              )}

              {/* Tools Required */}
              {hasTools && (
                <CollapsibleSection
                  title="Tools Required"
                  count={toolsRequired.length}
                  icon={<Wrench size={12} />}
                  expanded={toolsExpanded}
                  onToggle={() => setToolsExpanded(!toolsExpanded)}
                  info="External tools the skill needs access to (MCP servers/integrations like Slack, Gmail, GitHub, etc.). Connect/manage these in Settings → MCP & Tools."
                >
                  <div className={styles.toolTags}>
                    {toolsRequired.map((tool, idx) => (
                      <span key={idx} className={styles.toolTag}>
                        {tool}
                      </span>
                    ))}
                  </div>
                </CollapsibleSection>
              )}

              {/* Dependencies */}
              {hasDependencies && (
                <CollapsibleSection
                  title="Dependencies"
                  count={dependencies.length}
                  icon={<Link2 size={12} />}
                  expanded={dependenciesExpanded}
                  onToggle={() => setDependenciesExpanded(!dependenciesExpanded)}
                  info="Other skills this one relies on. Keep these files present in your workspace so this skill can run."
                >
                  <ul className={styles.list}>
                    {dependencies.map((dep, idx) => (
                      <li key={idx} className={styles.listItem}>
                        {dep}
                      </li>
                    ))}
                  </ul>
                </CollapsibleSection>
              )}

              {/* Examples */}
              {examplePaths && examplePaths.length > 0 && (
                <CollapsibleSection
                  title="Examples"
                  count={examplePaths.length}
                  icon={<FileText size={12} />}
                  expanded={examplesExpanded}
                  onToggle={() => setExamplesExpanded(!examplesExpanded)}
                  info="Example outputs showing what this skill produces. Click to view."
                >
                  <ul className={styles.list}>
                    {examplePaths.map((examplePath, idx) => {
                      const fileName = examplePath.split('/').pop()?.replace(/\.md$/, '') ?? examplePath;
                      return (
                        <li key={idx} className={styles.listItem}>
                          {onViewExample ? (
                            <button
                              type="button"
                              className={styles.exampleLink}
                              onClick={() => onViewExample(examplePath)}
                            >
                              {fileName}
                            </button>
                          ) : (
                            <span>{fileName}</span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </CollapsibleSection>
              )}

              {/* Frontmatter Metadata (hidden by default, for power users) */}
              {metadataEntries.length > 0 && (
                <CollapsibleSection
                  title="Behind the Scenes"
                  count={metadataEntries.length}
                  icon={<Code size={12} />}
                  expanded={metadataExpanded}
                  onToggle={() => setMetadataExpanded(!metadataExpanded)}
                  info="Technical details about this skill's configuration — author, lineage, model preferences, and more."
                >
                  <dl className={styles.metadataGrid}>
                    {metadataEntries.map(({ key, label, value }) => (
                      <div key={key} className={styles.metadataEntry}>
                        <dt className={styles.metadataLabel}>{label}</dt>
                        <dd className={styles.metadataValue}>{value}</dd>
                      </div>
                    ))}
                  </dl>
                </CollapsibleSection>
              )}
            </div>

            {hasQualitySection && (
              <SkillImprovementPanel
                skillName={skillName}
                skillRelativePath={relativePath}
                qualityScore={qualityScore}
                qualityBand={qualityBand}
                qualityTopImprovement={qualityTopImprovement}
                frontmatter={frontmatter}
                examplePaths={examplePaths}
                onViewExample={onViewExample}
              />
            )}
          </>
        )}

      </div>

      {/* Footer */}
      {isGridPresentation ? (
        <footer className={cn(styles.footer, styles.footerGrid)}>
          <Button
            variant="ghost"
            onClick={(event) => {
              event.stopPropagation();
              onShowRaw();
            }}
            size="sm"
            aria-label="Open instructions"
          >
            <FileText size={14} />
            Open instructions
          </Button>
          {onUseSkill && (
            <Button
              onClick={(event) => {
                event.stopPropagation();
                handleUseSkill();
              }}
              size="sm"
            >
              <Play size={14} />
              Use Skill
            </Button>
          )}
        </footer>
      ) : (
        <footer className={styles.footer}>
          <div className={styles.footerLeft}>
            <Button variant="ghost" onClick={onShowRaw} size="sm" aria-label="Open instructions">
              <FileText size={14} />
              Open instructions
            </Button>
            {historyEligible && (
              <Tooltip content="Review earlier shared versions, restore one, or save a private fork" placement="top">
                <Button variant="ghost" onClick={() => setHistoryOpen(true)} size="sm">
                  <History size={14} />
                  History
                </Button>
              </Tooltip>
            )}
            {!historyEligible && historyUnavailableReason && (
              <Tooltip content={historyUnavailableReason} placement="top">
                <Button variant="ghost" size="sm" disabled>
                  <History size={14} />
                  History
                </Button>
              </Tooltip>
            )}
            {onImproveSkill && (
              <Tooltip content="Open Rebel's skill doctor with this skill preloaded" placement="top">
                <Button variant="ghost" onClick={handleImproveSkill} size="sm">
                  <Sparkles size={14} />
                  Improve with Rebel
                </Button>
              </Tooltip>
            )}
            {/* Personalise: only for platform skills without existing supplement */}
            {skillSource === 'platform' && !hasPersonalSupplement && onPersonalise && (
              <Tooltip content="Create your own additions to this skill" placement="top">
                <Button variant="ghost" onClick={onPersonalise} size="sm">
                  <UserCog size={14} />
                  Personalise
                </Button>
              </Tooltip>
            )}
            {/* Share: only for personal skills (Chief-of-Staff) */}
            {skillSource === 'space' && relativePath.includes('Chief-of-Staff') && onShare && (
              <Tooltip content="Share this skill with your team" placement="top">
                <Button variant="ghost" onClick={onShare} size="sm">
                  <Share2 size={14} />
                  Share
                </Button>
              </Tooltip>
            )}
          </div>
          {onUseSkill && (
            <Button onClick={handleUseSkill}>
              <Play size={14} />
              Use This Skill
            </Button>
          )}
        </footer>
      )}

      {!isGridPresentation && historyEligible && (
        <SkillHistoryPanel
          open={historyOpen}
          onOpenChange={setHistoryOpen}
          skillName={skillName}
          documentPath={documentPath ?? null}
          skillWorkspacePath={relativePath}
          currentContent={savedContent ?? content}
          hasUnsavedChanges={hasUnsavedChanges}
          onOpenFilePath={onOpenFilePath}
          onBeforeRestore={onBeforeRestoreVersion}
          onRestoreAttemptAborted={onRestoreAttemptAborted}
          onRestoreExternalCommitReleased={onRestoreExternalCommitReleased}
          onRestoreVersionApplied={onRestoreVersionApplied}
        />
      )}
    </article>
  );
};

export const SkillCard = memo(SkillCardComponent);
SkillCard.displayName = 'SkillCard';

export { parseSkillContent };
