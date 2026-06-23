---
description: "The Spark dashboard architecture — coaching insights, spaces synthesis, community highlights, workflows, IPC and services"
last_updated: "2026-01-25"
---

### Introduction

The Spark is a personalized dashboard tab in Mindstone Rebel's main UI that surfaces insights and suggestions when the agent is idle. It acts as a "launchpad, not dashboard"—prioritizing actionable content over passive information display.

The Spark contains four content types:
1. **Coaching Insights** – AI-generated reflections on completed conversations, surfacing missed opportunities
2. **Spaces Synthesis** – Weekly summaries of workspace activity, tailored to what the user cares about
3. **Community Highlights** – Trending topics from the Rebels Discourse forum
4. **Personalized Workflows** – AI-generated use case suggestions based on connected tools

**Note on Attention Suggestions**: The Spark tab shares some underlying data with the "Contextual Reveal" overlay (attention suggestions feature). Both use `dashboard:prefetch-attention-suggestions` and `dashboard:get-attention-suggestions` IPC channels. However, they serve different purposes:
- **The Spark** is the persistent dashboard tab shown when idle
- **Contextual Reveal** is a transient overlay triggered by specific user actions


### See Also

- [UI_LABS_BETA_DENOTATION](UI_LABS_BETA_DENOTATION.md) – Feature maturity badges (Labs, Beta); The Spark is marked as Labs
- [ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY](ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY.md) – Session model, history persistence; coaching evaluates completed sessions
- [ONBOARDING_SETUP_WIZARD](ONBOARDING_SETUP_WIZARD.md) – Onboarding generates initial personalized workflows
- [UI_LAYOUT_AND_INTERACTION_PATTERNS](UI_OVERVIEW.md) – App shell layout, how The Spark fits into the main UI
- [LIBRARY_AND_FILE_ACCESS](LIBRARY_AND_FILE_ACCESS.md) – Workspace model; Spaces Synthesis reads from workspace activity
- [MCP_CONFIGURATION](MCP_ARCHITECTURE.md) – MCP tools used for workflow generation (email, calendar)
- [SETTINGS_CONFIGURATION_AND_ENVIRONMENT](SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md) – Settings for `spacesActivityFocus`, `personalizedUseCases`

### Code References

#### Renderer Components
- `src/renderer/features/usecases/TheSparkPanel.tsx` – Main Spark container with Home/Spaces tab toggle
- `src/renderer/features/usecases/ProgressCard.tsx` – Personal goal display and edit header
- `src/renderer/features/usecases/SpacesActivityPanel.tsx` – Spaces synthesis and activity view
- `src/renderer/features/usecases/CoachingInsightsSection.tsx` – Coaching insight cards
- `src/renderer/features/usecases/CommunitySection.tsx` – Community highlight card
- `src/renderer/features/usecases/CommunityWhisper.tsx` – Minimal community teaser (when coaching is heavy)

#### Renderer Hooks
- `src/renderer/features/usecases/hooks/useSparkContent.ts` – Content prioritization logic
- `src/renderer/features/usecases/hooks/useSpacesSynthesis.ts` – Synthesis fetching with thinking animation
- `src/renderer/features/usecases/hooks/useCoachingInsights.ts` – Coaching data fetching
- `src/renderer/features/usecases/hooks/useCommunityHighlights.ts` – Community data subscription
- `src/renderer/features/usecases/hooks/useSpaceActivity.ts` – Raw space activity data

#### Main Process Services
- `src/main/services/spacesSynthesisService.ts` – AI synthesis generation
- `src/main/services/spacesSynthesisStore.ts` – Synthesis caching (24h TTL)
- `src/core/services/sessionCoachingService.ts` – LLM-based session evaluation
- `src/main/services/sessionCoachingScheduler.ts` – Background coaching scheduler
- `src/main/services/communityHighlightsService.ts` – Discourse API integration
- `src/main/ipc/dashboardHandlers.ts` – IPC endpoints for The Spark


### Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                         Renderer                              │
│  ┌─────────────────┐                                         │
│  │ TheSparkPanel   │ ─── Tab toggle (Home / Spaces)         │
│  │  └─GoalHeader   │ ─── Personal goal display/edit         │
│  └────────┬────────┘                                         │
│           │                                                   │
│  ┌────────┴────────────────────────────────────────┐        │
│  │                                                  │        │
│  ▼ Home Tab                    ▼ Spaces Tab                  │
│  ┌───────────────────┐        ┌────────────────────┐        │
│  │ CoachingInsights  │        │ SpacesActivityPanel│        │
│  │ Workflows Section │        │  - Focus onboard   │        │
│  │ CommunitySection  │        │  - SynthesisCard   │        │
│  │ CommunityWhisper  │        │  - SpaceCards      │        │
│  │ Curious? pills    │        └────────────────────┘        │
│  └───────────────────┘                                       │
│           │                            │                      │
│           ▼                            ▼                      │
│  ┌─────────────────────────────────────────────────┐        │
│  │              useSparkContent()                   │        │
│  │  Prioritization: coaching > community            │        │
│  └─────────────────────────────────────────────────┘        │
│           │                            │                      │
└───────────┼────────────────────────────┼──────────────────────┘
            │ IPC                        │ IPC
            ▼                            ▼
