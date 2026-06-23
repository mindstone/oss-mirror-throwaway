import type { MutableRefObject } from 'react';
import { DOMAIN_QUIPS } from './quipDomains';

export type PersonaDurationBucket = 'intro' | 'short' | 'medium' | 'long' | 'extended' | 'marathon' | 'saga' | 'epic';

export type PersonaState =
  | 'processing_intro'
  | 'processing_short'
  | 'processing_medium'
  | 'processing_long'
  | 'processing_extended'
  | 'processing_marathon'
  | 'processing_saga'
  | 'processing_epic'
  | 'generation_intro'
  | 'generation_short'
  | 'generation_medium'
  | 'generation_long'
  | 'generation_extended'
  | 'generation_marathon'
  | 'generation_saga'
  | 'generation_epic';

export const PERSONA_QUIP_ROTATION_MS = 6500;

/** Delay before showing tips/quips - show '...' before this threshold */
export const PERSONA_QUIP_DELAY_MS = 4000;

/** Duration of the tip phase before switching to quips (ms) */
export const TIP_PHASE_DURATION_MS = 6500;

/** Threshold after which we request dynamic Haiku-generated quips (ms) */
export const DYNAMIC_QUIP_THRESHOLD_MS = 30_000;

/**
 * Tool category for user-friendly quip selection.
 * Maps internal tool names to broad activity categories.
 */
export type ToolCategory = 'search' | 'read' | 'write' | 'command' | 'web' | 'agent' | 'unknown';

