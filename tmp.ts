import { getStagedFileWhyText } from './src/renderer/features/inbox/utils/approvalWhyText.ts';

console.log(getStagedFileWhyText({
  blockedBy: 'safety_prompt',
  fileName: 'report.md',
  spaceName: 'General',
} as any));

console.log(getStagedFileWhyText({
  blockedBy: 'eval_error',
  fileName: 'data.csv',
  spaceName: 'Analytics',
} as any));
