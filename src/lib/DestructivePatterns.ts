/**
 * Conservative list of shell patterns that warrant an explicit
 * `destructive: true` acknowledgement on a hook command. The list is
 * intentionally small — additions should be measured against false-positive
 * rates on realistic configs. Expand only when a known-bad pattern is
 * observed slipping through.
 */
export const DESTRUCTIVE_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'rm -rf', re: /\brm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*[rR][a-zA-Z]*|-[rR]\s+-f|-f\s+-[rR])\b/ },
  { name: 'git reset --hard', re: /\bgit\s+reset\s+(?:--\S+\s+)*--hard\b/ },
  { name: 'git push --force', re: /\bgit\s+push\b(?=[^\n]*--force\b)(?![^\n]*--force-with-lease\b)/ },
  { name: 'git clean -f', re: /\bgit\s+clean\s+(?:-[a-zA-Z]*f[a-zA-Z]*|--force)\b/ },
  { name: 'dd of=', re: /\bdd\b[^\n]*\bof=\S+/ },
  { name: 'mkfs', re: /\bmkfs(?:\.[a-zA-Z0-9]+)?\b/ },
  { name: 'find -delete', re: /\bfind\b[^\n]*\s-delete\b/ },
  { name: 'chmod -R', re: /\bchmod\s+(?:-[a-zA-Z]*R[a-zA-Z]*|--recursive)\b/ },
  { name: 'chown -R', re: /\bchown\s+(?:-[a-zA-Z]*R[a-zA-Z]*|--recursive)\b/ },
];

export function detectDestructive(command: string | string[]): string[] {
  const joined = Array.isArray(command) ? command.join(' ') : command;
  const hits: string[] = [];
  for (const { name, re } of DESTRUCTIVE_PATTERNS) {
    if (re.test(joined)) hits.push(name);
  }
  return hits;
}