const PERSONA_QUIPS: Record<PersonaState, readonly string[]> = {
  processing_intro: [
    // Originals
    'Skimming your brief like a seasoned editor.',
    'Pinning the thesis to the board before we dive into details.',
    // Drawing from: cartography, archaeology, sommelier, conducting
    'Uncorking this request to let it breathe.',
    'Surveying the territory before committing to a route.',
    'Dusting off the first layer to see what we are working with.',
    'Tuning the orchestra before we play.',
    'Orienting the map to true north.',
    'Taking the measure of this particular puzzle.',
    'Letting the question settle before I start excavating.',
    'Reading the room. The room is your request.',
    'Establishing base camp.',
    'Noting the key signatures before the downbeat.',
    // watchmaking, bookbinding, glassblowing, lighthouse keeping
    'Adjusting the escapement. Time is a strict but fair witness.',
    'Pressing pages into order, like testimony that finally aligns.',
    'Gathering heat, shaping clarity, keeping my fingerprints off meaning.',
    'Tending the lamp. The fog is persuasive, but I am steadier.',
    'Warming the nib. Precision starts with a quiet wrist.'
  ],
  processing_short: [
    // Originals
    'Tidying the outline so the story arc doesn\'t wobble.',
    'Cross-stitching insights from past sessions into this one.',
    // Drawing from: chess, detective work, architecture, film editing
    'Developing the negatives to see what we actually captured.',
    'Plotting the vertices before connecting the lines.',
    'Interviewing the usual suspects in my memory.',
    'Checking the sight lines from every angle.',
    'Establishing the timeline of events.',
    'Laying out the blueprints on the drafting table.',
    'Considering the opening moves and their consequences.',
    'Assembling the dailies into a rough cut.',
    'Tracing the lineage of this particular problem.',
    'Cataloging the artifacts before interpretation.',
    // rare book appraisal, whisky blending, gemology, perfumery
    'Examining foxing and margins. Age has its own handwriting.',
    'Nosing the cask. Smoke, fruit, and an inconvenient truth.',
    'Inspecting inclusions. Perfection is overrated; clarity is negotiable.',
    'Blending top notes. First impressions are volatile and hard to subpoena.',
    'Testing hardness. Some answers scratch easily; others wear you down.'
  ],
  processing_medium: [
    // Originals
    'Fact-checking every claim as if an analyst is peering over my shoulder.',
    'Running a quick sanity lap around the data points.',
    // Drawing from: legal, medical, peer review, air traffic control
    'Cross-examining the evidence.',
    'Running diagnostics on my initial hypothesis.',
    'Checking for conflicts in the flight paths.',
    'Requesting a second opinion from my other neurons.',
    'Reviewing the case law on similar problems.',
    'Palpating the argument for weak spots.',
    'Auditing the chain of reasoning.',
    'Scanning for anomalies in the pattern.',
    'Subjecting this to peer review. The peer is also me.',
    'Verifying the provenance of each assumption.',
    // theatrical stage management, telescope operation, manuscript illumination
    'Calling cues. Everyone panics on schedule, like a well-rehearsed storm.',
    'Aligning the mount. The universe will not hold still for me.',
    'Grinding pigment. Even blue demands sacrifice and a steady hand.',
    'Checking the prop table. Reality is fragile and easily misplaced.',
    'Comparing facets under light. Truth changes when you rotate it.'
  ],
  processing_long: [
    // Originals
    'Filing away tangents so the main thread stays taut.',
    'Re-reading the brief aloud (in my head) for clarity.',
    // Drawing from: restoration, diplomacy, curation, cartography
    'Restoring the original colors beneath the varnish.',
    'Negotiating between competing interpretations.',
    'Deciding what belongs in the exhibition and what stays in storage.',
    'Charting the coastline with appropriate precision.',
    'Letting the witnesses tell their versions before I synthesize.',
    'Aging this conclusion in oak until it is ready.',
    'Balancing the scales with appropriate deliberation.',
    'Annotating the margins before the final draft.',
    'Consulting the primary sources, not just the summaries.',
    'Giving due process to every consideration.',
    // deep sea diving, vintage car restoration, calligraphy, archival science
    'Equalizing pressure. The depths insist, and I oblige without comment.',
    'Sanding rust away. The past fights back, but it is losing.',
    'Drawing a line that cannot be unsaid later.',
    'Acid-free folders, calm hands. History prefers gentle custody.',
    'Letting ink dry. Impatience smears the truth into abstraction.'
  ],
  processing_extended: [
    // Originals
    'Consulting the mental library card catalog.',
    'Pouring another cup of virtual coffee while I summarize this.',
    // Drawing from: excavation, navigation, orchestral, legal
    'Excavating carefully. This stratum is interesting.',
    'Recalculating the route after unexpected terrain.',
    'The second movement is always the most demanding.',
    'Reviewing the briefs from both sides.',
    'Descending to a deeper level of the dig.',
    'Holding the note while the harmony resolves.',
    'Sifting through the sediment for the telling fragments.',
    'The jury is still out. The jury is me.',
    'Taking the scenic route through this argument.',
    'Letting the flavors develop before plating.',
    // glassblowing, lighthouse keeping, bookbinding, whisky blending
    'Annealing this answer. Sudden cooling breeds cracks and regrets.',
    'Rotating the beam. Somewhere, confusion looks up and finds direction.',
    'Sewing signatures. Every stitch says, quietly, keep it together.',
    'Letting components marry. Some unions require time and silence.',
    'Checking the lens. Focus is a kindness to distant ships.'
  ],
  processing_marathon: [
    // Originals
    'Building Rome. Give me a minute.',
    'This one has layers—like an onion, or a well-structured codebase.',
    'Running calculations that would make a spreadsheet weep with joy.',
    'Consulting my inner committee. They are thorough.',
    // Drawing from: expedition, symphony, trial, archaeology
    'We have reached the third movement. Stay with me.',
    'The defense rests, but the deliberation continues.',
    'Base camp established. Now for the summit push.',
    'Brushing dirt from something significant.',
    'The expedition is proceeding on schedule.',
    'Conducting the climax of a particularly dense symphony.',
    'Unearthing the foundations of an argument.',
    'The closing arguments are being prepared.',
    // gemology, perfumery, manuscript illumination, telescope operation
    'Grading this thought. It shines, but it needs a steadier setting.',
    'Letting it macerate. The sharp parts soften into something usable.',
    'Laying gold leaf. My ego is not invited to the page.',
    'Waiting for clear seeing. Turbulence makes liars of fine lenses.',
    'Swimming through ink-dark water, chasing a glint of certainty.'
  ],
  processing_saga: [
    // Originals
    'This is the kind of problem that demands a second cup of coffee.',
    'Still here, still thinking. Neither of us is going anywhere.',
    'Untangling complexity. Not the fun kind.',
    'Good things take time. Great things take slightly more.',
    // Drawing from: odyssey, restoration, cartography
    'Charting waters that were not on the original map.',
    'The restoration is painstaking but the original is worth it.',
    'We have entered the uncharted portion of the journey.',
    'Stitching together fragments of a larger picture.',
    'The tribunal continues its deliberations.',
    'Navigating by the stars now.',
    'The dig site has expanded. So has the potential.',
    'This symphony has more movements than anticipated.',
    // vintage car restoration, archival science, deep sea diving, calligraphy
    'Tuning the engine. It coughs, then remembers its purpose.',
    'Cataloging fragments. Meaning arrives in boxes, not epiphanies.',
    'Rising slowly. Sudden insight can be dangerous at this depth.',
    'Practicing flourishes. Restraint is the hardest stroke to master.',
    'Checking metadata. Even ghosts leave filing errors behind.'
  ],
  processing_epic: [
    // Originals
    'This is officially a journey now. Thank you for your patience.',
    'Some say I am still thinking. They are right.',
    'We are past quick-task territory. This is a quest.',
    'Deep in thought. The finish line exists—I have seen it.',
    // Drawing from: odyssey, magnum opus, archaeology
    'We are writing the kind of analysis that gets footnoted.',
    'The excavation has revealed something worth the digging.',
    'Odysseus had it easier. He only faced sirens.',
    'The finale is being orchestrated as we speak.',
    'Drafting the treaty that ends this particular war.',
    'The treasure was real. Now to catalog it properly.',
    'Approaching the summit. The view will be worth it.',
    'The verdict is being written with appropriate ceremony.',
    // theatrical stage management, rare book appraisal, watchmaking
    'Holding the show together with tape, tact, and quiet menace.',
    'Weighing provenance like evidence. The paper remembers who touched it.',
    'Polishing gears until they stop arguing and start cooperating.',
    'Resetting the scene. Order returns, briefly, before the next act.',
    'Restoring a torn record. The past resists, then yields politely.'
  ],
  generation_intro: [
    // Originals
    'Color-coding the key arguments so nothing blurs together.',
    'Balancing headlines and footnotes so the narrative stays crisp.',
    // New - drawing from: composition, architecture, culinary
    'Choosing the key signature for this particular piece.',
    'Laying the first stones of the argument.',
    'Selecting ingredients for the main course.',
    'Sketching the elevation before we build.',
    'Finding the voice this response wants to have.',
    'Composing the opening bars.',
    'Preheating the oven. Metaphorically.',
    'Drafting in pencil before committing to ink.',
    'Setting the table before serving.',
    'Establishing the palette for this canvas.'
  ],
  generation_short: [
    // Originals
    'Translating bullet chaos into a calm paragraph.',
    'Highlighting the aha moments so they pop for you.',
    // New - drawing from: editing, sculpture, tailoring
    'Cutting the scene to its essential frames.',
    'Chiseling away what is not the statue.',
    'Taking in the seams for a better fit.',
    'The reduction is almost complete. Rich and concentrated.',
    'Editing for pace and clarity.',
    'Hemming to the proper length.',
    'Removing the scaffolding to reveal the structure.',
    'Tightening the bolts before delivery.',
    'Final seasoning. Almost ready to serve.',
    'The rough cut becomes the director\'s cut.'
  ],
  generation_medium: [
    // Originals
    'Checking the tone dial so the message lands just right.',
    'Making sure every section earns its seat at the table.',
    // New - drawing from: orchestration, architecture, curation
    'Balancing the brass against the strings.',
    'Ensuring the load-bearing walls are where they should be.',
    'Arranging the gallery for optimal flow.',
    'The sauce is thickening nicely.',
    'Checking the counterpoint between sections.',
    'Each exhibit is earning its place.',
    'The structure is sound. Now for the finishing.',
    'Harmonizing the voices into a coherent chorus.',
    'The blueprint is becoming a building.',
    'Adjusting the lighting before the opening.'
  ],
  generation_long: [
    // Originals
    'Spinning up a concise executive summary in the background.',
    'Lining up supporting quotes before we make the pitch.',
    // New - drawing from: composition, construction, cuisine
    'The symphony is reaching its development section.',
    'Installing the fixtures in the structure.',
    'The main course is plated. Sides incoming.',
    'Orchestrating the transition to the final movement.',
    'The frame is up. Now for the interior.',
    'Building to the crescendo with appropriate pacing.',
    'Laying the final courses of stone.',
    'The narrative arc is bending toward resolution.',
    'Finishing the joinery before the final polish.',
    'The meal is almost complete. Dessert pending.'
  ],
  generation_extended: [
    // Originals
    'Cueing the closing flourish once the facts align.',
    'Clocking token cadence to keep the story smooth.',
    // New - drawing from: symphony, epic, architecture
    'The recapitulation is underway.',
    'Adding the finishing touches to the facade.',
    'The denouement approaches.',
    'Burnishing the final surfaces.',
    'The coda is being composed.',
    'Closing the narrative loops with care.',
    'The last act is being staged.',
    'Installing the capstone.',
    'The final variation on the theme.',
    'Preparing the flourish that ends the piece.'
  ],
  generation_marathon: [
    // Originals
    'Polishing every sentence like it owes me money.',
    'Writing, re-writing, and re-re-writing. The usual.',
    'Almost there. "Almost" is doing some heavy lifting here.',
    'Crafting something worth the wait.',
    // New - drawing from: odyssey, symphony, construction
    'The final movement is being conducted with vigor.',
    'Ithaca is on the horizon.',
    'Laying the last bricks before the ribbon cutting.',
    'The crescendo builds toward resolution.',
    'Final inspections before occupancy.',
    'The orchestra is playing the closing passages.',
    'The journey nears its destination.',
    'Signing the final drawings.'
  ],
  generation_saga: [
    // Originals
    'Writing the kind of answer that deserves its own table of contents.',
    'Drafting. Editing. Questioning my life choices. Drafting again.',
    'If this were a movie, we would be in the training montage.',
    'The response is coming together. It is going to be good.',
    // New - drawing from: epic literature, magnum opus
    'The epic is reaching its climactic books.',
    'We are in the Return of the King portion of this trilogy.',
    'The final chapters are being illuminated.',
    'Writing the kind of conclusion that sticks the landing.',
    'The threads are converging toward resolution.',
    'Approaching the last verse of a long ballad.',
    'The opera nears its final aria.',
    'Penning what I hope will be a satisfying ending.'
  ],
  generation_epic: [
    // Originals
    'Writing a response that future archaeologists will study.',
    'At this point, I am basically writing a novella. You are welcome.',
    'The finish line exists. I have seen it. It is beautiful.',
    'Marathon complete. Crossing the finish line with style.',
    // New - drawing from: monument, odyssey, masterwork
    'The monument is nearly complete. It will endure.',
    'Odysseus is stepping onto the shores of home.',
    'The masterwork receives its final brushstrokes.',
    'The cathedral nears completion after all these years.',
    'Writing "THE END" in appropriately large letters.',
    'The symphony concludes with appropriate grandeur.',
    'Laying down the pen after a proper journey.',
    'What we built here today will last.'
  ]
};

