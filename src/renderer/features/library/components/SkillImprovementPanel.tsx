import { useCallback, useMemo, useState } from 'react';
import {
  AlertCircle,
  Check,
  ChevronDown,
  Circle,
  FileText,
  Loader2,
  Plus,
} from 'lucide-react';
import { Badge, Button, Tooltip } from '@renderer/components/ui';
import { cn } from '@renderer/lib/utils';
import { writeFileOrFail } from '@renderer/utils/libraryWrites';
import { WriteFailureError } from '@shared/utils/documentIoErrorClassification';
import type { SkillQualityBand } from '../utils/skillQualityUtils';
import { QUALITY_BAND_CONFIG } from '../utils/skillQualityUtils';
import {
  generateExampleContent,
  generateExampleFilename,
  type ExampleTemplateType,
} from '../utils/exampleTemplates';
import { useSkillBreakdown } from '../hooks/useSkillBreakdown';
import type { ExampleMeta } from '../hooks/useSkillsIndex';
import styles from './SkillImprovementPanel.module.css';

interface SkillCardFrontmatterLike {
  description?: string;
  use_cases?: string[];
}

interface SkillImprovementPanelProps {
  skillName: string;
  skillRelativePath: string;
  qualityScore?: number;
  qualityBand?: SkillQualityBand;
  qualityTopImprovement?: {
    dimension: string;
    suggestion: string;
  };
  frontmatter?: SkillCardFrontmatterLike;
  examplePaths?: string[];
  onViewExample?: (examplePath: string) => void;
}

interface WeakDimension {
  key: string;
  score: number;
  max: number;
  ratio: number;
}

interface ChecklistItem {
  key: string;
  label: string;
  complete: boolean;
}

const RING_RADIUS = 40;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

const DIMENSION_SUGGESTIONS: Record<string, string> = {
  structure: 'A clear description and a few use cases go a long way. Think of it as the back-of-the-book blurb.',
  clarity: 'The instructions could be tighter. Headings and step-by-step flow help Rebel follow your intent.',
  examples: 'Show, don\'t tell. A real example of the output you want is worth a thousand words of instruction.',
  context: 'Who owns this, what tools does it need, when was it last touched? Context helps Rebel activate it at the right moment.',
  adoption: 'Use it in a real conversation. Skills get sharper with practice -- yours and Rebel\'s.',
  extensionHealth: 'Keep your personal additions focused. A few clear preferences beat a wall of text.',
};

const QUALITY_BAND_CLASS_NAME: Record<SkillQualityBand, string> = {
  seedling: 'qualityArcSeedling',
  growing: 'qualityArcGrowing',
  solid: 'qualityArcSolid',
  exemplary: 'qualityArcExemplary',
};

const clampScore = (value: number | undefined): number => {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round(value ?? 0)));
};

const getBandFromScore = (score: number): SkillQualityBand => {
  if (score <= 22) {
    return 'seedling';
  }

  if (score <= 45) {
    return 'growing';
  }

  if (score <= 68) {
    return 'solid';
  }

  return 'exemplary';
};

const getFileName = (examplePath: string): string => {
  const normalizedPath = examplePath.replace(/\\/g, '/');
  return normalizedPath.split('/').pop() ?? normalizedPath;
};

const formatDimensionName = (dimension: string): string => {
  return dimension
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (char) => char.toUpperCase());
};

const hasDescription = (description: string | undefined): boolean =>
  typeof description === 'string' && description.trim().length > 0;

const hasUseCases = (useCases: string[] | undefined): boolean =>
  Array.isArray(useCases) && useCases.length > 0;

const getExamplesForDisplay = (exampleMetas: ExampleMeta[], examplePaths: string[] | undefined): ExampleMeta[] => {
  if (exampleMetas.length > 0) {
    return exampleMetas;
  }

  if (!examplePaths || examplePaths.length === 0) {
    return [];
  }

  return examplePaths.map((examplePath) => ({
    path: examplePath,
    type: 'positive',
    hasFrontmatter: false,
  }));
};

