import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface ClassifiedPath {
  path: string;
  action: 'create' | 'edit' | 'delete';
}

export interface TaskManifest {
  declared: ClassifiedPath[];
  surprise: ClassifiedPath[];
  churn: ClassifiedPath[];
  /**
   * Per-root classification (Step 3C). Maps root label to its classified paths.
   * Optional for back-compat with single-root scenarios.
   */
  perRoot?: Record<string, { declared: ClassifiedPath[]; surprise: ClassifiedPath[]; churn: ClassifiedPath[] }>;
}

export interface SessionRecord {
  id: string;
  prompt: string;
  command: string;
  cwd: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  parsedStdoutEvents: unknown[];
  parsedStderrEvents: unknown[];
  finalOutput: string | null;
  taskManifests: Record<string, TaskManifest>;
}

export class SessionManager {
  private sessionsDir: string;

  constructor({ sessionsDir }: { sessionsDir: string }) {
    this.sessionsDir = sessionsDir;
  }

  async ensureDir(): Promise<void> {
    await fs.mkdir(this.sessionsDir, { recursive: true });
  }

  createSessionId(): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return timestamp;
  }

  getSessionPath(sessionId: string): string {
    return path.join(this.sessionsDir, `${sessionId}.json`);
  }

  async writeSession(sessionId: string, record: SessionRecord): Promise<string> {
    const sessionFilePath = this.getSessionPath(sessionId);
    const content = `${JSON.stringify(record, null, 2)}\n`;
    await fs.writeFile(sessionFilePath, content, 'utf8');
    return sessionFilePath;
  }
}
