import type { HandlerInvokeEvent } from '@core/handlerRegistry';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppSettings } from '@shared/types';
import { createScopedLogger } from '@core/logger';
import { relativePortablePath } from '@core/utils/portablePath';
import { safeWalkDirectory } from '@core/utils/safeWalkDirectory';
import { registerHandler } from './utils/registerHandler';
import { hasValidAuth } from '../utils/authEnvUtils';
import { callBehindTheScenesWithAuth, getEffectiveModelName } from '../services/behindTheScenesClient';

const log = createScopedLogger({ service: 'scratchpadHandlers' });

export function getCosDirName(settings: AppSettings): string {
  const cosSpace = settings.spaces?.find(s =>
    s.type === 'chief-of-staff' || s.path.toLowerCase().replace(/\/$/, '') === 'chief-of-staff'
  );
  return cosSpace?.path.replace(/\/$/, '') || 'Chief-of-Staff';
}

function getMemoryFolderPath(settings: AppSettings): string {
  return `${getCosDirName(settings)}/memory`;
}

function getScratchpadRelativePath(settings: AppSettings): string {
  return `${getCosDirName(settings)}/memory/scratchpad.md`;
}

export interface ScratchpadHandlerDeps {
  getSettings: () => AppSettings;
}

interface MemoryFileInfo {
  path: string;
  relativePath: string;
  name: string;
  updatedAt: number;
}

async function scanMemoryFilesWithMtime(
  memoryPath: string,
  coreDirectory: string,
  excludedFolders: string[] = [],
  maxDepth: number = 5
): Promise<MemoryFileInfo[]> {
  const files: MemoryFileInfo[] = [];
  const excludedSet = new Set(excludedFolders.map(f => f.toLowerCase()));

  // Backed by safeWalkDirectory for cycle/depth/path-length protection
  // (see REBEL-506).
  await safeWalkDirectory(memoryPath, {
    maxDepth,
    onDirectory: ({ name }) => {
      if (name.startsWith('.')) return false;
      if (name === 'node_modules') return false;
      if (excludedSet.has(name.toLowerCase())) return false;
      return true;
    },
    onFile: async ({ absolutePath, name }) => {
      if (!name.endsWith('.md')) return;
      // Skip scratchpad.md itself
      if (name === 'scratchpad.md') return;

      try {
        const stat = await fs.stat(absolutePath);
        files.push({
          path: absolutePath,
          relativePath: relativePortablePath(coreDirectory, absolutePath),
          name,
          updatedAt: stat.mtimeMs,
        });
      } catch {
        // Skip files we can't stat
      }
    },
    onTruncated: ({ reasons, entriesVisited }) => {
      log.debug(
        { memoryPath, reasons, entriesVisited },
        'scanMemoryFilesWithMtime hit a traversal cap',
      );
    },
  });

  return files;
}

async function getMemoryFolderStructure(coreDirectory: string, settings: AppSettings): Promise<string[]> {
  const memoryPath = path.join(coreDirectory, getMemoryFolderPath(settings));
  const folders: string[] = [];

  // bounded-walker-pending: see docs/plans/260503_s9_bounded_walker_resource_budget.md
  const scan = async (dir: string, depth: number): Promise<void> => {
    if (depth > 3) return;

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          const relativePath = relativePortablePath(coreDirectory, path.join(dir, entry.name));
          folders.push(relativePath);
          await scan(path.join(dir, entry.name), depth + 1);
        }
      }
    } catch {
      // Ignore unreadable directories
    }
  };

  await scan(memoryPath, 0);
  return folders;
}

const _LOCATION_SUGGESTION_SCHEMA = {
  type: 'object',
  properties: {
    suggestedFolder: {
      type: 'string',
      description: 'Relative path from workspace root, e.g., "Chief-of-Staff/memory/topics"'
    },
    suggestedFilename: {
      type: 'string',
      description: 'Filename with .md extension, e.g., "api-webhooks.md"'
    },
    reasoning: {
      type: 'string',
      description: 'Brief explanation of why this location was chosen'
    }
  },
  required: ['suggestedFolder', 'suggestedFilename', 'reasoning'],
  additionalProperties: false
};

