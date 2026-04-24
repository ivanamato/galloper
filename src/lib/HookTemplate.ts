export interface TemplateContext {
  file?: string;
  action?: 'create' | 'edit' | 'delete';
  classification?: 'declared' | 'surprise' | 'churn';
  sessionId: string;
  taskId?: string;
  attempt?: number;
  root: string;
  /** Adaptive-loop iteration index (0-based), available to adaptive lifecycle hooks. */
  iteration?: number;
}

const PLACEHOLDER_RE = /\{(file|path|action|classification|sessionId|taskId|attempt|root|iteration)\}/g;

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

export function substitute(input: string, ctx: TemplateContext): string {
  return input.replace(PLACEHOLDER_RE, (_, key: string): string => {
    switch (key) {
      case 'file':
      case 'path':
        return ctx.file ? toPosix(ctx.file) : '';
      case 'action':
        return ctx.action ?? '';
      case 'classification':
        return ctx.classification ?? '';
      case 'sessionId':
        return ctx.sessionId;
      case 'taskId':
        return ctx.taskId ?? '';
      case 'attempt':
        return ctx.attempt !== undefined ? String(ctx.attempt) : '';
      case 'root':
        return toPosix(ctx.root);
      case 'iteration':
        return ctx.iteration !== undefined ? String(ctx.iteration) : '';
      default:
        return '';
    }
  });
}

/**
 * Whitelist of characters safe to interpolate into a `/bin/sh -c` command
 * without shell-injection risk. Rejects empty strings and any character
 * outside `[A-Za-z0-9._/\-@+=,~:]`.
 *
 * Argv-mode (`shell: false`) hooks bypass this check because argv strings
 * are not word-split or shell-expanded.
 */
export const PATH_SAFE_REGEX = /^[A-Za-z0-9._/\-@+=,~:]+$/;

export function isPathSafeForShell(p: string): boolean {
  if (!p) return false;
  return PATH_SAFE_REGEX.test(p);
}
