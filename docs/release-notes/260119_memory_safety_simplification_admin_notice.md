# Memory Safety Architecture Simplification - Admin Notice

**Date:** January 19, 2026  
**Version:** 0.3.x  
**Priority:** Security fix + UX improvement

---

## Summary

This release simplifies how Rebel handles memory write approvals and **fixes a security vulnerability** where shared README.md files could override users' local safety preferences.

## What Changed

### Security Fix

**Before:** The `memoryTrust` field in shared README.md files could control whether users were prompted before saving to that space. A malicious or careless collaborator could set `memoryTrust: always_write` and affect everyone syncing that folder.

**After:** Safety settings are now stored **locally only** in each user's app settings. The `memoryTrust` field in README.md is completely ignored and will be automatically removed from files.

### Simplified Settings

**Before:** A complex 3-tier system:
- Tier 1: Global defaults (Private/Shared)
- Tier 2: Per-sharing-level fine-tuning
- Tier 3: Per-space overrides

**After:** One simple setting per space:
- **Save without asking** (permissive) - Only available for private spaces
- **Ask, if content is sensitive** (balanced) - Default for most spaces
- **Always ask before saving** (cautious) - For maximum control

### Chief-of-Staff is Special

Chief-of-Staff (the user's private notes space) is **always** set to "Save without asking" - no configuration needed or allowed. This ensures the user's personal workspace remains friction-free.

## What Users Will See

1. **Simplified Settings UI**: The Memory section now shows a simple list of spaces with their safety level
2. **Cleaner Approval Prompts**: New wording that clearly explains each option
3. **README.md Changes**: The `memoryTrust` field will be automatically removed from README.md files (cosmetic cleanup - the field was already being ignored)

## What Admins Should Know

### No Action Required

The migration is automatic and happens on app startup. Users' existing preferences are preserved using a "strictest wins" approach - if they had stricter settings before, they keep those settings.

### Future: Backend Org Policy

For enterprise deployments that need organization-wide policy enforcement (e.g., "this space requires always-ask for everyone"), we're working on a proper backend policy system. This will:
- Be fetched on app startup (authenticated)
- Provide audit trails
- Not rely on shared files that can be tampered with

Contact support if you have immediate needs for org-level policy enforcement.

### Sync Considerations

The `memoryTrust` cleanup may cause minor sync conflicts if multiple users have the same shared space open. This is harmless - the app ignores the field regardless of whether it's present, and the conflict can be resolved either way.

## Technical Details

- **Settings migration**: `spaceSafetyOverrides` and `memorySafetyBySharing` are migrated to a simple `spaceSafetyLevels: Record<string, 'permissive' | 'balanced' | 'cautious'>` structure
- **Safety floor**: Shared spaces enforce a minimum of `balanced` even if a user tries to set `permissive`
- **Chief-of-Staff detection**: Uses `space.type === 'chief-of-staff'` from local settings (not README frontmatter) to prevent spoofing

## Questions?

Contact Rebel support or refer to the updated `docs/project/MEMORY_SAFETY.md` for full technical documentation.
