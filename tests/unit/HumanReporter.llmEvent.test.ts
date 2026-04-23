import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { ConsoleHumanReporter } from '../../src/lib/HumanReporter.js';

function collect(): { stream: PassThrough; read: () => string } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  return { stream, read: () => Buffer.concat(chunks).toString('utf8') };
}

function makeReporter(): { reporter: ConsoleHumanReporter; read: () => string } {
  const { stream, read } = collect();
  const reporter = new ConsoleHumanReporter({
    stream,
    now: () => new Date('2026-04-23T00:00:00.000Z'),
  });
  return { reporter, read };
}

describe('ConsoleHumanReporter.llmEvent', () => {
  it('ignores non-object, non-JSON, and unknown-type events silently', () => {
    const { reporter, read } = makeReporter();
    reporter.llmEvent(null);
    reporter.llmEvent('some string');
    reporter.llmEvent(42);
    reporter.llmEvent({ type: 'user', message: { content: [] } });
    reporter.llmEvent({ type: 'nonsense' });
    expect(read()).toBe('');
  });

  it('narrates system init with model', () => {
    const { reporter, read } = makeReporter();
    reporter.llmEvent({ type: 'system', subtype: 'init', model: 'claude-haiku-4-5' });
    expect(read()).toBe('2026-04-23T00:00:00.000Z   ⟳ llm session init model=claude-haiku-4-5\n');
  });

  it('narrates assistant text blocks as » snippets (collapsed whitespace, truncated)', () => {
    const { reporter, read } = makeReporter();
    reporter.llmEvent({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: '  hello\n  world  ' },
          { type: 'text', text: 'a'.repeat(200) },
        ],
      },
    });
    const out = read();
    expect(out).toContain('» hello world');
    expect(out).toMatch(/» a{120}\n/);
  });

  it('narrates tool_use blocks with tool-specific summaries', () => {
    const { reporter, read } = makeReporter();
    reporter.llmEvent({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Read', input: { file_path: 'src/foo.ts' } },
          { type: 'tool_use', name: 'Edit', input: { file_path: 'src/bar.ts' } },
          { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
          { type: 'tool_use', name: 'Grep', input: { pattern: 'TODO', path: 'src' } },
          { type: 'tool_use', name: 'UnknownTool', input: {} },
        ],
      },
    });
    const out = read();
    expect(out).toContain('→ Read src/foo.ts');
    expect(out).toContain('→ Edit src/bar.ts');
    expect(out).toContain('→ Bash: npm test');
    expect(out).toContain('→ Grep "TODO" in src');
    expect(out).toContain('→ UnknownTool');
  });

  it('narrates result with turns and cost when present', () => {
    const { reporter, read } = makeReporter();
    reporter.llmEvent({ type: 'result', subtype: 'success', num_turns: 5, total_cost_usd: 0.01234 });
    expect(read()).toBe('2026-04-23T00:00:00.000Z   ⟲ llm result turns=5 cost=$0.0123\n');
  });

  it('idleTick emits elapsed seconds', () => {
    const { reporter, read } = makeReporter();
    reporter.idleTick(30500);
    expect(read()).toBe('2026-04-23T00:00:00.000Z   … still running (elapsed 31s)\n');
  });

  describe('hookFired token disambiguation', () => {
    it('appends the command executable as a token so same-phase hooks are distinguishable', () => {
      const { reporter, read } = makeReporter();
      reporter.hookFired({ phase: 'post-task', kind: 'lifecycle', command: 'echo "..." >> hooks.log' });
      reporter.hookFired({ phase: 'post-task', kind: 'lifecycle', command: 'npm run build 2>&1 | tail -30' });
      const out = read();
      expect(out).toContain('⚑ hook [post-task] fired: echo\n');
      expect(out).toContain('⚑ hook [post-task] fired: npm\n');
    });

    it('skips leading NAME=value env assignments when choosing the token', () => {
      const { reporter, read } = makeReporter();
      reporter.hookFired({ phase: 'pre-task', kind: 'lifecycle', command: 'API_KEY=secret FOO=bar npm test' });
      expect(read()).toContain('⚑ hook [pre-task] fired: npm\n');
    });

    it('omits suffix when no command is associated (instructions-only)', () => {
      const { reporter, read } = makeReporter();
      reporter.hookFired({ phase: 'pre-task', kind: 'lifecycle', instructionsOnly: true });
      expect(read()).toContain('⚑ hook [pre-task] instructions injected\n');
      expect(read()).not.toContain('fired:');
    });

    it('includes token in skipped lines too', () => {
      const { reporter, read } = makeReporter();
      reporter.hookFired({
        phase: 'post-task-file',
        kind: 'lifecycle',
        command: 'rm -rf {file}',
        skipped: { reason: 'path-injection-risk' },
      });
      expect(read()).toContain('⚑ hook [post-task-file] skipped (path-injection-risk): rm\n');
    });
  });

  it('respects enabled=false', () => {
    const { stream, read } = collect();
    const reporter = new ConsoleHumanReporter({
      stream,
      enabled: false,
      now: () => new Date('2026-04-23T00:00:00.000Z'),
    });
    reporter.llmEvent({ type: 'system', subtype: 'init' });
    reporter.idleTick(10000);
    expect(read()).toBe('');
  });
});
