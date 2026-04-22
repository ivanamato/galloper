export interface ProgressInfo {
  current: number;
  total: number;
}

export interface HumanReporter {
  info(message: string): void;
  step(context: string, message: string): void;
  planSummary(plan: unknown): void;
  taskStarted(title: string, progress?: ProgressInfo): void;
  taskCompleted(title: string, progress?: ProgressInfo): void;
  done(summary: string): void;
}

export class ConsoleHumanReporter implements HumanReporter {
  private stream: NodeJS.WritableStream;
  private enabled: boolean;

  constructor({ enabled = true, stream = process.stderr }: { enabled?: boolean; stream?: NodeJS.WritableStream } = {}) {
    this.enabled = enabled;
    this.stream = stream;
  }

  info(message: string): void {
    if (!this.enabled) return;
    this.stream.write(`› ${message}\n`);
  }

  step(context: string, message: string): void {
    if (!this.enabled) return;
    this.stream.write(`  [${context}] ${message}\n`);
  }

  planSummary(plan: unknown): void {
    if (!this.enabled) return;
    if (typeof plan !== 'object' || plan === null) {
      this.info('Plan parsed');
      return;
    }

    const planObj = plan as Record<string, unknown>;
    const tasks = Array.isArray(planObj.tasks) ? planObj.tasks : [];
    this.info(`Plan contains ${tasks.length} task(s):`);

    tasks.forEach((task, idx) => {
      const title = typeof task === 'object' && task !== null && 'title' in task ? (task as Record<string, unknown>).title : `Task ${idx + 1}`;
      this.stream.write(`  ${idx + 1}. ${title}\n`);
    });
  }

  taskStarted(title: string, progress?: ProgressInfo): void {
    if (!this.enabled) return;
    const prefix = progress ? `▶ Task [${progress.current}/${progress.total}]` : `▶ Task`;
    this.stream.write(`${prefix}: ${title}\n`);
  }

  taskCompleted(title: string, progress?: ProgressInfo): void {
    if (!this.enabled) return;
    const prefix = progress ? `✓ Task [${progress.current}/${progress.total}]` : `✓ Task`;
    this.stream.write(`${prefix}: ${title}\n`);
  }

  done(summary: string): void {
    if (!this.enabled) return;
    this.stream.write(`✓ ${summary}\n`);
  }
}

export class NullHumanReporter implements HumanReporter {
  info(): void {}
  step(): void {}
  planSummary(): void {}
  taskStarted(): void {}
  taskCompleted(): void {}
  done(): void {}
}
