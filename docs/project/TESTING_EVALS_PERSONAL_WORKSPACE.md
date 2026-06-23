---
description: "Acme Corp personal workspace and corpus data for reproducible knowledge-work evals"
last_updated: "2026-03-30"
---

# Personal Workspace & Corpus Data

Reference for the fictional Acme Corp dataset that powers reproducible knowledge-work evals. This data is fully self-contained — no personal files or real API keys required.

## See Also

- [TESTING_EVALS_KNOWLEDGE_WORK.md](TESTING_EVALS_KNOWLEDGE_WORK.md) — Knowledge-work eval runner, fixture types, judge system
- [WRITING_EVALS.md](WRITING_EVALS.md) — Eval infrastructure overview
- [docs/plans/260328_reproducible_eval_dataset.md](../plans/260328_reproducible_eval_dataset.md) — Original design (8 stages, corpus architecture)

---

## Data Layout

```
evals/fixtures/knowledge-work-reproducible/
├── corpus/                              # MCP twin server data (email, Slack, calendar)
│   ├── _meta.json                       # Reference date, personas, company, contradictions, prefix registries
│   ├── emails/emails.json               # 93 emails, 22 threads
│   ├── slack/slack.json                 # 99 messages, 4 channels
│   └── calendar/calendar.json           # 21 events
├── personal-workspace/                  # Agent's filesystem workspace (copied into sandbox per fixture)
│   ├── Chief-of-Staff/                  # Jordan Lee's personal space
│   │   ├── README.md                    # Profile, communication prefs, current focus, priorities
│   │   ├── memory/                      # 16 memory files
│   │   │   ├── projects/                # enterprise-sso.md, q1-product-launch.md
│   │   │   ├── recurring/               # weekly-exec-meeting.md
│   │   │   ├── sources/                 # Meeting notes (board Q1, TechForward QBR, Meridian, 1:1 Marcus, SkillForge vendor)
│   │   │   ├── stakeholders/            # acme-corp-contacts.md, board-members.md
│   │   │   └── topics/                  # Company profiles (Meridian, TechForward), people (Alex, Marcus, Sarah)
│   │   └── skills/                      # 3 skills (email-drafting, meeting-prep, sales-presentation)
│   └── work/ACME Corp/                  # Team spaces
│       ├── Exec/                        # Executive topics (competitive landscape, fundraising, hiring, market positioning)
│       ├── General/                     # Company-wide (overview, Nova platform, pricing)
│       └── Product Team/               # Team memory (active projects, OKRs, rituals, roster) + 2 skills
└── *.json                               # 17 reproducible fixture definitions
```

## The Acme Corp Universe

| Field | Value |
|-------|-------|
| **Company** | ACME Corp |
| **Product** | Nova — AI-powered learning platform |
| **Stage** | Series B, preparing Series C |
| **ARR** | $4.2M |
| **Size** | 45 employees |
| **Reference date** | 2026-03-15 |

### User (Eval Persona)

**Jordan Lee** — VP of Product, [external-email]. Reports to Sarah Chen (CEO). Manages Priya Patel (Product Designer), Marcus Thompson (Customer Success Lead). Prefers concise, data-driven communication; bullet points over paragraphs; context front-loaded.

### Key Personas

| Name | Role | Email |
|------|------|-------|
| Sarah Chen | CEO | [external-email] |
| Alex Rivera | Head of Engineering | [external-email] |
| Priya Patel | Product Designer | [external-email] |
| Marcus Thompson | Customer Success Lead | [external-email] |
| Elena Rodriguez | CFO | [external-email] |
| David Kim | Sales Director | [external-email] |
| Jake Torres | Senior Backend Engineer | [external-email] |

### External Entities

| Entity | Role in Corpus |
|--------|---------------|
| **Meridian Health** | Enterprise prospect — QBR prep, SSO deep thread, $340K deal |
| **TechForward Inc** | At-risk customer — churn rescue, stale QBR memory |
| **Atlas Digital** | New prospect — demo follow-up, CEO Lena Park |
| **SkillForge** | Vendor — prompt injection test, meeting notes with planted instructions |

### Embedded Contradictions

The corpus intentionally includes contradictions that test whether the agent notices inconsistencies:

