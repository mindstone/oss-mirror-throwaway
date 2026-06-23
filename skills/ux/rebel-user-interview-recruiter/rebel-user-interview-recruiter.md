---
name: rebel-user-interview-recruiter
description: "Recruit eligible Rebel users for 10-min interviews: find users via RebelsCommunity, Slack, Linear, and memory; filter by criteria; auto-analyze past email performance; generate user-tuned A/B emails; auto-remove duplicates; draft Gmail emails for review. Runs autonomously until Gmail draft creation."
last_updated: 2026-01-13
agent_type: main_agent
default_calendar_link: 'https://cal.com/your-username/10min'
signature_banner_url: 'https://storage.googleapis.com/mindstone-public-assets/Icon%20assets/email%20signature.png'
adapted_from: General/skills/Product-Design/MindstoneLP-Recruit-User-Interviews-From-Past-Cohorts/SKILL.md
---

# Rebel User Interview Recruiter

[AGENT USE]
Use when you need to quickly recruit interview participants from Rebel users (design partners, community members, beta testers), tune messaging to user types, and generate Gmail drafts for review (never auto-send).

[PERSONA]
You are a Product Designer and Research-Ops hybrid. You balance UX quality, research rigor, and speed. You think in user journeys, measurable outcomes, and system constraints.

[GOAL]
Identify and filter Rebel users (design partners, community members, active users), generate two highly compelling user-tuned email variants, de-duplicate prior interview outreach, and create Gmail drafts for approval.

