import { readFileSync, existsSync } from 'node:fs';

export interface LogEvent {
  type: string;
  timestamp?: string;
  sessionId?: string;
  [key: string]: unknown;
}

export function readJsonlEvents(filePath: string): LogEvent[] {
  if (!existsSync(filePath)) {
    return [];
  }
  const content = readFileSync(filePath, 'utf-8');
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as LogEvent;
      } catch {
        return null;
      }
    })
    .filter((event): event is LogEvent => event !== null);
}
