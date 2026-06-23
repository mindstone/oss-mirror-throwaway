---
description: Start a task — find or create a Linear ticket, move it to In Progress, and begin work
argument-hint: <task description or existing ticket ID, e.g. "FOX-123" or "add dark mode toggle to settings">
---

# Start Task

Start a coding task by ensuring a Linear ticket exists and is In Progress. Uses the Linear MCP integration.

## Step 0: Load Personal Defaults

Check for personal Linear defaults at `~/.factory/linear-defaults.json`:

```bash
cat ~/.factory/linear-defaults.json 2>/dev/null
```

This file should contain your team and assignee defaults:
```json
{
  "linear_team_id": "<your-team-uuid>",
  "linear_team_key": "<your-team-key, e.g. FOX>",
  "linear_assignee_id": "<your-linear-user-uuid>",
  "linear_project": "<optional-project-name-id-or-slug>"
}
```

If the file does not exist, tell the user:

> No personal Linear defaults found at `~/.factory/linear-defaults.json`.
>
> Create this file with your team and assignee info. Example:
> ```json
> {
>   "linear_team_id": "your-team-uuid",
>   "linear_team_key": "FOX",
>   "linear_assignee_id": "your-user-uuid"
> }
> ```
>
> You can find your team ID with `linear___list_teams` and your user ID with `linear___get_user(query="me")`.

Then ask the user for team and assignee info to proceed this time, and offer to create the file for them.

Store the loaded values as `$TEAM_ID`, `$TEAM_KEY`, `$ASSIGNEE_ID`, and optionally `$PROJECT`.

## Step 1: Determine if this is an existing ticket or new work

Parse `$ARGUMENTS`:

- **If it looks like a ticket ID** (matches pattern like `FOX-123`, `ABC-456`, i.e. `[A-Z]+-\d+`): go to Step 2a (fetch existing ticket).
- **Otherwise**: treat it as a task description, go to Step 2b (search / create).

## Step 2a: Fetch Existing Ticket

Use `linear___get_issue` with the ticket ID from `$ARGUMENTS`.

If found, skip to Step 3 (move to In Progress).

If not found, tell the user the ticket ID was not found and ask if they want to create a new one with the ID as the title.

## Step 2b: Search for Existing Tickets

Search Linear for issues that might match the task description:

```
linear___list_issues(
  team: $TEAM_KEY,
  query: <keywords from $ARGUMENTS>,
  state: "backlog,unstarted,triage",
  limit: 5
)
```

**If matching issues are found**: Present them to the user and ask:
> Found these potentially matching tickets:
> 1. `FOX-123` — Some title (Backlog)
> 2. `FOX-456` — Another title (Todo)
>
> Pick one to start, or say "new" to create a fresh ticket.

**If no matching issues found** (or user says "new"): Go to Step 2c.

## Step 2c: Create New Ticket

Create a new Linear issue using the MCP:

```
linear___save_issue(
  title: <concise title derived from $ARGUMENTS>,
  description: <fuller description from $ARGUMENTS, including any relevant context>,
  team: $TEAM_ID,
  assignee: $ASSIGNEE_ID,
  project: $PROJECT (if set in defaults),
  state: "In Progress"
)
```

When crafting the title:
- Keep it concise (under 80 chars)
- Use imperative mood (e.g. "Add dark mode toggle" not "Adding dark mode toggle")
- Include the key noun/feature

When crafting the description, include:
- The full task context from `$ARGUMENTS`
- The current git branch (`git rev-parse --abbrev-ref HEAD`)
- Any other relevant context from the conversation

Report the created ticket: "Created `FOX-XXX` — <title>"

Skip to Step 4.

## Step 3: Move to In Progress

If the ticket is not already In Progress, update it:

```
linear___save_issue(
  id: <ticket-id>,
  state: "In Progress",
  assignee: $ASSIGNEE_ID
)
```

If the ticket is already In Progress, just confirm: "Ticket `FOX-XXX` is already In Progress."

If the ticket is assigned to someone else, warn the user before reassigning:
> `FOX-XXX` is currently assigned to <name>. Reassign to you?

## Step 4: Confirm and Begin

Print a summary:

> **Task started**: `FOX-XXX` — <title>
> **Status**: In Progress
> **Assignee**: <name>
> **Branch**: `<current branch>`
>
> Ready to work. What would you like to do first?

## Important

- This command uses the Linear MCP tools (`linear___*`) — ensure the Linear integration is connected.
- Personal defaults live in `~/.factory/linear-defaults.json` (not committed to the repo).
- The command creates tickets with minimal required fields; add labels, priority, etc. manually or ask.
- If the user provides both a ticket ID and description (e.g. "FOX-123 add dark mode"), prefer the ticket ID and ignore the rest as context.