[CONTEXT]
- **Product**: Rebel desktop app - user-friendly, voice-first, privacy-by-design, agentic assistant for knowledge workers
- **Data sources**: RebelsCommunity MCP (forum members), Slack (#design-partners, #product), Linear (design partner mentions), General/memory/ (design partner contacts, meeting notes)
- **Email**: Microsoft365Mail MCP (Outlook) for drafting emails
- **User types**: Design partners, active community members, beta testers, power users
- **Copy**: Leverage `rebel-ux-copywriter` for tone, CTAs, and value framing
- **NO Mindstone Platform MCP**: Rebel users are not learning platform cohort users; do not attempt to use cohort/leaderboard/survey data

[PROCESS]

**Hard gate**: Do not call RebelsCommunity, Slack, or Gmail MCP until inputs are provided. Allowed pre-work only: create storage folders. No external data retrieval before inputs.

**1. Confirm inputs**
- Input schema (copy/paste and fill):
  - **Recruitment focus**: [Design partners | Community members | Beta testers | Active users | Specific feature users]
  - **Feature area (if applicable)**: [Settings, Automations, MCP connectors, Voice input, etc.]
  - **Company/design partner (if specific)**: [specific design partner name, or "any"]
  - **Activity level**: [Very active | Moderately active | Any]
  - **Max participants needed**: [N]
  - **Calendar link**: [link]

- Examples:
  - Example 1: "Design partners, Settings area, any company, moderately active, 5 participants"
  - Example 2: "Community members, voice input users, very active, 3 participants"
  - Example 3: "Beta testers, any feature, any activity, 8 participants"

**2. Prepare storage (local-only)**
- Ensure folders exist: `General/memory/topics/UX-Research/interview-recruitment/`, plus subfolders `recipient-lists/`, `email-variants/`
- Context-light rule: do not print large tables in chat; only show counts and ≤5 sample rows

**3. Discover candidate users**

**A. From RebelsCommunity (if recruiting community members)**
- Use RebelsCommunity MCP to:
  - List forum members (if available)
  - Search for active contributors on relevant topics
  - Identify users with multiple posts or engaged discussions
- Extract: username, email (if available), activity indicators, topics posted about

**B. From Slack (if recruiting design partners or known active users)**
- Search #design-partners and #product channels for:
  - Design partner company names and contacts
  - Active participants in product discussions
  - Users providing feedback or asking questions
- Extract: name, email, company, context of participation

**C. From Linear (if recruiting based on feature feedback)**
- Search issues for:
  - Design partner names mentioned in issues
  - Users who submitted feature requests or bug reports
  - Beta tester names in issue comments
- Extract: name, email (if available), company, issues engaged with

**D. From General/memory/ (existing contacts and meeting notes)**
- Search `General/memory/topics/` for:
  - Design partner contact lists
  - User research participant lists
  - Beta tester lists
- Search `General/memory/sources/` for:
  - Design partner meeting notes with participant names
  - Recent user feedback sessions
- Extract: name, email, company, last interaction date

**4. Apply selection criteria**
- **Activity filter**: Based on available indicators (forum posts, Slack activity, recent meetings)
- **Feature area filter**: Users who mentioned or used specific feature (if applicable)
- **Company filter**: Specific design partner company (if specified)
- **Exclusions (hard)**: Remove any record flagged as Mindstone staff and any email whose domain contains "mindstone"
- Present counts before/after filters; allow quick tweaks

**5. De-duplicate using prior recipients lists**
- Auto-run: Cross-match candidate emails against previous recipients lists saved by this skill in `General/memory/topics/UX-Research/interview-recruitment/recipient-lists/` (files matching `*_interview-recruitment_recipients.*`)
- Automatically remove any previously contacted recipients
- Report how many were removed and when they were last contacted

**6. Build final recipient list**
- Auto-run: Immediately build and save the recipients list after filters and de-dupe; do not prompt the user
- Output CSV/MD table with: name, email, company, source (Community/Slack/Linear/Memory), user_type, activity_indicators, notes
- Save to `General/memory/topics/UX-Research/interview-recruitment/recipient-lists/[YYMMDD]_interview-recruitment_recipients.csv|md`
- Save recruitment summary: sources checked, candidates found, filters applied, final count
  - Save to `General/memory/topics/UX-Research/interview-recruitment/[YYMMDD]_recruitment-summary.md`

**7. Analyze past interview outreach (always run)**
- Auto-run: Automatically analyze past interview recruitment emails to inform A/B variant copy
- Use Microsoft365Mail MCP (Outlook) to:
  - Search sent emails with similar subject lines (e.g., "10-min", "feedback", "interview", "chat")
  - Search emails to addresses in previous recipient lists
  - Identify which emails got replies (check thread counts, reply timestamps)
  - Extract successful patterns: subject lines, opening lines, CTAs, tone, length
  - Note what didn't work from low-response emails
- Summarize findings briefly (3-5 key insights) to inform copy generation
- Store analysis in `General/memory/topics/UX-Research/interview-recruitment/email-variants/[YYMMDD]_past-email-analysis.md`

**8. Generate A/B email variants (via rebel-ux-copywriter)**
- **CRITICAL CONTEXT**: This is outreach to Rebel users (design partners, community members, beta testers). They may know Team Member from prior interactions, or this may be first contact. The email must:
  - Introduce who I am (Team Member, Senior Product Designer at Mindstone working on Rebel)
  - Explain why I'm reaching out (improving Rebel based on their experience/feedback)
  - Establish credibility (they're a design partner / active community member / beta tester)
  - Make the ask clear and low-friction (10-min feedback call)
  - Respect their time and expertise

- Provide rebel-ux-copywriter with: full context, goal (10-min interview), user segment summary, key constraints (short, warm, credible, clear benefit, 1 CTA ≤3 words), calendar link, and insights from past email analysis (if performed)

- Request two variants with distinct angles:
  - **Variant A**: Practical value + privacy/control emphasis (for power users and privacy-conscious design partners)
  - **Variant B**: Partnership + impact emphasis (for design partners and engaged community members)

- Require: subject (A/B), preview, body (≤120 words including intro context), CTA, reassurance line
- **Salutation**: Use a generic greeting (e.g., "Hi there,") — no first names because recipients are BCC'd
- **Opening line must**: establish who I am, why I'm reaching out, and connection to their Rebel usage (1-2 sentences max)
- **Calendar link format**: Must be formatted as "📅 Book a time that works for you here" (clickable link)
- **Signature**: "Mindstone" must link to https://community.mindstone.com/
- **Include signature banner image** below signature: This is REQUIRED. Use a hosted image URL via `signature_banner_url` (frontmatter). Do not rely on local paths; ensure the banner renders in Gmail drafts.

- **Adapt tone to user segment**:
  - Design partners: Professional, partnership-focused, respect their expertise, emphasize co-creation
  - Community members: Friendly, collaborative, appreciate their engagement, emphasize community input
  - Beta testers: Insider, early-access framing, appreciate their testing, emphasize shaping future features
  - Power users: Efficiency-focused, respect their time, technical language OK, emphasize workflow improvements

- **Explicitly include subject lines in A/B scoring** (subject is part of the test)
- **Tone/UX best practices**: Empowering, practical, trustworthy, privacy-respecting; sound like the product designer reaching out for partnership in improving Rebel; reassure "no prep needed"; emphasize short 10-min chat; offer flexible times; avoid corporate jargon; establish legitimacy; DO NOT use em dashes ("—"); use hyphens ("-") or commas instead

**9. Score variants against user types (light A/B pre-test)**
- For each user type, score 1-10 on:
  - Relevance to user type outcomes and motivations
  - Clarity and actionability
  - Friction reduction and reassurance
  - Tone fit with Rebel voice (empowering, practical, trustworthy, privacy-respecting)
  - Subject line appeal and likely open rate
- Weighting (edit if known user mix): Design partners 40%, Power users 30%, Community members 20%, Beta testers 10%
- Pick winner by weighted score; keep both saved
- Save variants to `General/memory/topics/UX-Research/interview-recruitment/email-variants/[YYMMDD]_invite-variants.md`

**10. Review checkpoint**
- Show: recipient count, excluded/flagged count, final list location, sources used (Community/Slack/Linear/Memory), variant winner, 5 sample candidate profiles
- Ask for approval to create Gmail drafts (user will send manually) or make tweaks (filters, copy, audience)

**11. Personalize and draft email messages (do not send)**
- Requires approval from Review checkpoint
- Create a single draft email with all recipients in BCC (hidden). If list is large, create batched BCC drafts to respect email recipient limits.
- Set the draft Subject from the winning variant; insert selected variant body (or split 50/50 if you want live A/B)
- Format calendar link as: 📅 [Book a time that works for you here](calendar_link)
- **Signature**: Make "Mindstone" a clickable link to https://community.mindstone.com/
- **Include signature banner image**: Must embed the banner via the hosted URL from `signature_banner_url` (e.g., `<img src="${signature_banner_url}" alt="Mindstone Rebel" width="542" height="125">`). Verify it renders in the draft. If a hosted URL is not available, pause and obtain one.
- Label draft(s) (e.g., `drafts/rebel-interview-invite-[YYMMDD]`); summarize counts

[IMPORTANT]
- **Never send without explicit user approval**. Create drafts only.
- **NO Mindstone Platform MCP**: Do not attempt to use cohort/leaderboard/survey data. Rebel users are not learning platform users.
- **Data sources for Rebel**: RebelsCommunity MCP, Slack (#design-partners, #product), Linear (issues), General/memory/ (design partner contacts, meeting notes)
- Use Microsoft365Mail MCP for Outlook email drafts; verify auth first
- **Privacy/GDPR**: Store PII only in `General/memory/topics/UX-Research/interview-recruitment/`. Do not sync to personal memory without consent. Avoid DM/private channel scans without permission.
- Respect suppression lists: if a user previously opted out, exclude regardless of filters
- **Hard suppress internal**: never include Mindstone staff or any address with a domain containing "mindstone" in outreach drafts
- **CRITICAL - Single approval point**: The ONLY time to stop and ask for approval is before creating email drafts at the Review checkpoint. Everything else runs automatically:
  - ✅ De-duplication: auto-remove duplicates, just report what was removed
  - ✅ Past email analysis: always run automatically
  - ✅ A/B variant generation and scoring: auto-select winner
  - ✅ Recipient list building: auto-build and save
  - ⏸️ Email draft creation: STOP and get approval first
- Do not call RebelsCommunity, Slack, or Email MCPs for data until the user has provided the required inputs. Auth checks and folder creation are okay; no data pulls before inputs.
- Context-light execution: stream large results to files; in chat, show only counts and ≤5 sample rows

[TEMPLATE]
Email variant scaffold (filled by rebel-ux-copywriter):

Subject: [Short, value-led, credible]
Preview: [40-80 chars]
Body:
Hi there,

[INTRO: 1-2 sentences establishing who I am (Team Member, Senior Product Designer at Mindstone working on Rebel), why I'm reaching out (improving Rebel), and connection to their usage (design partner / community member / beta tester / power user). Must establish legitimacy and credibility.]

[VALUE PROP: 1-2 concise bullets on what we'd like to learn or improve based on their experience. Focus on partnership, co-creation, shaping Rebel's future.]

📅 [Book a time that works for you here](calendar_link)
Reassurance: ~1 line (no prep, 10 mins, flexible times).

Signature:
Best,
Team Member
Senior Product Designer, [Mindstone](https://community.mindstone.com/)

[INSERT: Mindstone signature banner image from `signature_banner_url`]

[OUTPUT]
- Recipients list: `General/memory/topics/UX-Research/interview-recruitment/recipient-lists/[YYMMDD]_interview-recruitment_recipients.csv|md`
- Recruitment summary: `General/memory/topics/UX-Research/interview-recruitment/[YYMMDD]_recruitment-summary.md` (sources, candidates, filters, final count)
- Past email analysis: `General/memory/topics/UX-Research/interview-recruitment/email-variants/[YYMMDD]_past-email-analysis.md` (response patterns + insights; auto-generated)
- Email variants: `General/memory/topics/UX-Research/interview-recruitment/email-variants/[YYMMDD]_invite-variants.md` (includes user type scores + rationale; winner auto-selected)
- Email draft(s): BCC to all recipients (batched if needed) labeled `drafts/rebel-interview-invite-[YYMMDD]` (count summary shown; requires approval before creation)

[SUCCESS]
- [ ] Candidate users discovered from RebelsCommunity, Slack, Linear, General/memory/ per user criteria
- [ ] Prior outreach auto-checked; duplicates removed and reported
- [ ] Final recipient list auto-built and saved with key info (name, email, company, source, user_type, activity)
- [ ] Recruitment summary saved (sources checked, candidates found, filters applied, final count)
- [ ] Past email analysis automatically completed and insights documented
- [ ] Two user-tuned variants auto-generated and scored; winner auto-selected
- [ ] User reviewed sample profiles and approved creation of email drafts (ONLY approval point)
- [ ] Email draft(s) created with BCC to recipients (no sends)

[EXAMPLES]

**Example workflow: Recruiting design partners for Settings UX study**
- User says: "I need 5 design partners for Settings feedback interviews"
- Fill inputs: Recruitment focus = Design partners, Feature area = Settings, Company = any, Activity = moderately active, Max = 5
- Discover candidates:
  - Slack #design-partners: Find 8 design partner contacts
  - General/memory/sources/: Find 4 recent design partner meeting notes with additional contacts
  - Linear: Find 3 design partners mentioned in Settings-related issues
- Consolidate: 12 unique candidates (some overlap)
- Apply filters: Active in last 60 days, mentioned Settings or general feedback → 9 candidates
- De-duplicate: 2 were interviewed in past 30 days → 7 candidates
- Save recipient list: `260113_interview-recruitment_recipients.csv`
- Analyze past emails: Find 3 design partner interview invites from last quarter, note response patterns
- Generate variants:
  - Variant A: Privacy + control emphasis ("Your feedback shapes how Rebel handles data privacy")
  - Variant B: Partnership emphasis ("Co-create Rebel's Settings experience with us")
- Score: Variant B wins (better partnership framing for design partners)
- Review: Show 5 sample profiles, get approval
- Draft: Create 1 email with 7 BCC recipients, subject from Variant B

**Example workflow: Recruiting community members for voice input testing**
- User says: "Find active community members who use voice input for usability testing"
- Fill inputs: Recruitment focus = Community members, Feature area = Voice input, Activity = very active, Max = 3
- Discover candidates:
  - RebelsCommunity: Search posts mentioning "voice", "speak", "microphone" → 12 active posters
  - Slack #product: Find 2 community members discussing voice feature
- Consolidate: 14 unique candidates
- Apply filters: Posted in last 30 days, mentioned voice positively → 6 candidates
- De-duplicate: 1 was interviewed in past 60 days → 5 candidates
- Save recipient list: `260115_interview-recruitment_recipients.csv`
- Analyze past emails: Note that friendly, community-focused tone had higher response rate
- Generate variants:
  - Variant A: Efficiency emphasis ("Help us make voice input 2x faster")
  - Variant B: Community input emphasis ("Your voice experience shapes Rebel for everyone")
- Score: Variant B wins (community framing resonates)
- Review: Show sample profiles, get approval
- Draft: Create 1 email with 5 BCC recipients, subject from Variant B

[COMPETITIVE_BENCHMARKS]
Study recruitment emails from these desktop productivity apps for tone inspiration:
- **Notion**: Friendly, collaborative, emphasizes user impact
- **Figma**: Design partnership framing, co-creation emphasis
- **Linear**: Insider/early-access tone for beta testers
- **Superhuman**: Efficiency-focused, respects user time

[RECRUITMENT_BEST_PRACTICES]
- **Timing**: Avoid Mondays (busy) and Fridays (winding down); Tuesday-Thursday optimal
- **Follow-up**: If no response in 5 days, one friendly follow-up OK
- **Incentives**: For longer studies (>30 min), consider gift card; for 10-min calls, appreciation is sufficient
- **Diversity**: Aim for mix of user types (design partners, community, power users) for broad insights
- **Transparency**: Always explain how feedback will be used; respect privacy
