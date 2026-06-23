---
description: Launch all 7 reviewers in parallel to review code changes from this conversation
argument-hint: <optional focus area>
---

Launch all seven reviewer droids **in parallel** using the Task tool to review the code changes made in this conversation. Each reviewer brings a different perspective:

1. **reviewer-gpt5.5-high** - Fast, broad pattern recognition (GPT-5.5)
2. **reviewer-gemini3.1-pro** - Different perspective, catches what others miss
3. **reviewer-opus4.7-thinking** - Deep architectural analysis, complex tradeoffs
4. **reviewer-glm5** - Independent verification, strong on correctness and edge cases
5. **reviewer-gpt5.3-codex** - Deep analysis with extra high reasoning (GPT-5.3-Codex)
6. **reviewer-kimi-k2.5** - Fresh perspective from independent model family
7. **reviewer-minimax2.7** - Agentic verification, strong on coding and implementation bugs

## Instructions

1. Summarize what was changed in this conversation (files modified, features added, refactors done)
2. Launch all 7 reviewers **simultaneously** in a single response using the Task tool
3. Each reviewer should receive:
   - A summary of the changes made in this conversation
   - The list of files that were created or modified
   - Instructions to read those files and understand the changes in context
   - Focus area (if provided): `$ARGUMENTS`
4. Wait for all reviews to complete
5. Synthesize findings into a unified report with:
   - **Consensus issues** (flagged by multiple reviewers)
   - **Unique findings** (caught by only one reviewer)
   - **Suggested actions** (prioritized by severity)

## Prompt template for each reviewer

> Review the code changes from this conversation.
>
> **Summary of changes:**
> <describe what was done>
>
> **Files to review:**
> <list files created/modified>
>
> **Focus area:** $ARGUMENTS
>
> Read the listed files to understand the implementation. Focus on:
> - Bugs, edge cases, correctness
> - Code quality and maintainability
> - Security and performance implications
> - Architectural fit with the existing codebase
>
> Provide your confidence level (0-100%) and categorize issues as "must fix" vs "consider".
