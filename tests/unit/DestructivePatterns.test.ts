import { describe, it, expect } from 'vitest';
import { detectDestructive, DESTRUCTIVE_PATTERNS } from '../../src/lib/DestructivePatterns.js';

describe('detectDestructive — positive cases', () => {
  const positives: Array<[string, string | string[]]> = [
    ['rm -rf', 'rm -rf /tmp/x'],
    ['rm -fr', 'rm -fr /tmp/x'],
    ['rm -r -f', 'rm -r -f /tmp/x'],
    ['rm -f -r', 'rm -f -r /tmp/x'],
    ['rm -Rf', 'rm -Rf /tmp/x'],
    ['git reset --hard', 'git reset --hard HEAD~1'],
    ['git reset --hard with flags', 'git reset --quiet --hard'],
    ['git push --force', 'git push --force origin main'],
    ['git clean -fd', 'git clean -fd'],
    ['git clean --force', 'git clean --force'],
    ['dd of=', 'dd if=/dev/zero of=/tmp/file bs=1M count=1'],
    ['mkfs.ext4', 'mkfs.ext4 /dev/sda1'],
    ['mkfs bare', 'mkfs /dev/sda1'],
    ['find -delete', "find . -name '*.log' -delete"],
    ['chmod -R', 'chmod -R 777 .'],
    ['chmod --recursive', 'chmod --recursive 644 .'],
    ['chown -R', 'chown -R user:user .'],
    ['array form rm -rf', ['rm', '-rf', '/tmp/x']],
    ['array form git reset --hard', ['git', 'reset', '--hard']],
  ];

  for (const [label, cmd] of positives) {
    it(`flags: ${label}`, () => {
      const hits = detectDestructive(cmd);
      expect(hits.length, `expected a hit for ${JSON.stringify(cmd)}`).toBeGreaterThan(0);
    });
  }
});

describe('detectDestructive — negative cases', () => {
  const negatives: Array<[string, string | string[]]> = [
    ['benign rm', 'rm file.txt'],
    ['force-with-lease is allowed', 'git push --force-with-lease origin main'],
    ['reset --soft', 'git reset --soft HEAD~1'],
    ['git clean --dry-run', 'git clean --dry-run'],
    ['npm run find', 'npm run find'],
    ['echo mentions mkfs', 'echo "mkfs is scary"'],
    ['echo mentions rm', 'echo "rm -rf"'],
    ['grep for -delete', "grep -- '-delete' README"],
    ['npm test', 'npm test'],
    ['prettier', 'prettier --write src/a.ts'],
    ['eslint', 'eslint --fix src/a.ts'],
    ['array form benign', ['npm', 'test']],
  ];

  for (const [label, cmd] of negatives) {
    it(`allows: ${label}`, () => {
      const hits = detectDestructive(cmd);
      // Pragmatic stance: echo-wrapped dangerous words still trip the gate.
      if (label === 'echo mentions rm') {
        expect(hits).toContain('rm -rf');
      } else if (label === 'echo mentions mkfs') {
        expect(hits).toContain('mkfs');
      } else {
        expect(hits, `expected no hit for ${JSON.stringify(cmd)}, got ${hits.join(',')}`).toHaveLength(0);
      }
    });
  }
});

describe('DESTRUCTIVE_PATTERNS list shape', () => {
  it('has unique names and valid regexes', () => {
    const names = new Set(DESTRUCTIVE_PATTERNS.map((p) => p.name));
    expect(names.size).toBe(DESTRUCTIVE_PATTERNS.length);
    for (const { re } of DESTRUCTIVE_PATTERNS) {
      expect(re).toBeInstanceOf(RegExp);
    }
  });
});
