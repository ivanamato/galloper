export class WorkerPool<T> {
  private concurrency: number;
  private running = 0;
  private queue: Array<{
    fn: () => Promise<T>;
    resolve: (value: T) => void;
    reject: (reason?: unknown) => void;
  }> = [];

  constructor(concurrency: number) {
    if (concurrency < 1) {
      throw new Error('Concurrency must be at least 1');
    }
    this.concurrency = concurrency;
  }

  async enqueue(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.processQueue();
    });
  }

  private processQueue(): void {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const task = this.queue.shift();
      if (task) {
        this.running += 1;
        this.executeTask(task);
      }
    }
  }

  private async executeTask(task: {
    fn: () => Promise<T>;
    resolve: (value: T) => void;
    reject: (reason?: unknown) => void;
  }): Promise<void> {
    try {
      const result = await task.fn();
      task.resolve(result);
    } catch (err) {
      task.reject(err);
    } finally {
      this.running -= 1;
      this.processQueue();
    }
  }
}
