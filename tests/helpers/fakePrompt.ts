import { Prompter } from '../../src/lib/Prompter.js';

export interface FakePrompter extends Prompter {
  remaining(): string[];
  asked(): string[];
}

export function createFakePrompter(answers: string[]): FakePrompter {
  const queue = [...answers];
  const questions: string[] = [];
  let closed = false;

  return {
    async ask(question: string): Promise<string> {
      if (closed) {
        throw new Error('FakePrompter is closed');
      }
      questions.push(question);
      if (queue.length === 0) {
        throw new Error(`FakePrompter out of answers (asked: ${JSON.stringify(question)})`);
      }
      return queue.shift() as string;
    },
    close(): void {
      closed = true;
    },
    remaining(): string[] {
      return [...queue];
    },
    asked(): string[] {
      return [...questions];
    },
  };
}
