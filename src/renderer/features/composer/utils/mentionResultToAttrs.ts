import type { UnifiedMentionResult } from '@renderer/features/mentions';
import type { CommandTrigger, MentionAttrs } from './promptDoc';

export function mentionResultToAttrs(
  result: UnifiedMentionResult,
  getRelativeLibraryPath: (absolutePath: string) => string,
): MentionAttrs {
  if (result.kind === 'command') {
    return {
      kind: 'command',
      label: `@${result.command}`,
      command: result.command as CommandTrigger,
    };
  }

  if (result.kind === 'file') {
    const relativePath = getRelativeLibraryPath(result.node.path);
    return {
      kind: 'file',
      label: result.node.name,
      relativePath,
      nodeKind: result.node.kind,
    };
  }

  if (result.kind === 'model') {
    const sanitizedProfileName = result.profileName.replace(/[^\w\s.-]/g, '').trim();
    return {
      kind: 'model',
      label: `@model:${sanitizedProfileName || result.profileName}`,
      profileName: sanitizedProfileName || result.profileName,
    };
  }

  if (result.kind === 'operator') {
    return {
      kind: 'operator',
      label: result.operatorName,
      operatorSlug: result.operatorSlug,
      operatorId: result.operatorId,
      operatorName: result.operatorName,
    };
  }

  return {
    kind: 'conversation',
    label: result.title,
    conversationTitle: result.title,
    conversationId: result.id,
  };
}
