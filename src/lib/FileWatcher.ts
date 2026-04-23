import chokidar from 'chokidar';
import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';
import ignore from 'ignore';

export interface WatcherEvent {
  path: string;
  action: 'created' | 'modified' | 'deleted';
}

export interface WorkspaceRoot {
  path: string;
  label: string;
  ignore?: string[];
}

export interface FileWatcherOptions {
  ignore?: string[];
}

interface EventRecord {
  path: string;
  action: 'created' | 'modified' | 'deleted';
  timestamp: number;
}

interface IdleWaiter {
  quiesceMs: number;
  resolve: (value: WatcherEvent[]) => void;
  reject: (error: Error) => void;
  timeoutId: NodeJS.Timeout;
}

export class FileWatcher {
  private watchers: Map<string, chokidar.FSWatcher> = new Map();
  private events: Map<string, Map<string, EventRecord>> = new Map();
  private roots: Map<string, string> = new Map();
  private waiters: Map<string, Array<{count: number, resolve: () => void}>> = new Map();
  private idleWaiters: Map<string, IdleWaiter> = new Map();
  private lastEventTime: Map<string, number> = new Map();

  async start(roots: WorkspaceRoot[], opts: FileWatcherOptions = {}): Promise<void> {
    for (const root of roots) {
      // Initialize lastEventTime to now so the first quiesce check is relative to start time
      this.lastEventTime.set(root.label, Date.now());
      await this.startWatchingRoot(root, opts);
    }
  }

  private async startWatchingRoot(root: WorkspaceRoot, opts: FileWatcherOptions): Promise<void> {
    const ignorePatterns = await this.buildIgnorePatterns(root, opts);
    const ig = ignore().add(ignorePatterns);
    this.roots.set(root.label, root.path);

    this.events.set(root.label, new Map());

    const watcher = chokidar.watch(root.path, {
      ignored: (filePath: string) => {
        const relPath = relative(root.path, filePath);
        // The root itself has an empty relative path; `ignore` throws on empty
        // input, so never treat the root as ignored.
        if (!relPath) return false;
        return ig.ignores(relPath);
      },
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 50,
        pollInterval: 50,
      },
    });

    watcher.on('add', (path) => {
      const relPath = relative(root.path, path);
      this.recordEvent(root.label, relPath, 'created');
    });

    watcher.on('change', (path) => {
      const relPath = relative(root.path, path);
      this.recordEvent(root.label, relPath, 'modified');
    });

    watcher.on('unlink', (path) => {
      const relPath = relative(root.path, path);
      this.recordEvent(root.label, relPath, 'deleted');
    });

    this.watchers.set(root.label, watcher);