export function SkillImprovementPanel({
  skillName,
  skillRelativePath,
  qualityScore,
  qualityBand,
  qualityTopImprovement,
  frontmatter,
  examplePaths,
  onViewExample,
}: SkillImprovementPanelProps) {
  const { quality, breakdown, exampleMetas, loading, error, refresh } = useSkillBreakdown(skillRelativePath);
  const [expandedDimensionKey, setExpandedDimensionKey] = useState<string | null>(null);
  const [creatingType, setCreatingType] = useState<ExampleTemplateType | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  const score = clampScore(quality?.total ?? qualityScore);
  const band = quality?.band ?? qualityBand ?? getBandFromScore(score);
  const topImprovement = quality?.topImprovement ?? qualityTopImprovement;
  const qualitySummary = QUALITY_BAND_CONFIG[band];

  const examplesForDisplay = useMemo(
    () => [...getExamplesForDisplay(exampleMetas, examplePaths)].sort((left, right) => left.path.localeCompare(right.path)),
    [exampleMetas, examplePaths],
  );

  const allExamplePaths = useMemo(() => {
    return Array.from(new Set([...(examplePaths ?? []), ...exampleMetas.map((meta) => meta.path)]));
  }, [examplePaths, exampleMetas]);

  const weakDimensions = useMemo<WeakDimension[]>(() => {
    if (!breakdown) {
      return [];
    }

    return Object.entries(breakdown)
      .map(([key, value]) => {
        const ratio = value.max <= 0 ? 0 : value.score / value.max;
        return {
          key,
          score: value.score,
          max: value.max,
          ratio,
        };
      })
      .filter((dimension) => dimension.ratio < 0.66)
      .sort((left, right) => left.ratio - right.ratio)
      .slice(0, 3);
  }, [breakdown]);

  const checklistItems = useMemo<ChecklistItem[]>(() => {
    const hasAnyExamples = allExamplePaths.length > 0;
    const hasCounterExample = exampleMetas.some((meta) => meta.type === 'counter-example');
    const examplesMissingDescriptions =
      hasAnyExamples &&
      (exampleMetas.length === 0 ||
        exampleMetas.some(
          (meta) => !meta.hasFrontmatter || !hasDescription(meta.description),
        ));

    const items: ChecklistItem[] = [
      {
        key: 'frontmatter-description',
        label: 'Give this skill a description',
        complete: hasDescription(frontmatter?.description),
      },
      {
        key: 'use-cases',
        label: 'List when you\'d actually use this',
        complete: hasUseCases(frontmatter?.use_cases),
      },
      {
        key: 'examples',
        label: 'Show Rebel what good output looks like',
        complete: hasAnyExamples,
      },
    ];

    if (band === 'solid' || band === 'exemplary') {
      items.push({
        key: 'counter-example',
        label: 'Show what "not quite right" looks like too',
        complete: hasCounterExample,
      });
    }

    if (hasAnyExamples) {
      items.push({
        key: 'example-descriptions',
        label: 'Describe what each example demonstrates',
        complete: !examplesMissingDescriptions,
      });
    }

    return items;
  }, [allExamplePaths, band, exampleMetas, frontmatter?.description, frontmatter?.use_cases]);

  const nextActionIndex = checklistItems.findIndex((item) => !item.complete);
  const nextAction = nextActionIndex >= 0 ? checklistItems[nextActionIndex] : null;

  const canAddExamples = /(^|[/\\])SKILL\.md$/i.test(skillRelativePath);
  const strokeDashOffset = RING_CIRCUMFERENCE - (score / 100) * RING_CIRCUMFERENCE;

  const getDimensionSuggestion = useCallback(
    (dimensionKey: string): string => {
      if (topImprovement?.dimension === dimensionKey) {
        return topImprovement.suggestion;
      }

      return DIMENSION_SUGGESTIONS[dimensionKey] ?? 'Add a little more structure to this part of the skill.';
    },
    [topImprovement],
  );

  const handleCreateExample = useCallback(
    async (type: ExampleTemplateType) => {
      if (!canAddExamples) {
        setCreateError('Examples can only be added to folder-based skills with a SKILL.md file.');
        return;
      }

      setCreatingType(type);
      setCreateError(null);

      try {
        const normalizedSkillPath = skillRelativePath.replace(/\\/g, '/');
        const skillDirectory = normalizedSkillPath.replace(/\/SKILL\.md$/i, '');
        const exampleFileName = generateExampleFilename(skillName, type, allExamplePaths);
        const examplePath = `${skillDirectory}/examples/${exampleFileName}`;
        const exampleContent = generateExampleContent({
          skillName,
          skillRelativePath: normalizedSkillPath,
          type,
        });

        const writeResult = await writeFileOrFail({
          path: examplePath,
          content: exampleContent,
        });
        if (writeResult.result === 'conflict') {
          setCreateError('Save failed: file changed externally.');
          return;
        }

        await refresh();
        onViewExample?.(examplePath);
      } catch (err) {
        setCreateError(err instanceof WriteFailureError
          ? 'Unable to save changes.'
          : err instanceof Error ? err.message : 'Failed to create example file.');
      } finally {
        setCreatingType(null);
      }
    },
    [allExamplePaths, canAddExamples, onViewExample, refresh, skillName, skillRelativePath],
  );

  return (
    <section className={styles.panel} aria-label="Skill improvement panel">
      <header className={styles.header}>
        <div className={styles.qualityRingWrap}>
          <svg
            className={styles.qualityRing}
            width="96"
            height="96"
            viewBox="0 0 96 96"
            role="img"
            aria-label={`Skill quality: ${qualitySummary.label}, ${score} out of 100`}
          >
            <circle
              className={styles.qualityRingTrack}
              cx="48"
              cy="48"
              r={RING_RADIUS}
              strokeWidth="6"
              fill="none"
            />
            <circle
              className={cn(styles.qualityRingArc, styles[QUALITY_BAND_CLASS_NAME[band]])}
              cx="48"
              cy="48"
              r={RING_RADIUS}
              strokeWidth="6"
              fill="none"
              strokeDasharray={RING_CIRCUMFERENCE}
              strokeDashoffset={strokeDashOffset}
            />
          </svg>
          <div className={styles.qualityRingCenter}>
            <span className={styles.qualityRingScore}>{score}</span>
          </div>
        </div>

        <div className={styles.headerText}>
          <div className={styles.headerTitleRow}>
            <h3 className={styles.title}>Skill quality</h3>
            {loading && (
              <span className={styles.loadingState}>
                <Loader2 size={14} className={styles.loadingIcon} />
                Refreshing
              </span>
            )}
          </div>
          <p className={styles.subtitle}>
            {qualitySummary.label} — {score}/100
          </p>
          <p className={styles.summary}>{qualitySummary.description}</p>
        </div>
      </header>

      {(error || createError) && (
        <div className={styles.errorNotice}>
          <AlertCircle size={14} />
          <span>{createError ?? error}</span>
        </div>
      )}

      <div className={styles.section}>
        <h4 className={styles.sectionTitle}>Where to focus</h4>
        {!breakdown ? (
          <p className={styles.sectionHint}>
            {loading ? 'Reading the tea leaves\u2026' : 'Rebel will have suggestions after the next scan.'}
          </p>
        ) : weakDimensions.length === 0 ? (
          <p className={styles.sectionHint}>Nothing jumping out. This skill is pulling its weight.</p>
        ) : (
          <div className={styles.dimensionList}>
            {weakDimensions.map((dimension) => {
              const isExpanded = expandedDimensionKey === dimension.key;
              const suggestion = getDimensionSuggestion(dimension.key);
              const showWarningBar = dimension.ratio < 0.33;
              return (
                <div key={dimension.key} className={styles.dimensionItem}>
                  <button
                    type="button"
                    className={styles.dimensionButton}
                    onClick={() => {
                      setExpandedDimensionKey((current) =>
                        current === dimension.key ? null : dimension.key,
                      );
                    }}
                    aria-expanded={isExpanded}
                    aria-label={`${formatDimensionName(dimension.key)} score ${dimension.score} out of ${dimension.max}`}
                  >
                    <div className={styles.dimensionTopRow}>
                      <span className={styles.dimensionName}>{formatDimensionName(dimension.key)}</span>
                      <span className={styles.dimensionScoreText}>
                        {dimension.score}/{dimension.max}
                      </span>
                    </div>

                    <div className={styles.dimensionBarTrack}>
                      <div
                        className={cn(
                          styles.dimensionBarFill,
                          showWarningBar && styles.dimensionBarFillWarning,
                        )}
                        style={{ width: `${Math.max(0, Math.min(100, Math.round(dimension.ratio * 100)))}%` }}
                      />
                    </div>

                    <ChevronDown
                      size={14}
                      className={cn(styles.dimensionChevron, isExpanded && styles.dimensionChevronExpanded)}
                    />
                  </button>
                  {isExpanded && <p className={styles.dimensionSuggestion}>{suggestion}</p>}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className={styles.section}>
        <h4 className={styles.sectionTitle}>Examples</h4>
        {examplesForDisplay.length === 0 ? (
          <p className={styles.sectionHint}>No examples yet. Think of it like training a new colleague -- showing beats telling, every time.</p>
        ) : (
          <div className={styles.examplesList}>
            {examplesForDisplay.map((exampleMeta) => {
              const examplePath = exampleMeta.path;
              const exampleName = getFileName(examplePath).replace(/\.md$/i, '');
              const isCounterExample = exampleMeta.type === 'counter-example';

              return (
                <button
                  key={examplePath}
                  type="button"
                  className={styles.exampleCard}
                  onClick={() => onViewExample?.(examplePath)}
                >
                  <div className={styles.exampleHeader}>
                    <span className={styles.exampleName}>
                      <FileText size={12} />
                      {exampleName}
                    </span>
                    <Badge variant={isCounterExample ? 'warning' : 'primary'} size="sm">
                      {isCounterExample ? 'counter-example' : 'positive'}
                    </Badge>
                  </div>
                  {hasDescription(exampleMeta.description) && (
                    <p className={styles.exampleDescription}>{exampleMeta.description}</p>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className={styles.section}>
        <h4 className={styles.sectionTitle}>What's next</h4>
        <ul className={styles.checklist}>
          {checklistItems.map((item, index) => {
            const isNextAction = !item.complete && index === nextActionIndex;
            return (
              <li
                key={item.key}
                className={cn(
                  styles.checklistItem,
                  item.complete && styles.checklistItemComplete,
                  isNextAction && styles.checklistItemNext,
                )}
              >
                <span className={styles.checklistIcon} aria-hidden>
                  {item.complete ? (
                    <Check size={14} className={styles.checkIconComplete} />
                  ) : (
                    <Circle
                      size={14}
                      className={cn(
                        styles.checkIconPending,
                        isNextAction && styles.checkIconNext,
                      )}
                    />
                  )}
                </span>
                <span>{item.label}</span>
              </li>
            );
          })}
        </ul>
        {nextAction ? (
          <p className={styles.nextAction}>Next: {nextAction.label}</p>
        ) : (
          <div className={styles.allDone}>
            <span className={styles.allDoneIcon} aria-hidden>&#10024;</span>
            <div>
              <p className={styles.allDoneTitle}>This skill is dialled in.</p>
              <p className={styles.allDoneSubtitle}>Every box checked. Rebel approves -- and that's not easy to earn.</p>
            </div>
          </div>
        )}
      </div>

      <div className={styles.quickActions}>
        <Button
          size="sm"
          onClick={() => {
            void handleCreateExample('positive');
          }}
          disabled={creatingType !== null || !canAddExamples}
        >
          {creatingType === 'positive' ? (
            <Loader2 size={14} className={styles.loadingIcon} />
          ) : (
            <Plus size={14} />
          )}
          Add Example
        </Button>

        <Tooltip
          content="Show what 'not quite right' looks like — this often improves output quality."
          placement="top"
        >
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void handleCreateExample('counter-example');
            }}
            disabled={creatingType !== null || !canAddExamples}
          >
            {creatingType === 'counter-example' ? (
              <Loader2 size={14} className={styles.loadingIcon} />
            ) : (
              <Plus size={14} />
            )}
            Add Counter-Example
          </Button>
        </Tooltip>
      </div>
    </section>
  );
}
