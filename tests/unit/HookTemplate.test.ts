import { describe, it, expect } from 'vitest';
import { substitute, isPathSafeForShell, PATH_SAFE_REGEX, type TemplateContext } from '../../src/lib/HookTemplate.js';

describe('HookTemplate.substitute', () => {
  const fullCtx: TemplateContext = {
    file: 'src/a.ts',
    action: 'edit',
    classification: 'declared',
    sessionId: 'sess-1',
    taskId: 't1',
    attempt: 2,
    root: '/repo',
  };

  it('substitutes each placeholder from a full context', () => {
    expect(substitute('{file}', fullCtx)).toBe('src/a.ts');
    expect(substitute('{path}', fullCtx)).toBe('src/a.ts');
    expect(substitute('{action}', fullCtx)).toBe('edit');
    expect(substitute('{classification}', fullCtx)).toBe('declared');
    expect(substitute('{sessionId}', fullCtx)).toBe('sess-1');
    expect(substitute('{taskId}', fullCtx)).toBe('t1');
    expect(substitute('{attempt}', fullCtx)).toBe('2');
    expect(substitute('{root}', fullCtx)).toBe('/repo');
  });

  it('{path} is an alias of {file}', () => {
    expect(substitute('{path}', { ...fullCtx, file: 'x/y.ts' })).toBe('x/y.ts');
  });

  it('replaces unset optional fields with empty string', () => {
    const minimal: TemplateContext = { sessionId: 'sess', root: '/repo' };
    expect(substitute('{file}', minimal)).toBe('');
    expect(substitute('{path}', minimal)).toBe('');
    expect(substitute('{action}', minimal)).toBe('');
    expect(substitute('{classification}', minimal)).toBe('');
    expect(substitute('{taskId}', minimal)).toBe('');
    expect(substitute('{attempt}', minimal)).toBe('');
  });

  it('normalizes backslashes in {file} and {root} to posix slashes', () => {
    const ctx: TemplateContext = {
      ...fullCtx,
      file: 'a\\b\\c.ts',
      root: 'C:\\Users\\repo',
    };
    expect(substitute('{file}', ctx)).toBe('a/b/c.ts');
    expect(substitute('{root}', ctx)).toBe('C:/Users/repo');
  });

  it('replaces multiple placeholders in one string', () => {
    const out = substitute('lint {file} --task {taskId} --attempt {attempt}', fullCtx);
    expect(out).toBe('lint src/a.ts --task t1 --attempt 2');
  });

  it('leaves unknown tokens untouched', () => {
    expect(substitute('{unknown}', fullCtx)).toBe('{unknown}');
  });

  it('preserves surrounding text', () => {
    expect(substitute('before {file} after', fullCtx)).toBe('before src/a.ts after');
  });
});

describe('HookTemplate.isPathSafeForShell', () => {
  it('accepts typical safe paths', () => {
    const safe = ['src/foo.ts', './a/b.ts', 'a-b_c.d', '~/x', 'a@b+c=d,e:f', 'path-with-hyphens', 'A.B.C'];
    for (const p of safe) {
      expect(isPathSafeForShell(p)).toBe(true);
    }
  });

  it('rejects the empty string', () => {
    expect(isPathSafeForShell('')).toBe(false);
  });

  it('rejects shell metacharacters', () => {
    const unsafe = [
      'a b.ts',    // space
      'a;b',       // semicolon
      'a|b',       // pipe
      'a&b',       // ampersand
      'a$b',       // dollar
      'a`b`',      // backtick
      'a(b)',      // parens
      'a<b',       // lt
      'a>b',       // gt
      'a"b',       // dquote
      "a'b",       // squote
      'a\nb',      // newline
      'a\tb',      // tab
      'a\\b',      // backslash
      'a*b',       // glob star
      'a?b',       // glob ?
      'a[b]',      // glob [
      'a{b}',      // glob {
      'a!b',       // bang
      'a#b',       // hash
      'a%b',       // percent
      'a^b',       // caret
    ];
    for (const p of unsafe) {
      expect(isPathSafeForShell(p), `expected ${JSON.stringify(p)} to be rejected`).toBe(false);
    }
  });

  it('PATH_SAFE_REGEX is the underlying regex', () => {
    expect(PATH_SAFE_REGEX.test('src/a.ts')).toBe(true);
    expect(PATH_SAFE_REGEX.test('a;b')).toBe(false);
  });
});