    return new Promise<void>((resolve) => {
      watcher.on('ready', () => {
        resolve();
      });
    });
  }

  private async buildIgnorePatterns(root: WorkspaceRoot, opts: FileWatcherOptions): Promise<string[]> {
    const patterns: string[] = [
      '.DS_Store',
      'node_modules',
      'node_modules/**',
      '.cache',
      '.cache/**',
      'dist',
      'dist/**',
      '.git',
      '.git/**',
      'galloper-data',
      'galloper-data/**',
      '*.tsbuildinfo',
      '*.swp',
      '*.swo',
      '*~',
      '.#*',
    ];

    // Step 4: Do NOT add .gitignore patterns to the watcher. The watcher should detect
    // ALL filesystem changes including gitignored files, since they can affect task output.
    // Git's ignore rules are for version control; filesystem monitoring should catch everything.

    // Add workspace-level ignores
    if (opts.ignore) {
      patterns.push(...opts.ignore);
    }

    // Add per-root ignores
    if (root.ignore) {
      patterns.push(...root.ignore);
    }

    return patterns;
  }

  private recordEvent(rootLabel: string, path: string, action: 'created' | 'modified' | 'deleted'): void {
    const events = this.events.get(rootLabel);
    if (!events) return;

    const existing = events.get(path);
    const timestamp = Date.now();

    if (!existing) {
      events.set(path, { path, action, timestamp });
    } else {
      // Coalesce events to final state
      const prevAction = existing.action;

      if (action === 'deleted') {
        // Any state → deleted = delete
        existing.action = 'deleted';
        existing.timestamp = timestamp;
      } else if (action === 'modified') {
        // created → modified = created (keep original action)
        // modified → modified = modified (stay the same)
        // Don't change if already deleted
        if (prevAction === 'modified') {
          existing.action = 'modified';
        }
        existing.timestamp = timestamp;
      } else if (action === 'created') {
        // created → created = created (no change needed)
        if (prevAction !== 'deleted') {
          existing.action = 'created';
        }
        existing.timestamp = timestamp;
      }
    }

    // Update last event time. The idle waiter (if any) polls lastEventTime on
    // its own schedule via checkIdle and will detect either the next quiet
    // window or the hard timeout — do NOT clear its scheduled check here, or
    // the Promise is orphaned and hangs forever on sustained noise.
    this.lastEventTime.set(rootLabel, timestamp);

    // Invoke any waiters whose threshold is met
    const labelWaiters = this.waiters.get(rootLabel);
    if (labelWaiters && labelWaiters.length > 0) {
      const eventCount = events.size;
      const remaining = labelWaiters.filter((waiter) => {
        if (eventCount >= waiter.count) {
          waiter.resolve();
          return false;
        }
        return true;
      });
      if (remaining.length === 0) {
        this.waiters.delete(rootLabel);
      } else {
        this.waiters.set(rootLabel, remaining);
      }
    }
  }

  async waitForIdle(label: string, quiesceMs: number, timeoutMs: number): Promise<WatcherEvent[]> {
    const events = this.events.get(label);
    if (!events) {
      return Promise.reject(new Error(`No watcher for label: ${label}`));
    }

    // If an idle waiter is already active for this root, reject
    if (this.idleWaiters.has(label)) {
      return Promise.reject(new Error(`Idle waiter already active for label: ${label}`));
    }

    const startTime = Date.now();
    const lastEventTime = this.lastEventTime.get(label) ?? startTime;
    const timeSinceLastEvent = Date.now() - lastEventTime;

    // If already idle, return immediately
    if (timeSinceLastEvent >= quiesceMs) {
      return Array.from(events.values()).map((e) => ({ path: e.path, action: e.action }));
    }

    // Set up idle waiter with timeout
    return new Promise<WatcherEvent[]>((resolve, reject) => {
      const checkIdle = () => {
        const currentTime = Date.now();
        const elapsed = currentTime - startTime;

        // Check if timeout exceeded
        if (elapsed >= timeoutMs) {
          this.idleWaiters.delete(label);
          const sampleEvents = Array.from(events.values()).map((e) => ({ path: e.path, action: e.action }));
          reject(new Error(`Quiesce timeout exceeded: no quiet window of ${quiesceMs}ms within ${timeoutMs}ms`));
          return;
        }

        const currentLastEvent = this.lastEventTime.get(label) ?? lastEventTime;
        const timeSinceEvent = currentTime - currentLastEvent;

        if (timeSinceEvent >= quiesceMs) {
          // Quiesce achieved
          this.idleWaiters.delete(label);
          const finalEvents = Array.from(events.values()).map((e) => ({ path: e.path, action: e.action }));
          resolve(finalEvents);
        } else {
          // Schedule next check
          const nextCheckDelay = Math.min(quiesceMs - timeSinceEvent + 10, 100);
          const nextTimeoutId = setTimeout(checkIdle, nextCheckDelay);
          const waiter = this.idleWaiters.get(label);
          if (waiter) {
            waiter.timeoutId = nextTimeoutId;
          }
        }
      };

      const timeoutId = setTimeout(checkIdle, 50);
      this.idleWaiters.set(label, { quiesceMs, resolve, reject, timeoutId });
    });
  }

  async stop(): Promise<Record<string, WatcherEvent[]>> {
    const results: Record<string, WatcherEvent[]> = {};

    // Clear all idle waiters
    for (const waiter of this.idleWaiters.values()) {
      clearTimeout(waiter.timeoutId);
    }
    this.idleWaiters.clear();

    for (const [label, watcher] of this.watchers) {
      await new Promise<void>((resolve) => {
        watcher.close().then(() => resolve());
      });

      const eventMap = this.events.get(label);
      const events: WatcherEvent[] = [];

      if (eventMap) {
        for (const event of eventMap.values()) {
          events.push({ path: event.path, action: event.action });
        }
      }

      results[label] = events;
    }

    // Clear state
    this.watchers.clear();
    this.events.clear();
    this.roots.clear();
    this.waiters.clear();
    this.lastEventTime.clear();

    return results;
  }

  waitForEvents(label: string, count: number): Promise<void> {
    const events = this.events.get(label);
    if (!events) {
      return Promise.reject(new Error(`No watcher for label: ${label}`));
    }

    if (events.size >= count) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      if (!this.waiters.has(label)) {
        this.waiters.set(label, []);
      }
      const labelWaiters = this.waiters.get(label)!;
      labelWaiters.push({count, resolve});
    });
  }

  hasEvent(label: string, path: string, action: 'created' | 'modified' | 'deleted'): boolean {
    const events = this.events.get(label);
    if (!events) {
      return false;
    }

    const event = events.get(path);
    return event !== undefined && event.action === action;
  }
}
