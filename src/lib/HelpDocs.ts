/**
 * Supported help topics and their markdown filenames.
 */
export const HELP_TOPICS = {
  plan: 'COMMAND_PLAN.md',
  implement: 'COMMAND_IMPLEMENT.md',
  pipeline: 'COMMAND_PIPELINE.md',
  adaptive: 'COMMAND_ADAPTIVE.md',
  help: 'COMMAND_HELP.md',
} as const;

export type HelpTopic = keyof typeof HELP_TOPICS;

/**
 * Error thrown when a requested topic is not supported.
 */
export class UnsupportedTopicError extends Error {
  constructor(topic: string) {
    const supported = Object.keys(HELP_TOPICS).join(', ');
    super(`Unsupported help topic: "${topic}". Supported topics: ${supported}`);
    this.name = 'UnsupportedTopicError';
  }
}

/**
 * Error thrown when the mapped markdown file is missing.
 */
export class HelpDocNotFoundError extends Error {
  constructor(topic: HelpTopic, filePath: string) {
    super(`Help doc for topic "${topic}" not found at: ${filePath}`);
    this.name = 'HelpDocNotFoundError';
  }
}

const DOCS_DIR = '/Users/ivanamato/docker_containers/galloper/docs';

/**
 * Resolves a help topic to its absolute file path.
 * @throws {UnsupportedTopicError} if the topic is not supported
 */
export function resolveHelpPath(topic: string): string {
  if (!(topic in HELP_TOPICS)) {
    throw new UnsupportedTopicError(topic);
  }
  const filename = HELP_TOPICS[topic as HelpTopic];
  return `${DOCS_DIR}/${filename}`;
}

/**
 * Reads and returns the markdown contents for a help topic.
 * @throws {UnsupportedTopicError} if the topic is not supported
 * @throws {HelpDocNotFoundError} if the mapped file does not exist
 */
export async function readHelpDoc(topic: string): Promise<string> {
  const filePath = resolveHelpPath(topic);

  try {
    const fs = await import('node:fs/promises');
    const contents = await fs.readFile(filePath, 'utf-8');
    return contents;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new HelpDocNotFoundError(topic as HelpTopic, filePath);
    }
    throw err;
  }
}
