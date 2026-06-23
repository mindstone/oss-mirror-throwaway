import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { repairSharedSkillAttribution } from '../skillAttributionRepairService';

describe('repairSharedSkillAttribution', () => {
  let workspaceDir: string;
  let sharedSpaceDir: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-attribution-repair-'));
    sharedSpaceDir = path.join(workspaceDir, 'General');
    await fs.mkdir(path.join(sharedSpaceDir, 'skills', 'ops', 'trusted-skill'), { recursive: true });
    await fs.mkdir(path.join(sharedSpaceDir, 'skills', 'ops', 'legacy-skill'), { recursive: true });
    await fs.mkdir(path.join(sharedSpaceDir, 'skills', 'ops', 'modified-legacy'), { recursive: true });
    await fs.mkdir(path.join(sharedSpaceDir, 'skills', 'design', 'MindstoneLP-UX-Copywriter'), { recursive: true });
    await fs.mkdir(path.join(sharedSpaceDir, 'skills', 'design', 'MindstoneLP-Product-Design-Ideation'), { recursive: true });
    await fs.mkdir(path.join(sharedSpaceDir, 'skills', 'design', 'MindstoneLP-UX-Auditor'), { recursive: true });

    await fs.writeFile(
      path.join(sharedSpaceDir, 'README.md'),
      `---
rebel_space_description: Shared company space
space_type: company
sharing: company-wide
---
`,
      'utf8',
    );

    await fs.writeFile(
      path.join(sharedSpaceDir, 'skills', 'ops', 'trusted-skill', 'SKILL.md'),
      `---
description: Trusted
author: "Team Member"
author_id: "user-123"
author_email: "anna@example.com"
author_source: "created"
---

Trusted
`,
      'utf8',
    );

    await fs.writeFile(
      path.join(sharedSpaceDir, 'skills', 'ops', 'legacy-skill', 'SKILL.md'),
      `---
description: Legacy
author: "Team Member"
---

Legacy
`,
      'utf8',
    );

    await fs.writeFile(
      path.join(sharedSpaceDir, 'skills', 'ops', 'modified-legacy', 'SKILL.md'),
      `---
description: Modified
author: "Team Member"
last_modified_by: "Someone Else"
last_modified_by_id: "user-999"
last_modified_at: "2026-03-20"
---

Modified
`,
      'utf8',
    );

    await fs.writeFile(
      path.join(sharedSpaceDir, 'skills', 'design', 'MindstoneLP-UX-Copywriter', 'SKILL.md'),
      `---
description: Trusted family one
author: "Team Member"
author_id: "user-123"
author_email: "anna@example.com"
author_source: "created"
---

Trusted family one
`,
      'utf8',
    );

    await fs.writeFile(
      path.join(sharedSpaceDir, 'skills', 'design', 'MindstoneLP-Product-Design-Ideation', 'SKILL.md'),
      `---
description: Trusted family two
author: "Team Member"
author_id: "user-123"
author_email: "anna@example.com"
author_source: "created"
---

Trusted family two
`,
      'utf8',
    );

    await fs.writeFile(
      path.join(sharedSpaceDir, 'skills', 'design', 'MindstoneLP-UX-Auditor', 'SKILL.md'),
      `---
description: Missing author but same family
---

Missing family attribution
`,
      'utf8',
    );
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it('repairs deterministic shared skills and skips modified ambiguous ones', async () => {
    const result = await repairSharedSkillAttribution(workspaceDir);

    expect(result.updated).toBe(2);
    expect(result.skipped).toBeGreaterThanOrEqual(2);

    const repaired = await fs.readFile(
      path.join(sharedSpaceDir, 'skills', 'ops', 'legacy-skill', 'SKILL.md'),
      'utf8',
    );
    expect(repaired).toContain('author_id: "user-123"');
    expect(repaired).toContain('author_email: "anna@example.com"');
    expect(repaired).toContain('author_source: "migrated"');

    const untouched = await fs.readFile(
      path.join(sharedSpaceDir, 'skills', 'ops', 'modified-legacy', 'SKILL.md'),
      'utf8',
    );
    expect(untouched).not.toContain('author_id: "user-123"');
    expect(untouched).not.toContain('author_source: "migrated"');
  });

  it('repairs missing authorship from a unique trusted family cluster', async () => {
    const result = await repairSharedSkillAttribution(workspaceDir);

    expect(result.updated).toBeGreaterThanOrEqual(2);

    const repaired = await fs.readFile(
      path.join(sharedSpaceDir, 'skills', 'design', 'MindstoneLP-UX-Auditor', 'SKILL.md'),
      'utf8',
    );

    expect(repaired).toContain('author: "Team Member"');
    expect(repaired).toContain('author_id: "user-123"');
    expect(repaired).toContain('author_email: "anna@example.com"');
    expect(repaired).toContain('author_source: "migrated"');
    expect(repaired).toContain('contributors:');
  });
});