/**
 * Tool-specific quips using user-friendly language.
 * Keyed by tool category, not raw tool names.
 */
const TOOL_QUIPS: Record<ToolCategory, readonly string[]> = {
  search: [
    'Hunting through your files like a particularly determined librarian.',
    'Looking for the needle. Found three haystacks so far.',
    'Scanning for matches with great enthusiasm.',
    'Rummaging through your codebase.',
    'Playing detective with your file system.',
    'Spelunking through directories.',
    'On the trail of something useful.',
    'Search party of one, reporting for duty.',
    'Looking high and low. Mostly low, where the good stuff hides.',
    'Sifting through the archive.',
    'Following the clues.',
    'Narrowing down the suspects.'
  ],
  read: [
    'Reading your files with appropriate reverence.',
    'Absorbing context like a responsible sponge.',
    'Taking a proper look at what we are working with.',
    'Studying the lay of the land.',
    'Getting acquainted with your code.',
    'Reading between the lines. And also the lines.',
    'Building a mental map of this territory.',
    'Reviewing what is already here.',
    'Learning the local customs.',
    'Consulting the existing documentation.',
    'Doing my homework on this file.',
    'Familiarizing myself with the neighborhood.'
  ],
  write: [
    'Making changes with surgical precision. Hopefully.',
    'Editing with care and mild anxiety.',
    'Putting words where words belong.',
    'Updating your files, as promised.',
    'Writing something new into existence.',
    'Applying changes, crossing fingers.',
    'Committing characters to disk.',
    'Creating or modifying, as the situation demands.',
    'Wielding the edit power responsibly.',
    'Making adjustments to your satisfaction. I hope.',
    'Building something worth keeping.',
    'Putting the finishing touches on these files.'
  ],
  command: [
    'Running something in the terminal. Fingers crossed.',
    'Executing a command with confidence I may or may not deserve.',
    'Telling your system what to do. Politely.',
    'Firing off instructions.',
    'Working behind the scenes.',
    'Doing terminal things.',
    'Launching a process into the void.',
    'Running something that will hopefully work.',
    'Executing with cautious optimism.',
    'Pressing the metaphorical button.',
    'Invoking the command line.',
    'Making things happen in the shell.'
  ],
  web: [
    'Reaching out to the internet. It is reaching back.',
    'Fetching something from the great beyond.',
    'Making a request to the wider world.',
    'Connecting to external resources.',
    'Pulling in data from elsewhere.',
    'Consulting the oracle (the web).',
    'Going outside for information.',
    'Phoning a friend. The friend is a server.',
    'Grabbing something from the network.',
    'Downloading knowledge.',
    'Accessing remote wisdom.',
    'The web awaits. And delivers.'
  ],
  agent: [
    'Delegating to a colleague. They are very capable.',
    'Bringing in reinforcements.',
    'Handing off to a specialist.',
    'Divide and conquer mode engaged.',
    'Working with my assistant. Yes, I have one.',
    'Running a parallel operation.',
    'Outsourcing this bit to someone qualified.',
    'Two heads are better than one. Using both.',
    'Coordinating with another agent.',
    'Collaboration in progress. Results pending.',
    'Dispatching a helper.',
    'Distributing the cognitive load.'
  ],
  unknown: [
    'Doing something important. Trust me.',
    'Working on a task of mysterious provenance.',
    'Handling business.',
    'In progress, as they say.',
    'Making things happen.',
    'Doing what needs doing.',
    'Processing. That is all I can say.',
    'Working through the details.',
    'Executing with purpose.',
    'On the case.',
    'Making progress, one way or another.',
    'Keeping busy.'
  ]
};