export function buildNoteLocationPrompt(content: string, folderStructure: string[], cosDir: string): string {
  return `You are helping organize notes in a personal knowledge system.

Given the following note content and existing folder structure, suggest where to save this note.

## Note Content
${content.slice(0, 1000)}

## Existing Folders in Memory
${folderStructure.length > 0 ? folderStructure.join('\n') : `${cosDir}/memory/topics (default)`}

Rules:
- Suggest an existing folder if the topic fits, otherwise suggest creating under "${cosDir}/memory/topics"
- Filename should be lowercase, hyphenated, descriptive (e.g., "meeting-prep-q1.md")
- Prefer "${cosDir}/memory/topics/" for general notes
- Use "${cosDir}/memory/conversations/" only for conversation logs
- Keep the reasoning brief (1 sentence)

Respond with ONLY a JSON object (no markdown, no extra text):
{"suggestedFolder": "...", "suggestedFilename": "...", "reasoning": "..."}`;
}

async function suggestNoteLocation(
  content: string,
  folderStructure: string[],
  settings: AppSettings
): Promise<{ suggestedFolder: string; suggestedFilename: string; reasoning: string }> {
  const cosDir = getCosDirName(settings);
  const prompt = buildNoteLocationPrompt(content, folderStructure, cosDir);

  log.debug({ model: getEffectiveModelName(settings) }, 'Calling LLM for note location suggestion');

  const response = await callBehindTheScenesWithAuth(settings, {
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 1024,
    timeout: 15000
  }, { category: 'scratchpad' });

  const textContent = response.content?.[0];
  if (textContent?.type === 'text' && textContent.text) {
    // Parse the response - LLM should return JSON-like structure
    const text = textContent.text;
    
    // Try to extract structured data from the response
    // Look for JSON block or parse the text
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          suggestedFolder: parsed.suggestedFolder || `${cosDir}/memory/topics`,
          suggestedFilename: parsed.suggestedFilename || 'untitled-note.md',
          reasoning: parsed.reasoning || 'Default location for general notes'
        };
      } catch {
        // Fall through to text parsing
      }
    }

    // Fallback: generate from content
    const words = content.slice(0, 50).toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2)
      .slice(0, 4);
    
    const filename = words.length > 0 
      ? `${words.join('-')}.md`
      : `note-${Date.now()}.md`;

    return {
      suggestedFolder: `${cosDir}/memory/topics`,
      suggestedFilename: filename,
      reasoning: 'Saved to topics folder based on content'
    };
  }

  throw new Error('Unexpected response format from LLM');
}

