// Strips XML thinking blocks (both antml:thinking and plain thinking tags) from LLM output
export function stripThinkingBlocks(input: string): string {
  let result = input.replace(/<thinking\b[\s\S]*?<\/antml:thinking>/g, '');
  result = result.replace(/<thinking\b[\s\S]*?<\/thinking>/g, '');
  return result.trim();
}