/**
 * Categorize a tool name into a user-friendly category.
 */
export const categorizeToolName = (toolName: string): ToolCategory => {
  const name = toolName.toLowerCase();

  if (['grep', 'glob', 'search', 'find', 'list', 'ls'].some((t) => name.includes(t))) {
    return 'search';
  }
  if (['read', 'view', 'cat', 'get_file', 'show'].some((t) => name.includes(t))) {
    return 'read';
  }
  if (['write', 'edit', 'create', 'patch', 'update', 'delete', 'remove', 'mkdir'].some((t) => name.includes(t))) {
    return 'write';
  }
  if (['bash', 'shell', 'terminal', 'command', 'exec', 'run'].some((t) => name.includes(t))) {
    return 'command';
  }
  if (['http', 'fetch', 'request', 'api', 'url', 'web', 'curl'].some((t) => name.includes(t))) {
    return 'web';
  }
  if (['agent', 'task', 'dispatch', 'delegate', 'subagent'].some((t) => name.includes(t))) {
    return 'agent';
  }
  return 'unknown';
};

export const getDurationBucket = (busyElapsedMs: number): PersonaDurationBucket => {
  if (busyElapsedMs >= 300_000) {
    return 'epic'; // 5+ minutes
  }
  if (busyElapsedMs >= 120_000) {
    return 'saga'; // 2-5 minutes
  }
  if (busyElapsedMs >= 60_000) {
    return 'marathon'; // 1-2 minutes
  }
  if (busyElapsedMs >= 45_000) {
    return 'extended';
  }
  if (busyElapsedMs >= 30_000) {
    return 'long';
  }
  if (busyElapsedMs >= 18_000) {
    return 'medium';
  }
  if (busyElapsedMs >= 8_000) {
    return 'short';
  }
  return 'intro';
};

