import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { getMeetingAnalysisPrompt } from '@core/services/meetingAnalysisPrompt';
import type { AgentAttachmentPayload, AgentEvent } from '@shared/types';

export interface MeetingAnalysisExecutionRequest {
  sessionId: string;
  resetConversation: boolean;
  prompt: string;
  attachments: AgentAttachmentPayload[];
  onEvent: (event: AgentEvent) => void;
}

export interface RunMeetingAnalysisFromTranscriptArgs {
  transcriptPath: string;
  workspaceRelativePath: string;
  sessionId: string;
  resetConversation: boolean;
  contextBlocks?: string[];
  onEvent?: (event: AgentEvent) => void;
  execute: (request: MeetingAnalysisExecutionRequest) => Promise<void>;
}

export function createMeetingAnalysisSessionId(prefix: 'meeting-analysis' | 'cloud-meeting-analysis' = 'meeting-analysis'): string {
  return `${prefix}-${randomUUID()}`;
}

function normalizeContextBlocks(contextBlocks?: string[]): string[] {
  return (contextBlocks ?? []).map((block) => block.trim()).filter(Boolean);
}

export function buildMeetingAnalysisPrompt(args: {
  transcriptPath: string;
  workspaceRelativePath: string;
  contextBlocks?: string[];
}): string {
  const blocks = normalizeContextBlocks(args.contextBlocks);

  const sections: string[] = [
    getMeetingAnalysisPrompt(),
    `[TRANSCRIPT REFERENCE]
- Absolute path: ${args.transcriptPath}
- Workspace-relative path for inbox reference: ${args.workspaceRelativePath}`,
  ];

  if (blocks.length > 0) {
    sections.push(...blocks);
  }

  sections.push('Please analyze the attached transcript and create an inbox item.');
  return sections.join('\n\n');
}

export async function createMeetingAnalysisAttachment(args: {
  transcriptPath: string;
  workspaceRelativePath: string;
}): Promise<AgentAttachmentPayload> {
  const [content, stats] = await Promise.all([
    fs.readFile(args.transcriptPath, 'utf8'),
    fs.stat(args.transcriptPath),
  ]);

  const fileName = args.transcriptPath.split(/[/\\]/).at(-1) ?? 'transcript.md';

  return {
    id: randomUUID(),
    name: fileName,
    path: args.transcriptPath,
    relativePath: args.workspaceRelativePath,
    size: stats.size,
    content,
  };
}

export async function runMeetingAnalysisFromTranscript(
  args: RunMeetingAnalysisFromTranscriptArgs,
): Promise<void> {
  const attachment = await createMeetingAnalysisAttachment({
    transcriptPath: args.transcriptPath,
    workspaceRelativePath: args.workspaceRelativePath,
  });

  const prompt = buildMeetingAnalysisPrompt({
    transcriptPath: args.transcriptPath,
    workspaceRelativePath: args.workspaceRelativePath,
    contextBlocks: args.contextBlocks,
  });

  await args.execute({
    sessionId: args.sessionId,
    resetConversation: args.resetConversation,
    prompt,
    attachments: [attachment],
    onEvent: args.onEvent ?? (() => undefined),
  });
}
