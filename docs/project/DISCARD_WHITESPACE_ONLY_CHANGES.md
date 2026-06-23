---
description: "Safety checklist for discarding whitespace-only git changes — diff inspection steps, verification rules, and bulk cleanup example"
last_updated: "2025-12-26"
---

# Discard Whitespace-Only Changes

Quick process to clean up accidental whitespace-only modifications before committing.

## Commands

```bash
# 1. Identify candidates - small changes are suspicious
git diff --stat

# 2. ALWAYS inspect actual content before discarding
git diff <file1> <file2> ...

# 3. Only discard after verifying diff shows ONLY whitespace
git checkout -- <file1> <file2> ...
```

## Safety Rules

1. **Never skip step 2** - a `| 1 +` could be one line of critical code
2. **Only discard if diff shows**: empty lines, trailing newlines, or spacing changes
3. **When in doubt, keep it** - you can always discard later

## Example

```bash
# Bulk discard multiple whitespace-only files
git checkout -- \
  docs/project/BUILDING.md \
  docs/project/CI_PIPELINE.md \
  src/shared/data/tips.ts
```