┌──────────────────────────────────────────────────────────────┐
│                      Main Process                             │
│  ┌────────────────────┐  ┌──────────────────────────┐       │
│  │ sessionCoaching-   │  │ spacesSynthesisService   │       │
│  │ Scheduler          │  │ + spacesSynthesisStore   │       │
│  │ + sessionCoaching- │  └──────────────────────────┘       │
│  │   Service          │                                      │
│  └────────────────────┘  ┌──────────────────────────┐       │
│                          │ communityHighlightsService│       │
│                          └──────────────────────────┘       │
└──────────────────────────────────────────────────────────────┘
```

**Data flow:**
1. Renderer hooks call IPC endpoints in `dashboardHandlers.ts`
2. Main process services fetch/generate data (LLM calls, Discourse API, filesystem)
3. Results are cached in electron-store and returned to renderer
4. `useSparkContent` prioritizes what to display based on content availability


### Coaching Insights

Session coaching analyzes completed conversations to identify "missed opportunities" where Rebel could have provided more value.

#### Eligibility Criteria
A session becomes eligible for coaching when:
- Resolved > 1 hour ago (gives user time to return)
- Has ≥ 3 user messages
- Not already evaluated
- Resolved within last 24 hours (gates by `now - session.resolvedAt`, not creation time)
- User hasn't resumed the session

#### Evaluation Process
1. `sessionCoachingScheduler` runs every 15 minutes
2. Finds eligible sessions and calls `sessionCoachingService.evaluateSessionForCoaching()`
3. LLM evaluates the transcript against quality criteria:
   - Insight must reference specific content from conversation
   - Must score ≥ 85/100 to be shown
   - Must include a ready-to-use continuation prompt
4. Results stored in `session-coaching` electron-store

#### Categories
- `deeper_research` – Could have dug deeper into a mentioned topic
- `related_context` – Related info exists in files/emails/calendar
- `document_generation` – Could have created an artifact
- `follow_up_action` – Obvious next step wasn't offered
- `cross_reference` – Could connect to another conversation

#### UI Behavior
- Insights appear at top of Home tab in `CoachingInsightsSection`
- Each card shows: insight text, source session title, timestamp
- Actions: "Explore this" (starts new turn with continuation prompt) or dismiss
- Maximum 2 evaluations per day to avoid notification fatigue

#### State Management
Coaching states: `pending` | `shown` | `acted` | `dismissed`
- `pending`: Evaluation generated, not yet displayed
- `shown`: User has seen the insight
- `acted`: User clicked "Explore this" and started a follow-up turn
- `dismissed`: User dismissed the insight
- `useSessionCoaching` hook listens for real-time updates via IPC
- `useCoachingInsights` enriches evaluations with session context


### Spaces Synthesis

Spaces Synthesis generates AI-powered summaries of workspace activity, personalized to what the user cares about.

#### Focus Configuration
On first visit to the Spaces tab, users set their "focus" – what they want Rebel to pay attention to (e.g., "team dynamics", "client work", "how my thinking evolves").

Focus is stored in `settings.spacesActivityFocus` and determines synthesis framing.

#### Generation Process
1. `spacesSynthesisService.getOrGenerateSynthesis()` gathers activity from last 7 days
2. `spaceActivityService.getSpaceActivity()` retrieves activity:
   - Memory activity sourced from `memoryHistoryStore.getMemoryHistory(...)`, grouped by space
   - Skill activity from filesystem scans for recent SKILL.md file modifications
3. Content is formatted and sent to user's selected Claude model
4. Response is parsed into two sections:
   - **Hook**: 2-3 sentence summary with dry wit
   - **Detail**: Themed breakdown organized by topic (not by space)

#### Prompt Voice
The synthesis uses Rebel's characteristic voice:
- Dry wit, never silly
- Cultural references (archaeology, symphonies, legal proceedings)
- Confident but humble
- Self-aware

Example tone: *"Your Work space evolved around exactly that. 12 memories about how your team communicates. Sarah wants bullets. Mike wants async. Design needs visuals. You're building a map of how your people think."*

#### Caching Strategy
- Synthesis cached in `spaces-synthesis` electron-store
- Cache valid for 24 hours
- Invalidated when focus changes
- User can force refresh via UI button

#### UI Components
- `SynthesisCard`: Expandable card with hook (always visible) and detail (collapsible)
- `FocusOnboarding`: First-time setup for focus preference
- `SpaceCard`: Per-space activity cards showing recent memories/skills


### Community Highlights

Fetches trending topics from the Rebels community forum (Discourse) to keep users connected to the community.

#### Data Source
- Endpoint: `https://rebels.mindstone.com/latest.json`
- Fetches top 5 topics ordered by activity
- Parses topic metadata: title, author, reply count, like count, views

