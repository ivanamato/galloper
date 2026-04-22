// Verbosity level system for CLI output
// Level 0 (SILENT): No verbose output, only JSON result on stdout
// Level 1 (BASIC): Show orchestration start/completion events
// Level 2 (DETAIL): Show command resolution and intermediate steps
// Level 3 (DEBUG): Show all subprocess I/O and raw payloads

export type VerbosityLevel = 0 | 1 | 2 | 3;

export const SILENT = 0 as const;
export const BASIC = 1 as const;
export const DETAIL = 2 as const;
export const DEBUG = 3 as const;

export function clampVerbosity(level: number): VerbosityLevel {
  if (level >= 3) return 3;
  if (level <= 0) return 0;
  return level as VerbosityLevel;
}
