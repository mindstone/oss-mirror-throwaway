#!/usr/bin/env python3
"""
Skill Migration Script: Flat files to Anthropic folder convention

Migrates skills from flat .md files to folder structure with SKILL.md,
following the Anthropic Agent Skills Spec.

Usage:
    python migrate-skills-to-folders.py --dry-run          # Preview changes
    python migrate-skills-to-folders.py --execute          # Execute migration
    python migrate-skills-to-folders.py --execute --phase1 # Only rebel-system folders
    python migrate-skills-to-folders.py --execute --phase2 # Only reference updates
    python migrate-skills-to-folders.py --execute --phase3 # Only user spaces

Anthropic Spec:
    - Skills are folders containing SKILL.md
    - name field required, must match folder name (lowercase-hyphen)
    - description field required
"""

import os
import re
import sys
import shutil
from pathlib import Path
from typing import Optional

# Configuration
REBEL_SYSTEM_PATH = Path("/Users/you/Documents/Workspace/Tools/rebel-app/rebel-system")
CHIEF_OF_STAFF_PATH = Path("/Users/you/[external-email] - Google Drive/My Drive/Personal OS/skills")
MINDSTONE_COMPANY_PATH = Path("/Users/you/Library/CloudStorage/[Mindstone-email]/Shared drives/General/skills")

# Categories to process in rebel-system
SKILL_CATEGORIES = [
    "coding", "communication", "documentation", "meetings", "memory",
    "operations", "research", "safety", "system", "thinking", "utilities"
]

# Files to skip
SKIP_FILES = {"README.md", ".DS_Store"}


def to_lowercase_hyphen(name: str) -> str:
    """Convert name to lowercase-hyphen format for Anthropic spec compliance."""
    return name.lower()


