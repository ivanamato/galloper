import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { FileWatcher } from '../../src/lib/FileWatcher.js';
import { createTempRepo, TempRepo } from '../helpers/tempRepo.js';

describe('FileWatcher', () => {
  let repo: TempRepo;
  let watcher: FileWatcher;

  beforeEach(async () => {
    repo = await createTempRepo();
    watcher = new FileWatcher();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('should track created files', async () => {
    await watcher.start([{ path: repo.dir, label: 'root' }]);

    await fs.writeFile(join(repo.dir, 'test.txt'), 'content');
    await watcher.waitForEvents('root', 1);

    const results = await watcher.stop();
    expect(results.root).toContainEqual(expect.objectContaining({
      path: 'test.txt',
      action: 'created',
    }));
  });

  it('should track modified files', async () => {
    const filePath = join(repo.dir, 'test.txt');
    await fs.writeFile(filePath, 'initial');

    await watcher.start([{ path: repo.dir, label: 'root' }]);

    await fs.writeFile(filePath, 'modified');
    await watcher.waitForEvents('root', 1);

    const results = await watcher.stop();
    expect(results.root).toContainEqual(expect.objectContaining({
      path: 'test.txt',
      action: 'modified',
    }));
  });

  it('should track deleted files', async () => {
    const filePath = join(repo.dir, 'test.txt');
    await fs.writeFile(filePath, 'content');

    await watcher.start([{ path: repo.dir, label: 'root' }]);

    await fs.unlink(filePath);
    await watcher.waitForEvents('root', 1);

    const results = await watcher.stop();
    expect(results.root).toContainEqual(expect.objectContaining({
      path: 'test.txt',
      action: 'deleted',
    }));
  });

  it('should coalesce create→modify to created', async () => {
    await watcher.start([{ path: repo.dir, label: 'root' }]);

    const filePath = join(repo.dir, 'test.txt');
    await fs.writeFile(filePath, 'initial');
    await new Promise(resolve => setTimeout(resolve, 300));
    await fs.writeFile(filePath, 'modified');
    await watcher.waitForEvents('root', 1);

    const results = await watcher.stop();
    expect(results.root).toHaveLength(1);
    expect(results.root[0]).toEqual(expect.objectContaining({
      path: 'test.txt',
      action: 'created',
    }));
  });

  it('should coalesce create→delete to deleted', async () => {
    await watcher.start([{ path: repo.dir, label: 'root' }]);

    const filePath = join(repo.dir, 'test.txt');
    await fs.writeFile(filePath, 'content');
    await new Promise(resolve => setTimeout(resolve, 300));
    await fs.unlink(filePath);
    await new Promise(resolve => setTimeout(resolve, 200));
    await watcher.waitForEvents('root', 1);

    const results = await watcher.stop();
    expect(results.root).toHaveLength(1);
    expect(results.root[0]).toEqual(expect.objectContaining({
      path: 'test.txt',
      action: 'deleted',
    }));
  });

  it('should coalesce modify→delete to deleted', async () => {
    const filePath = join(repo.dir, 'test.txt');
    await fs.writeFile(filePath, 'initial');

    await watcher.start([{ path: repo.dir, label: 'root' }]);

    await fs.writeFile(filePath, 'modified');
    await new Promise(resolve => setTimeout(resolve, 300));
    await fs.unlink(filePath);
    await new Promise(resolve => setTimeout(resolve, 200));
    await watcher.waitForEvents('root', 1);

    const results = await watcher.stop();
    expect(results.root).toHaveLength(1);
    expect(results.root[0]).toEqual(expect.objectContaining({
      path: 'test.txt',
      action: 'deleted',
    }));
  });

  it('should ignore built-in noise patterns', async () => {
    await watcher.start([{ path: repo.dir, label: 'root' }]);

    // Create various noise files
    await fs.writeFile(join(repo.dir, '.DS_Store'), 'mac noise');
    await fs.writeFile(join(repo.dir, 'test.swp'), 'vim swap');
    await fs.writeFile(join(repo.dir, 'test~'), 'backup');
    // Write a sentinel file to ensure file system processing is done
    await fs.writeFile(join(repo.dir, '.sentinel'), '');
    await watcher.waitForEvents('root', 1);

    const results = await watcher.stop();
    expect(results.root).toHaveLength(1);
    expect(results.root[0]).toEqual(expect.objectContaining({
      path: '.sentinel',
      action: 'created',
    }));
  });

  it('should ignore node_modules', async () => {
    const nodeModulesDir = join(repo.dir, 'node_modules');
    await fs.mkdir(nodeModulesDir, { recursive: true });

    await watcher.start([{ path: repo.dir, label: 'root' }]);

    await fs.writeFile(join(nodeModulesDir, 'package.json'), '{}');
    // Write a sentinel file to ensure file system processing is done
    await fs.writeFile(join(repo.dir, '.sentinel'), '');
    await watcher.waitForEvents('root', 1);

    const results = await watcher.stop();
    expect(results.root).toHaveLength(1);
    expect(results.root[0]).toEqual(expect.objectContaining({
      path: '.sentinel',
      action: 'created',
    }));
  });

  it('should ignore dist directory', async () => {
    const distDir = join(repo.dir, 'dist');
    await fs.mkdir(distDir, { recursive: true });

    await watcher.start([{ path: repo.dir, label: 'root' }]);

    await fs.writeFile(join(distDir, 'index.js'), 'code');
    // Write a sentinel file to ensure file system processing is done
    await fs.writeFile(join(repo.dir, '.sentinel'), '');
    await watcher.waitForEvents('root', 1);

    const results = await watcher.stop();
    expect(results.root).toHaveLength(1);
    expect(results.root[0]).toEqual(expect.objectContaining({
      path: '.sentinel',
      action: 'created',
    }));
  });

  it('should ignore cache directories', async () => {
    const cacheDir = join(repo.dir, '.cache');
    await fs.mkdir(cacheDir, { recursive: true });

    await watcher.start([{ path: repo.dir, label: 'root' }]);

    await fs.writeFile(join(cacheDir, 'data.json'), '{}');
    // Write a sentinel file to ensure file system processing is done
    await fs.writeFile(join(repo.dir, '.sentinel'), '');
    await watcher.waitForEvents('root', 1);

    const results = await watcher.stop();
    expect(results.root).toHaveLength(1);
    expect(results.root[0]).toEqual(expect.objectContaining({
      path: '.sentinel',
      action: 'created',
    }));
  });

  it('should respect per-root ignore patterns', async () => {
    await watcher.start(
      [{ path: repo.dir, label: 'root', ignore: ['*.log', 'temp/**'] }],
    );

    const tempDir = join(repo.dir, 'temp');
    await fs.mkdir(tempDir, { recursive: true });

    await fs.writeFile(join(repo.dir, 'test.log'), 'logs');
    await fs.writeFile(join(tempDir, 'file.txt'), 'temp');
    await fs.writeFile(join(repo.dir, 'normal.txt'), 'content');
    await watcher.waitForEvents('root', 1);

    const results = await watcher.stop();
    expect(results.root).toHaveLength(1);
    expect(results.root[0]).toEqual(expect.objectContaining({
      path: 'normal.txt',
      action: 'created',
    }));
  });

  it('should respect workspace-level ignore patterns', async () => {
    await watcher.start(
      [{ path: repo.dir, label: 'root' }],
      { ignore: ['*.tmp', 'build/**'] },
    );

    const buildDir = join(repo.dir, 'build');
    await fs.mkdir(buildDir, { recursive: true });

    await fs.writeFile(join(repo.dir, 'test.tmp'), 'temp');
    await fs.writeFile(join(buildDir, 'output.js'), 'built');
    await fs.writeFile(join(repo.dir, 'normal.txt'), 'content');
    await watcher.waitForEvents('root', 1);

    const results = await watcher.stop();
    expect(results.root).toHaveLength(1);
    expect(results.root[0]).toEqual(expect.objectContaining({
      path: 'normal.txt',
      action: 'created',
    }));
  });

  it('should handle multiple roots', async () => {
    const repo2 = await createTempRepo();

    try {
      await watcher.start(
        [
          { path: repo.dir, label: 'root1' },
          { path: repo2.dir, label: 'root2' },
        ],
      );

      await fs.writeFile(join(repo.dir, 'file1.txt'), 'content1');
      await fs.writeFile(join(repo2.dir, 'file2.txt'), 'content2');
      await watcher.waitForEvents('root1', 1);
      await watcher.waitForEvents('root2', 1);

      const results = await watcher.stop();

      expect(results.root1).toHaveLength(1);
      expect(results.root1[0]).toEqual(expect.objectContaining({
        path: 'file1.txt',
        action: 'created',
      }));

      expect(results.root2).toHaveLength(1);
      expect(results.root2[0]).toEqual(expect.objectContaining({
        path: 'file2.txt',
        action: 'created',
      }));
    } finally {
      await repo2.cleanup();
    }
  });

  it('should handle nested directory changes', async () => {
    await watcher.start([{ path: repo.dir, label: 'root' }]);

    const subDir = join(repo.dir, 'src', 'lib');
    await fs.mkdir(subDir, { recursive: true });
    await fs.writeFile(join(subDir, 'module.ts'), 'code');
    await watcher.waitForEvents('root', 1);

    const results = await watcher.stop();
    expect(results.root).toContainEqual(expect.objectContaining({
      path: expect.stringContaining('module.ts'),
      action: 'created',
    }));
  });

  it('should return empty array for roots with no changes', async () => {
    await watcher.start([{ path: repo.dir, label: 'root' }]);

    const results = await watcher.stop();
    expect(results.root).toHaveLength(0);
  });

  it('should handle multiple operations on same file', async () => {
    await watcher.start([{ path: repo.dir, label: 'root' }]);

    const filePath = join(repo.dir, 'test.txt');
    await fs.writeFile(filePath, 'v1');
    await new Promise(resolve => setTimeout(resolve, 200));
    await fs.writeFile(filePath, 'v2');
    await new Promise(resolve => setTimeout(resolve, 200));
    await fs.writeFile(filePath, 'v3');
    await watcher.waitForEvents('root', 1);

    const results = await watcher.stop();
    expect(results.root).toHaveLength(1);
    expect(results.root[0]).toEqual(expect.objectContaining({
      path: 'test.txt',
      action: 'created',
    }));
  });

  it('should coalesce create→modify→delete to single deleted event', async () => {
    await watcher.start([{ path: repo.dir, label: 'root' }]);

    const filePath = join(repo.dir, 'test.txt');
    await fs.writeFile(filePath, 'v1');
    await new Promise(resolve => setTimeout(resolve, 200));
    await fs.writeFile(filePath, 'v2');
    await new Promise(resolve => setTimeout(resolve, 200));
    await fs.unlink(filePath);
    await new Promise(resolve => setTimeout(resolve, 200));
    await watcher.waitForEvents('root', 1);

    const results = await watcher.stop();
    expect(results.root).toHaveLength(1);
    expect(results.root[0]).toEqual(expect.objectContaining({
      path: 'test.txt',
      action: 'deleted',
    }));
  });

  it('should ignore tsbuildinfo files', async () => {
    await watcher.start([{ path: repo.dir, label: 'root' }]);

    await fs.writeFile(join(repo.dir, 'index.tsbuildinfo'), '{}');
    // Write a sentinel file to ensure file system processing is done
    await fs.writeFile(join(repo.dir, '.sentinel'), '');
    await watcher.waitForEvents('root', 1);

    const results = await watcher.stop();
    expect(results.root).toHaveLength(1);
    expect(results.root[0]).toEqual(expect.objectContaining({
      path: '.sentinel',
      action: 'created',
    }));
  });

  it('should handle file extension patterns in ignore', async () => {
    await watcher.start(
      [{ path: repo.dir, label: 'root', ignore: ['*.md'] }],
    );

    await fs.writeFile(join(repo.dir, 'README.md'), '# Hello');
    await fs.writeFile(join(repo.dir, 'code.ts'), 'console.log();');
    await watcher.waitForEvents('root', 1);

    const results = await watcher.stop();
    expect(results.root).toHaveLength(1);
    expect(results.root[0]).toEqual(expect.objectContaining({
      path: 'code.ts',
      action: 'created',
    }));
  });
});
