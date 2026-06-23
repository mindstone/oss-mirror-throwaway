---
description: Launch all 7 reviewers in parallel to evaluate a plan before implementation
argument-hint: <optional focus area>
---

Launch all seven reviewer droids **in parallel** using the Task tool to evaluate a plan or proposal before implementation. Each reviewer brings a different perspective:

1. **reviewer-gpt5.5-high** - Fast, broad pattern recognition (GPT-5.5)
2. **reviewer-gemini3.1-pro** - Different perspective, catches blind spots
3. **reviewer-opus4.7-thinking** - Deep architectural analysis, long-term implications
4. **reviewer-glm5** - Independent verification, strong on correctness and edge cases
5. **reviewer-gpt5.3-codex** - Deep analysis with extra high reasoning (GPT-5.3-Codex)
6. **reviewer-kimi-k2.5** - Fresh perspective from independent model family
7. **reviewer-minimax2.7** - Agentic verification, strong on coding and implementation bugs

## Instructions

1. Summarize the plan being evaluated (goals, approach, key decisions)
2. Launch all 7 reviewers **simultaneously** in a single response using the Task tool
3. Each reviewer should receive:
   - The plan summary or link to planning document
   - Context about the problem being solved
   - Any constraints or requirements
   - Focus area (if provided): `$ARGUMENTS`
4. Wait for all reviews to complete
5. Synthesize findings into a unified report with:
   - **Consensus concerns** (flagged by multiple reviewers)
   - **Unique insights** (caught by only one reviewer)
   - **Alternative approaches** suggested
   - **Recommended adjustments** (prioritized by impact)

## Prompt template for each reviewer

> Evaluate this plan before implementation begins.
>
> **Plan summary:**
> <describe the plan, goals, and approach>
>
> **Problem context:**
> <what problem is this solving?>
>
> **Key decisions:**
> <list major architectural or design decisions>
>
> **Constraints:**
> <any requirements, deadlines, or limitations>
>
> **Focus area:** $ARGUMENTS
>
> Analyze the plan for:
> - Feasibility and completeness
> - Hidden risks or edge cases
> - Simpler alternatives that achieve the same goal
> - Dependencies or prerequisites that may be missing
> - Long-term maintainability implications
> - Whether the scope is right-sized (too big? too small?)
>
> Provide your confidence level (0-100%) and categorize concerns as "blocker" vs "consider".