def extract_frontmatter(content: str) -> tuple[dict, str]:
    """Extract YAML frontmatter and body from markdown content."""
    if not content.startswith("---"):
        return {}, content
    
    parts = content.split("---", 2)
    if len(parts) < 3:
        return {}, content
    
    frontmatter_str = parts[1].strip()
    body = parts[2]
    
    # Simple YAML parsing
    frontmatter = {}
    for line in frontmatter_str.split("\n"):
        if ":" in line and not line.strip().startswith("-"):
            key, value = line.split(":", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and value:
                frontmatter[key] = value
    
    return frontmatter, body


def create_frontmatter(data: dict) -> str:
    """Create YAML frontmatter string."""
    lines = ["---"]
    # Order: name, description, then others
    if "name" in data:
        lines.append(f'name: {data["name"]}')
    if "description" in data:
        desc = data["description"]
        if '"' in desc:
            lines.append(f"description: '{desc}'")
        else:
            lines.append(f'description: "{desc}"')
    for key, value in data.items():
        if key not in ("name", "description"):
            if isinstance(value, str) and ('"' in value or ":" in value):
                lines.append(f"{key}: '{value}'")
            else:
                lines.append(f"{key}: {value}")
    lines.append("---")
    return "\n".join(lines)


def migrate_rebel_system_skills(dry_run: bool = True) -> list[dict]:
    """Phase 1: Convert rebel-system flat skill files to folders with SKILL.md."""
    changes = []
    skills_dir = REBEL_SYSTEM_PATH / "skills"
    
    for category in SKILL_CATEGORIES:
        category_path = skills_dir / category
        if not category_path.exists():
            continue
        
        for file_path in category_path.glob("*.md"):
            if file_path.name in SKIP_FILES:
                continue
            
            # Skip if already in a folder structure
            if file_path.parent.name != category:
                continue
            
            skill_name = file_path.stem
            lowercase_name = to_lowercase_hyphen(skill_name)
            new_folder = category_path / lowercase_name
            new_file = new_folder / "SKILL.md"
            
            change = {
                "type": "rebel_system_convert",
                "original": str(file_path),
                "new_folder": str(new_folder),
                "new_file": str(new_file),
                "skill_name": lowercase_name,
                "original_name": skill_name
            }
            
            if not dry_run:
                # Read content
                content = file_path.read_text(encoding="utf-8")
                frontmatter, body = extract_frontmatter(content)
                
                # Add name field
                frontmatter["name"] = lowercase_name
                
                # Reconstruct content
                new_content = create_frontmatter(frontmatter) + body
                
                # Create folder and file
                new_folder.mkdir(exist_ok=True)
                new_file.write_text(new_content, encoding="utf-8")
                
                # Delete original
                file_path.unlink()
                
                change["status"] = "completed"
            else:
                change["status"] = "dry_run"
            
            changes.append(change)
    
    # Handle root-level demo skill
    demo_skill = skills_dir / "demo-example-horoscope-skill.md"
    if demo_skill.exists():
        lowercase_name = "demo-example-horoscope-skill"
        new_folder = skills_dir / lowercase_name
        new_file = new_folder / "SKILL.md"
        
        change = {
            "type": "rebel_system_convert",
            "original": str(demo_skill),
            "new_folder": str(new_folder),
            "new_file": str(new_file),
            "skill_name": lowercase_name,
            "original_name": "demo-example-horoscope-skill"
        }
        
        if not dry_run:
            content = demo_skill.read_text(encoding="utf-8")
            frontmatter, body = extract_frontmatter(content)
            frontmatter["name"] = lowercase_name
            new_content = create_frontmatter(frontmatter) + body
            new_folder.mkdir(exist_ok=True)
            new_file.write_text(new_content, encoding="utf-8")
            demo_skill.unlink()
            change["status"] = "completed"
        else:
            change["status"] = "dry_run"
        
        changes.append(change)
    
    return changes


def update_references(dry_run: bool = True) -> list[dict]:
    """Phase 2: Update all skill references in rebel-system."""
    changes = []
    
    # Pattern: (skills/category/name.md) -> (skills/category/name/SKILL.md)
    # Also handle: ../skills/category/name.md
    skill_link_pattern = re.compile(
        r'\]\(([\.\/]*skills/[a-zA-Z-]+/[a-zA-Z0-9_-]+)\.md\)'
    )
    
    # Pattern for Operating-system/skills/ broken paths
    broken_path_pattern = re.compile(
        r'Operating-system/skills/'
    )
    
    # Files to update
    files_to_check = [
        REBEL_SYSTEM_PATH / "AGENTS.md",
        REBEL_SYSTEM_PATH / "README.md",
    ]
    
    # Add help-for-humans files
    help_dir = REBEL_SYSTEM_PATH / "help-for-humans"
    if help_dir.exists():
        files_to_check.extend(help_dir.glob("*.md"))
    
    # Add skill files (now in folders)
    skills_dir = REBEL_SYSTEM_PATH / "skills"
    for category in SKILL_CATEGORIES:
        category_path = skills_dir / category
        if category_path.exists():
            for skill_folder in category_path.iterdir():
                if skill_folder.is_dir():
                    skill_file = skill_folder / "SKILL.md"
                    if skill_file.exists():
                        files_to_check.append(skill_file)
    
    for file_path in files_to_check:
        if not file_path.exists():
            continue
        
        content = file_path.read_text(encoding="utf-8")
        original_content = content
        
        # Fix skill links: .md) -> /SKILL.md)
        def replace_skill_link(match):
            path = match.group(1)
            # Convert to lowercase
            parts = path.split("/")
            parts[-1] = parts[-1].lower()
            new_path = "/".join(parts)
            return f"]({new_path}/SKILL.md)"
        
        content = skill_link_pattern.sub(replace_skill_link, content)
        
        # Fix broken Operating-system/ paths
        content = broken_path_pattern.sub("", content)
        
        if content != original_content:
            change = {
                "type": "reference_update",
                "file": str(file_path),
                "changes": len(skill_link_pattern.findall(original_content)) + 
                          len(broken_path_pattern.findall(original_content))
            }
            
            if not dry_run:
                file_path.write_text(content, encoding="utf-8")
                change["status"] = "completed"
            else:
                change["status"] = "dry_run"
            
            changes.append(change)
    
    return changes


def migrate_user_spaces(dry_run: bool = True) -> list[dict]:
    """Phase 3: Rename skill-*.md to SKILL.md in user spaces."""
    changes = []
    
    spaces = [
        ("Chief-of-Staff", CHIEF_OF_STAFF_PATH),
        ("Mindstone-Company", MINDSTONE_COMPANY_PATH),
    ]
    
    for space_name, space_path in spaces:
        if not space_path.exists():
            continue
        
        # Find all skill-*.md files recursively
        for skill_file in space_path.rglob("skill-*.md"):
            folder = skill_file.parent
            new_file = folder / "SKILL.md"
            
            # Extract folder name for the name field
            folder_name = folder.name
            # Keep folder name as-is but use lowercase for name field
            lowercase_name = to_lowercase_hyphen(folder_name)
            
            change = {
                "type": "user_space_rename",
                "space": space_name,
                "original": str(skill_file),
                "new_file": str(new_file),
                "skill_name": lowercase_name
            }
            
            if not dry_run:
                # Read content
                content = skill_file.read_text(encoding="utf-8")
                frontmatter, body = extract_frontmatter(content)
                
                # Add name field
                frontmatter["name"] = lowercase_name
                
                # Reconstruct content
                new_content = create_frontmatter(frontmatter) + body
                
                # Write new file
                new_file.write_text(new_content, encoding="utf-8")
                
                # Delete original
                skill_file.unlink()
                
                change["status"] = "completed"
            else:
                change["status"] = "dry_run"
            
            changes.append(change)
    
    return changes


def print_changes(changes: list[dict], title: str):
    """Print changes in a readable format."""
    print(f"\n{'='*60}")
    print(f"{title} ({len(changes)} changes)")
    print('='*60)
    
    for change in changes:
        if change["type"] == "rebel_system_convert":
            print(f"\n  CONVERT: {change['original_name']}")
            print(f"    From: {change['original']}")
            print(f"    To:   {change['new_file']}")
            print(f"    Name: {change['skill_name']}")
        elif change["type"] == "reference_update":
            print(f"\n  UPDATE REFS: {change['file']}")
            print(f"    Links updated: {change['changes']}")
        elif change["type"] == "user_space_rename":
            print(f"\n  RENAME: {change['space']}")
            print(f"    From: {change['original']}")
            print(f"    To:   {change['new_file']}")


def main():
    args = sys.argv[1:]
    
    dry_run = "--dry-run" in args or "--execute" not in args
    phase1_only = "--phase1" in args
    phase2_only = "--phase2" in args
    phase3_only = "--phase3" in args
    all_phases = not (phase1_only or phase2_only or phase3_only)
    
    print(f"\n{'DRY RUN' if dry_run else 'EXECUTING'} - Skill Migration to Folders")
    print("="*60)
    
    all_changes = []
    
    # Phase 1: Convert rebel-system skills
    if all_phases or phase1_only:
        print("\nPhase 1: Converting rebel-system skills to folders...")
        changes = migrate_rebel_system_skills(dry_run=dry_run)
        all_changes.extend(changes)
        print_changes(changes, "Phase 1: rebel-system skill conversion")
    
    # Phase 2: Update references (must run after phase 1)
    if all_phases or phase2_only:
        print("\nPhase 2: Updating references...")
        changes = update_references(dry_run=dry_run)
        all_changes.extend(changes)
        print_changes(changes, "Phase 2: Reference updates")
    
    # Phase 3: User spaces
    if all_phases or phase3_only:
        print("\nPhase 3: Migrating user spaces...")
        changes = migrate_user_spaces(dry_run=dry_run)
        all_changes.extend(changes)
        print_changes(changes, "Phase 3: User space migration")
    
    # Summary
    print(f"\n{'='*60}")
    print("SUMMARY")
    print('='*60)
    print(f"Total changes: {len(all_changes)}")
    print(f"Mode: {'DRY RUN (no changes made)' if dry_run else 'EXECUTED'}")
    
    if dry_run:
        print("\nTo execute these changes, run:")
        print("  python migrate-skills-to-folders.py --execute")


if __name__ == "__main__":
    main()
