export class WriteLock {
  private lock: Promise<void> = Promise.resolve();

  async acquire<T>(fn: () => Promise<T>): Promise<T> {
    const currentLock = this.lock;
    let releaseLock: () => void;

    this.lock = new Promise((resolve) => {
      releaseLock = resolve;
    });

    await currentLock;

    try {
      return await fn();
    } finally {
      releaseLock!();
    }
  }
}