export const buildPersonaState = (stage: 'generation' | 'processing', busyElapsedMs: number): PersonaState => {
  return `${stage}_${getDurationBucket(busyElapsedMs)}` as PersonaState;
};

/**
 * Shuffle domain quips once at module load for mixed variety.
 * Fisher-Yates shuffle ensures uniform distribution.
 */
const shuffledDomainQuips = [...DOMAIN_QUIPS];
for (let i = shuffledDomainQuips.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [shuffledDomainQuips[i], shuffledDomainQuips[j]] = [shuffledDomainQuips[j], shuffledDomainQuips[i]];
}

/** Cursor for the shared domain quip pool */
let domainQuipCursor = 0;

export const getNextPersonaQuip = (
  state: PersonaState,
  cursorRef: MutableRefObject<Record<PersonaState, number | undefined>>
): string => {
  const stateQuips = PERSONA_QUIPS[state];
  const stateIndex = cursorRef.current[state] ?? 0;

  // First cycle through state-specific quips (duration-appropriate)
  if (stateQuips && stateIndex < stateQuips.length) {
    cursorRef.current[state] = stateIndex + 1;
    return stateQuips[stateIndex];
  }

  // Then draw from shared shuffled domain pool (maximum variety)
  if (shuffledDomainQuips.length === 0) {
    // Fallback: loop state quips if no domain quips
    if (stateQuips && stateQuips.length > 0) {
      const loopIndex = stateIndex % stateQuips.length;
      cursorRef.current[state] = stateIndex + 1;
      return stateQuips[loopIndex];
    }
    return '';
  }

  const quip = shuffledDomainQuips[domainQuipCursor];
  domainQuipCursor = (domainQuipCursor + 1) % shuffledDomainQuips.length;
  return quip;
};

