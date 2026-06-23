import { useState, useCallback, useEffect } from 'react';
import { Zap, Brain, Lightbulb, RefreshCw, Sparkles } from 'lucide-react';
import { useSettings } from '../settings';
import { Badge, Button } from '@renderer/components/ui';
import { WhatsNewDialog } from '@renderer/components/WhatsNewDialog';
import { useUseCaseLibrary } from './hooks';
import { ProgressCard } from './ProgressCard';
import { CommunityEventCard } from './CommunityEventCard';
import { CommunityVideoRecsCard } from './CommunityVideoRecsCard';
import { OnboardingJourneyCard } from './OnboardingJourneyCard';
import { tracking } from '@renderer/src/tracking';
import styles from './TheSparkPanel.module.css';

const AI_ICONS = [Zap, Brain, Lightbulb];

interface TheSparkPanelProps {
  onSelectUseCase: (prompt: string) => void;
  onOpenFile?: (relativePath: string) => void;
  /** Open the Journey progress view (AchievementHub Journey tab) */
  onOpenJourneyProgress?: () => void;
}

export function TheSparkPanel({
  onSelectUseCase,
  onOpenJourneyProgress,
}: TheSparkPanelProps) {
  const { settings } = useSettings();

  const {
    useCases: libraryUseCases,
    groupedUseCases,
    totalCount,
    recordUsage,
    markSeen,
    refresh: refreshLibrary,
  } = useUseCaseLibrary(3);

  // Fallback to settings-based use cases during transition period
  const settingsUseCases = settings?.personalizedUseCases ?? [];
  const useCases = libraryUseCases.length > 0 ? libraryUseCases : settingsUseCases;
  const hasUseCases = useCases.length > 0;

  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);
  const [isWorkflowsExpanded, setIsWorkflowsExpanded] = useState(false);

  useEffect(() => {
    tracking.spark.opened();
  }, []);

  const handleGenerate = useCallback(async () => {
    if (isGenerating) return;

    tracking.spark.workflowsRegenerateClicked();
    setIsGenerating(true);
    setError(null);

    try {
      const result = await window.dashboardApi.generateUseCases();
      tracking.spark.useCasesGenerated(result.count ?? 0, result.success);
      if (!result.success) {
        setError(result.error ?? 'Failed to generate use cases');
      } else {
        refreshLibrary();
      }
    } catch (err) {
      tracking.spark.useCasesGenerated(0, false);
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setIsGenerating(false);
    }
  }, [isGenerating, refreshLibrary]);

  const handleSelectUseCase = useCallback((prompt: string, id?: string, isNew?: boolean, title?: string) => {
    if (id) {
      recordUsage(id);
      if (isNew) {
        markSeen(id);
      }
      tracking.spark.useCaseSelected(id, title ?? 'Unknown', isNew ?? false);
    }
    onSelectUseCase(prompt);
  }, [onSelectUseCase, recordUsage, markSeen]);

  return (
    <div className={styles.container} data-testid="usecases-panel">
      <div className={styles.tabContent} data-scroll-container>
        <div className={styles.contentWrapper}>
          <ProgressCard />

          <div className={styles.discoveryRow}>
            <CommunityEventCard />
            <OnboardingJourneyCard
              onSelectUseCase={onSelectUseCase}
              onOpenJourneyProgress={onOpenJourneyProgress}
            />
          </div>

          <CommunityVideoRecsCard />

          <section className={styles.section}>
            <div data-tour="use-cases-section">
              <header className={styles.sectionHeader}>
                <div className={styles.sectionTitleRow}>
                  <h3 className={styles.sectionTitle}>Ways to put me to work</h3>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleGenerate}
                    className={styles.regenerateButton}
                    data-testid="regenerate-usecases-button"
                  >
                    <RefreshCw className={styles.buttonIcon} />
                  </Button>
                </div>
                <p className={styles.sectionSubtitle}>
                  I&apos;ve been watching your calendar and inbox. These seemed relevant.
                </p>
              </header>
              {error && <p className={styles.errorMessage}>{error}</p>}

              {isGenerating ? (
                <div className={styles.generatingWorkflows}>
                  <div className={styles.generatingSpinner}>
                    <Sparkles className={styles.generatingIcon} />
                  </div>
                  <p className={styles.generatingText}>
                    Looking through your emails, calendar, and tools...
                  </p>
                </div>
              ) : hasUseCases ? (
                <>
                  {!isWorkflowsExpanded ? (
                    <div className={styles.cardList}>
                      {useCases.slice(0, 3).map((useCase, index) => {
                        const IconComponent = AI_ICONS[index % AI_ICONS.length];
                        const isNew = 'isNew' in useCase && Boolean(useCase.isNew)
                          && ('newUntil' in useCase ? (useCase.newUntil as number) > Date.now() : true);
                        return (
                          <button
                            key={useCase.id}
                            className={styles.card}
                            onClick={() => handleSelectUseCase(useCase.prompt, useCase.id, isNew, useCase.title)}
                            type="button"
                            data-testid={`usecase-card-${index}`}
                          >
                            <div className={styles.iconWrapper}>
                              <IconComponent className={styles.icon} size={20} aria-hidden />
                            </div>
                            <div className={styles.content}>
                              <div className={styles.titleRow}>
                                <h3 className={styles.title}>{useCase.title}</h3>
                                {isNew && <Badge variant="default">New</Badge>}
                              </div>
                              <p className={styles.description}>{useCase.description}</p>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className={styles.expandedWorkflows}>
                      {groupedUseCases?.frequent && groupedUseCases.frequent.length > 0 && (
                        <div className={styles.workflowGroup}>
                          <h4 className={styles.groupLabel}>Your Workflows</h4>
                          <div className={styles.cardList}>
                            {groupedUseCases.frequent.map((useCase, index) => {
                              const IconComponent = AI_ICONS[index % AI_ICONS.length];
                              return (
                                <button
                                  key={useCase.id}
                                  className={styles.card}
                                  onClick={() => handleSelectUseCase(useCase.prompt, useCase.id, false, useCase.title)}
                                  type="button"
                                >
                                  <div className={styles.iconWrapper}>
                                    <IconComponent className={styles.icon} size={20} aria-hidden />
                                  </div>
                                  <div className={styles.content}>
                                    <div className={styles.titleRow}>
                                      <h3 className={styles.title}>{useCase.title}</h3>
                                      <span className={styles.usageCount}>{useCase.usageCount} uses</span>
                                    </div>
                                    <p className={styles.description}>{useCase.description}</p>
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                      {groupedUseCases?.new && groupedUseCases.new.length > 0 && (
                        <div className={styles.workflowGroup}>
                          <h4 className={styles.groupLabel}>New</h4>
                          <div className={styles.cardList}>
                            {groupedUseCases.new.map((useCase, index) => {
                              const IconComponent = AI_ICONS[index % AI_ICONS.length];
                              return (
                                <button
                                  key={useCase.id}
                                  className={styles.card}
                                  onClick={() => handleSelectUseCase(useCase.prompt, useCase.id, true, useCase.title)}
                                  type="button"
                                >
                                  <div className={styles.iconWrapper}>
                                    <IconComponent className={styles.icon} size={20} aria-hidden />
                                  </div>
                                  <div className={styles.content}>
                                    <div className={styles.titleRow}>
                                      <h3 className={styles.title}>{useCase.title}</h3>
                                      <Badge variant="default">New</Badge>
                                    </div>
                                    <p className={styles.description}>{useCase.description}</p>
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                      {groupedUseCases?.other && groupedUseCases.other.length > 0 && (
                        <div className={styles.workflowGroup}>
                          <h4 className={styles.groupLabel}>Suggestions</h4>
                          <div className={styles.cardList}>
                            {groupedUseCases.other.map((useCase, index) => {
                              const IconComponent = AI_ICONS[index % AI_ICONS.length];
                              return (
                                <button
                                  key={useCase.id}
                                  className={styles.card}
                                  onClick={() => handleSelectUseCase(useCase.prompt, useCase.id, false, useCase.title)}
                                  type="button"
                                >
                                  <div className={styles.iconWrapper}>
                                    <IconComponent className={styles.icon} size={20} aria-hidden />
                                  </div>
                                  <div className={styles.content}>
                                    <h3 className={styles.title}>{useCase.title}</h3>
                                    <p className={styles.description}>{useCase.description}</p>
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  {totalCount > 3 && (
                    <button
                      type="button"
                      className={styles.seeAllButton}
                      onClick={() => {
                        if (!isWorkflowsExpanded) {
                          tracking.spark.workflowsSectionExpanded(totalCount);
                        }
                        setIsWorkflowsExpanded(!isWorkflowsExpanded);
                      }}
                    >
                      {isWorkflowsExpanded ? 'Show less' : `See all ${totalCount} workflows`}
                    </button>
                  )}
                </>
              ) : (
                <div className={styles.emptyWorkflows}>
                  <Sparkles className={styles.emptyWorkflowsIcon} />
                  <p className={styles.emptyWorkflowsText}>
                    Generate personalized workflows based on your emails, calendar, and connected tools.
                  </p>
                  <Button
                    onClick={handleGenerate}
                    className={styles.generateButton}
                    data-testid="generate-usecases-button"
                  >
                    <Sparkles className={styles.buttonIcon} />
                    Generate Workflows
                  </Button>
                </div>
              )}
            </div>
          </section>
        </div>
      </div>

      <WhatsNewDialog
        open={whatsNewOpen}
        onOpenChange={setWhatsNewOpen}
        currentVersion={window.electronEnv?.appVersion ?? undefined}
        onTryFeature={(highlight) => {
          setWhatsNewOpen(false);
          onSelectUseCase(`Tell me about the "${highlight.title}" feature. ${highlight.description}`);
        }}
      />
    </div>
  );
}