#### Caching
- Results stored in `community-highlights` electron-store
- 24-hour TTL
- Stale cache fallback on fetch errors (offline resilience)

#### Display Rules
Community content is suppressed when coaching is rich:
- **≤ 1 coaching insight**: Show `CommunitySection` (full card)
- **≥ 2 coaching insights**: Show `CommunityWhisper` (minimal inline teaser)

This ensures coaching (higher value, personalized) takes priority over community (general interest).


### Content Prioritization

`useSparkContent` implements the "launchpad, not dashboard" principle by determining what content to display based on availability.

```typescript
interface SparkContent {
  heroCoaching: CoachingInsightWithContext | null;
  heroCommunity: CommunityHighlight | null;
  collapsedCoaching: CoachingInsightWithContext[];
  communityCard: CommunityHighlight | null;
  communityWhisper: CommunityHighlight | null;
}
```

**Prioritization rules:**
1. Coaching always wins for hero position
2. When coaching count ≥ 2, community section is suppressed
3. When coaching is heavy but community exists, show `communityWhisper`
4. Community card only shown when coaching ≤ 1


### Personalized Workflows

The "Or try one of these..." section shows AI-generated workflow suggestions based on connected tools.

#### Generation
- Triggered via "Generate Workflows" button or during onboarding
- Uses `useCaseGeneratorService.generatePersonalizedUseCases()`
- Analyzes emails, calendar, and connected tools
- Produces 3 personalized use case prompts

#### Storage
Results persisted in `settings.personalizedUseCases`:
```typescript
interface PersonalizedUseCase {
  id: string;
  title: string;
  description: string;
  prompt: string;
  icon?: string;      // Optional icon identifier (emoji or icon name)
  generatedAt: number; // When this use case was generated
}
```

#### Display
- Shows top 3 use cases as clickable cards
- Each card includes an icon—UI rotates through lucide icons (Zap, Brain, Lightbulb) rather than using the stored `icon` field
- Clicking a card sends the prompt to start a conversation


### Configuration

#### Settings Fields
| Setting | Type | Description |
|---------|------|-------------|
| `spacesActivityFocus` | `string \| undefined` | User's focus for synthesis |
| `personalizedUseCases` | `PersonalizedUseCase[]` | Generated workflow suggestions |

#### Dashboard IPC
| Channel | Purpose |
|---------|---------|
| `dashboard:get-space-activity` | Fetch raw space activity |
| `dashboard:get-spaces-synthesis` | Get/generate synthesis |
| `dashboard:generate-use-cases` | Generate personalized workflows |
| `dashboard:prefetch-attention-suggestions` | Background prefetch for attention suggestions |
| `dashboard:get-attention-suggestions` | Get cached attention suggestions |
| `dashboard:use-cases-ready` | Push event when personalized use cases are generated |

#### Coaching IPC
| Channel | Purpose |
|---------|---------|
| `misc:get-coaching-sessions` | Get session IDs with pending coaching insights |
| `misc:get-coaching-for-session` | Get coaching for specific session |
| `misc:update-coaching-state` | Update coaching state (shown/acted/dismissed) |
| `coaching:reflection` | Push event for new coaching |

#### Community IPC
| Channel | Purpose |
|---------|---------|
| `community:get-highlights` | Get cached community highlights from Rebels forum |
| `community:refresh-highlights` | Force refresh community highlights |
| `community:state` | Push event for community highlights updates |


### Troubleshooting

#### Coaching not appearing
- Check session has ≥ 3 messages and resolved > 1 hour ago
- Verify daily limit (2/day) not reached
- Check `session-coaching` store for evaluated session IDs
- Look for quality rating < 85 in logs

#### Synthesis not generating
- Verify `spacesActivityFocus` is set in settings
- Check `coreDirectory` is configured
- Look for API key issues in logs
- Check if cache is fresh (< 24h) and focus matches

#### Community highlights missing
- Check network connectivity
- Verify Discourse API is accessible
- Check `community-highlights` store for cached data
- Look for fetch errors in logs


### Future Work

- **Cross-session patterns**: Identify themes across multiple conversations
- **Proactive suggestions**: Surface coaching insights at relevant moments
- **Community integration**: Allow posting to forum directly from Rebel
- **Richer space types**: Support for project-specific synthesis rules
