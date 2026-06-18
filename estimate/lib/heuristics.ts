import type { UsageAssumptions } from './types.js';

/** Default token heuristics per call type for code-only estimation. */
export const DEFAULT_HEURISTICS: Record<
  string,
  { avg_input_tokens: number; avg_output_tokens: number }
> = {
  chat_completion: { avg_input_tokens: 800, avg_output_tokens: 300 },
  embedding: { avg_input_tokens: 500, avg_output_tokens: 0 },
  image: { avg_input_tokens: 200, avg_output_tokens: 0 },
  speech: { avg_input_tokens: 400, avg_output_tokens: 0 },
  unknown: { avg_input_tokens: 600, avg_output_tokens: 200 },
};

export const DEFAULT_CALLS_PER_MONTH = 10_000;

export function resolveAssumptions(
  callType: string,
  findingId: string,
  fileAssumptions?: AssumptionsFileLike,
  callsPerMonth?: number,
): Required<Pick<UsageAssumptions, 'avg_input_tokens' | 'avg_output_tokens' | 'calls_per_month'>> {
  const perFinding = fileAssumptions?.findings?.[findingId];
  const defaults = fileAssumptions?.defaults ?? {};
  const heuristics = DEFAULT_HEURISTICS[callType] ?? DEFAULT_HEURISTICS.unknown;

  return {
    avg_input_tokens:
      perFinding?.avg_input_tokens ??
      defaults.avg_input_tokens ??
      heuristics.avg_input_tokens,
    avg_output_tokens:
      perFinding?.avg_output_tokens ??
      defaults.avg_output_tokens ??
      heuristics.avg_output_tokens,
    calls_per_month:
      perFinding?.calls_per_month ??
      defaults.calls_per_month ??
      callsPerMonth ??
      DEFAULT_CALLS_PER_MONTH,
  };
}

export interface AssumptionsFileLike {
  defaults?: UsageAssumptions;
  findings?: Record<string, UsageAssumptions>;
}

export function buildAssumedUsage(
  callType: string,
  findingId: string,
  assumptions?: AssumptionsFileLike,
  callsPerMonth?: number,
) {
  const resolved = resolveAssumptions(callType, findingId, assumptions, callsPerMonth);
  return {
    calls: resolved.calls_per_month,
    input_tokens: resolved.calls_per_month * resolved.avg_input_tokens,
    output_tokens: resolved.calls_per_month * resolved.avg_output_tokens,
    source: 'assumed' as const,
  };
}