/**
 * Get a quip for a specific tool being used.
 * Returns a tool-specific quip based on the tool category.
 */
export const getToolQuip = (
  toolName: string,
  cursorRef: MutableRefObject<Record<ToolCategory, number | undefined>>
): string => {
  const category = categorizeToolName(toolName);
  const options = TOOL_QUIPS[category];
  if (!options || options.length === 0) {
    return '';
  }
  const currentIndex = cursorRef.current[category] ?? 0;
  const nextIndex = (currentIndex + 1) % options.length;
  cursorRef.current[category] = nextIndex;
  return options[currentIndex];
};

/**
 * Quips for background/async agents that run independently without streaming tool events.
 * These communicate "delegated trust" rather than "watch me work".
 */
const BACKGROUND_AGENT_QUIPS: readonly string[] = [
  // Delegation metaphors
  'Off doing research. Will report back.',
  'Dispatched. Working independently.',
  'On assignment. Radio silence until there\'s something to report.',
  'Gone to investigate. You\'ll be the first to know.',
  // Trust/competence
  'Working the case in another room.',
  'Consulting sources. Discretion required.',
  'Gathering intelligence. Will debrief shortly.',
  'Running a parallel investigation.',
  // Dry wit
  'Sent a colleague. They\'re thorough.',
  'Delegated to someone who doesn\'t need supervision.',
  'My associate is handling this one.',
  'The B-team is actually quite good.'
];

/**
 * Get a quip for a background agent.
 * Uses a simple index-based rotation.
 */
export const getBackgroundAgentQuip = (index: number): string => {
  return BACKGROUND_AGENT_QUIPS[index % BACKGROUND_AGENT_QUIPS.length];
};
