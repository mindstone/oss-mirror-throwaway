# Dual Research

Ask the user: "What problem or question would you like the two researchers to investigate?"

Once they provide a topic, use the Task tool to launch BOTH of these subagents IN PARALLEL (in the same response):

1. `researcher-gpt5.2-high` (GPT-5.2 with high reasoning)
2. `researcher-opus4.7` (Claude Opus 4.7)

Both should receive the exact same prompt describing the research task.

After both complete, synthesize the findings:
- Note areas of agreement
- Highlight different perspectives or insights unique to each
- Identify any contradictions to investigate further
