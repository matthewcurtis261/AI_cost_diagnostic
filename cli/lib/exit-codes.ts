/** CLI exit codes for CI and scripting. */
export const ExitCode = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  POLICY_FAIL: 3,
  SCAN_TIMEOUT: 4,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];
