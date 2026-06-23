import { createScopedLogger } from '@core/logger';
import { runConsult } from '@core/services/operatorConsultRunner';
import { OperatorConsultToolInputSchema, type OperatorConsultResult } from '@shared/types/operators';
import type { BuiltinToolContext, ToolExecutionResult } from './types';

const log = createScopedLogger({ service: 'operatorConsultTool' });

const stringifyJson = (value: unknown): string => JSON.stringify(value, null, 2);

function errorResult(message: string): ToolExecutionResult {
  return {
    output: message,
    isError: true,
  };
}

function marshalResult(result: OperatorConsultResult): ToolExecutionResult {
  if (result.isError) {
    if (result.operatorId || result.operatorName) {
      return errorResult(stringifyJson({
        isError: true,
        errorCode: result.errorCode,
        message: result.message,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.operatorId ? { operatorId: result.operatorId } : {}),
        ...(result.operatorName ? { operatorName: result.operatorName } : {}),
        ...(result.availableIds ? { availableIds: result.availableIds } : {}),
      }));
    }
    return errorResult(result.message);
  }

  if (result.calibrated && result.diaryAppendFailed) {
    log.warn(
      { operatorId: result.operatorId, operatorName: result.operatorName },
      'operator_consult_tool_diary_append_failed_disclosure_required',
    );
  }

  return {
    output: stringifyJson({
      ...result,
      ...(result.calibrated && result.diaryAppendFailed
        ? {
            warning:
              'The consult succeeded, but Rebel could not save it to the Operator diary. Disclose this briefly in the final answer.',
          }
        : {}),
    }),
    isError: false,
  };
}

export async function runOperatorConsultTool(
  input: unknown,
  context: BuiltinToolContext = {},
): Promise<ToolExecutionResult> {
  if (context.surfaceCapability !== 'desktop') {
    return errorResult('Operator consults use local Space files and are only available in the desktop app.');
  }

  const parsed = OperatorConsultToolInputSchema.safeParse(input);
  if (!parsed.success) {
    return errorResult('Operator consult input must include operatorId and focus.');
  }

  try {
    const result = await runConsult(parsed.data, context);
    return marshalResult(result);
  } catch (error) {
    return errorResult(
      error instanceof Error ? error.message : String(error),
    );
  }
}