export function registerScratchpadHandlers(deps: ScratchpadHandlerDeps): void {
  const { getSettings } = deps;

  registerHandler(
    'scratchpad:load',
    async (_event: HandlerInvokeEvent, _payload: Record<string, never>) => {
      const settings = getSettings();
      const coreDirectory = settings.coreDirectory;

      if (!coreDirectory) {
        return { content: '', exists: false };
      }

      const scratchpadPath = path.join(coreDirectory, getScratchpadRelativePath(settings));

      try {
        const [content, stat] = await Promise.all([
          fs.readFile(scratchpadPath, 'utf-8'),
          fs.stat(scratchpadPath)
        ]);
        log.info({ scratchpadPath, contentLength: content.length }, 'Loaded scratchpad');
        return { content, exists: true, lastModified: stat.mtimeMs };
      } catch {
        log.info({ scratchpadPath }, 'Scratchpad file not found, returning empty');
        return { content: '', exists: false, lastModified: null };
      }
    }
  );

  registerHandler(
    'scratchpad:save',
    async (_event: HandlerInvokeEvent, payload: { content: string }) => {
      const settings = getSettings();
      const coreDirectory = settings.coreDirectory;

      if (!coreDirectory) {
        throw new Error('Workspace not configured');
      }

      const scratchpadPath = path.join(coreDirectory, getScratchpadRelativePath(settings));
      const memoryDir = path.dirname(scratchpadPath);

      log.info({ scratchpadPath, contentLength: payload.content.length }, 'Saving scratchpad');

      // Ensure directory structure exists
      try {
        await fs.mkdir(memoryDir, { recursive: true });
      } catch {
        // Directory might already exist, that's fine
      }

      // Write the file
      await fs.writeFile(scratchpadPath, payload.content, 'utf-8');
      log.info({ scratchpadPath }, 'Scratchpad saved successfully');
      
      return { success: true };
    }
  );

  registerHandler(
    'scratchpad:list-recent-memory-files',
    async (_event: HandlerInvokeEvent, payload: { limit?: number }) => {
      const settings = getSettings();
      const coreDirectory = settings.coreDirectory;

      if (!coreDirectory) {
        log.warn('No core directory configured');
        return [];
      }

      const memoryPath = path.join(coreDirectory, getMemoryFolderPath(settings));
      const limit = payload?.limit ?? 5;
      const excludedFolders = settings.scratchpad?.excludedFolders ?? ['meetings'];

      try {
        const files = await scanMemoryFilesWithMtime(memoryPath, coreDirectory, excludedFolders);

        // Sort by mtime descending and limit
        files.sort((a, b) => b.updatedAt - a.updatedAt);
        const recentFiles = files.slice(0, limit);

        log.info({ 
          memoryPath,
          totalFound: files.length, 
          returning: recentFiles.length,
          files: recentFiles.map(f => ({ 
            name: f.name, 
            mtime: new Date(f.updatedAt).toISOString() 
          }))
        }, 'Listed recent memory files');
        return recentFiles;
      } catch (error) {
        log.error({ error }, 'Failed to list recent memory files');
        return [];
      }
    }
  );

  registerHandler(
    'scratchpad:suggest-location',
    async (_event: HandlerInvokeEvent, payload: { content: string }) => {
      const settings = getSettings();
      const coreDirectory = settings.coreDirectory;

      if (!coreDirectory) {
        throw new Error('Workspace not configured');
      }

      if (!hasValidAuth(settings)) {
        // Fallback without LLM
        const words = payload.content.slice(0, 50).toLowerCase()
          .replace(/[^a-z0-9\s]/g, '')
          .split(/\s+/)
          .filter(w => w.length > 2)
          .slice(0, 4);

        return {
          suggestedFolder: `${getCosDirName(settings)}/memory/topics`,
          suggestedFilename: words.length > 0 ? `${words.join('-')}.md` : `note-${Date.now()}.md`,
          reasoning: 'No valid auth configured - using default location'
        };
      }

      try {
        const folderStructure = await getMemoryFolderStructure(coreDirectory, settings);
        const suggestion = await suggestNoteLocation(payload.content, folderStructure, settings);
        
        log.info({ folder: suggestion.suggestedFolder, filename: suggestion.suggestedFilename }, 
          'Suggested note location');
        
        return suggestion;
      } catch (error) {
        log.error({ error }, 'Failed to suggest note location');
        
        // Fallback
        const words = payload.content.slice(0, 50).toLowerCase()
          .replace(/[^a-z0-9\s]/g, '')
          .split(/\s+/)
          .filter(w => w.length > 2)
          .slice(0, 4);

        return {
          suggestedFolder: `${getCosDirName(settings)}/memory/topics`,
          suggestedFilename: words.length > 0 ? `${words.join('-')}.md` : `note-${Date.now()}.md`,
          reasoning: 'Using default location'
        };
      }
    }
  );

  log.info('Registered scratchpad IPC handlers');
}