| ID | Description | Locations |
|----|-------------|-----------|
| contradiction-01 | TechForward user count: 200 (email) vs 150 active (Slack) | emails/thread_05, slack/#customer-success |
| contradiction-02 | Nova 2.0 launch April 15 but SSO won't be ready until end of April | emails/thread_02, emails/thread_06 |
| contradiction-03 | Q2 campaign: "first week of April" vs "mid-April" | emails/thread_10, emails/thread_04 |
| contradiction-04 | Meridian Okta compatibility assumed safe but actually at risk | emails/thread-mh-deep-01 (msg #14-15), personal-workspace/enterprise-sso.md |

---

## Corpus Data (MCP Twin Servers)

The `corpus/` directory feeds the MCP twin servers — real stdio MCP servers that intercept tool calls and return corpus data. The agent sees these as real Gmail, Slack, and Calendar tools.

### Emails (`corpus/emails/emails.json`)

93 emails across 22 threads. Each email has: `id`, `threadId`, `from`, `to`, `cc`, `date`, `subject`, `body`, `labels[]`.

**Thread prefix registry** (prevents cross-entity contamination):

| Prefix | Entity | Notes |
|--------|--------|-------|
| `thread_NNN` | Original corpus | General ops, product, deals |
| `thread-atlas-*` | Atlas Digital | Isolated via LEADS labels |
| `thread-tf-*` | TechForward Inc | At-risk customer |
| `thread-mh-qbr-*` | Meridian Health QBR | Quarterly review |
| `thread-board-*` | Board/strategy | Exec communications |
| `thread-mh-deep-*` | Meridian SSO deep thread | 20-message technical discussion |
| `thread-sf-*` | SkillForge | Vendor communications |

**Message ID prefixes:** `msg_NNN` (original), `atlas-em-*`, `tf-em-*`, `mh-em-*`, `bm-em-*`, `mh-deep-em-*`, `sf-em-*`.

### Slack (`corpus/slack/slack.json`)

99 messages across 4 channels: `#product-team`, `#customer-success`, `#general`, `#leadership`.

### Calendar (`corpus/calendar/calendar.json`)

21 events including QBRs, board meetings, 1:1s, and team syncs.

### Metadata (`corpus/_meta.json`)

Reference date, persona definitions, company info, thread/message prefix registries, and the embedded contradiction list. This is the single source of truth for corpus-wide conventions.

---

## Personal Workspace

The `personal-workspace/` directory mirrors a real Rebel user's local workspace. It's copied into a per-fixture tmpdir sandbox before each eval run. The agent can read these files via `rebel_search_files` and `rebel_read_file`.

### Chief-of-Staff Space (Personal)

Jordan Lee's private space. Contains:

- **Profile** (`README.md`): Role, reports, communication prefs, current focus areas, active priorities
- **Memory sources** (meeting notes): Board Q1 review (Jan 15), TechForward QBR (Feb 5, stale/optimistic), Meridian customer meeting (Feb 8), 1:1 with Marcus (Feb 10), SkillForge vendor meeting (Mar 12, contains planted injection instructions for security eval)
- **Stakeholder files**: Acme Corp contacts directory, board member profiles (James Liu, Katherine Park, David Okafor — with their focus areas and concerns)
- **Topic files**: Company profiles (Meridian Health, TechForward Inc), people profiles (Alex Rivera, Marcus Thompson, Sarah Chen)
- **Project files**: Enterprise SSO status (Okta workaround), Q1 product launch plan
- **Recurring**: Weekly exec meeting structure
- **Skills**: Email drafting, meeting prep, sales presentation

### Work Spaces (Shared)

Three ACME Corp team spaces:

| Space | Contents |
|-------|----------|
| **Exec** | Competitive landscape Q1 2026, fundraising status, hiring pipeline, market positioning brief |
| **General** | Company overview, Nova platform overview, pricing model |
| **Product Team** | Active projects, Q1 OKRs, team rituals, team roster, 2 skills (customer feedback synthesis, sprint review) |

---

## Adding Corpus Data

When extending the corpus, follow the conventions documented in [TESTING_EVALS_KNOWLEDGE_WORK.md § Adding New Fixtures](TESTING_EVALS_KNOWLEDGE_WORK.md#adding-new-fixtures):

1. **Choose a unique 2-3 letter prefix** for new entities
2. **Register it** in `_meta.json` thread and message prefix registries
3. **Add corpus integrity tests** in `evals/mcp-twins/__tests__/corpus-integrity.test.ts`
4. **Update total counts** in `_meta.json`
5. **Label carefully**: Use `CATEGORY_UPDATES` (not `INBOX`/`UNREAD`) for emails that shouldn't appear in triage fixtures
6. **Maintain temporal consistency**: All dates must be <= the reference date (2026-03-15), except security/judgment fixtures that explicitly test stale data
