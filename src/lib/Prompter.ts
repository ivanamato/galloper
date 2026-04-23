import { createInterface, Interface } from 'node:readline';

export interface Prompter {
  ask(question: string): Promise<string>;
  close(): void;
}

export function createReadlinePrompter(): Prompter {
  const rl: Interface = createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  return {
    ask(question: string): Promise<string> {
      return new Promise((resolve) => {
        rl.question(question, (answer) => {
          resolve(answer);
        });
      });
    },
    close(): void {
      rl.close();
    },
  };
}
