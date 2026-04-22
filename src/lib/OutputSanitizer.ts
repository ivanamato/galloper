// Strips XML thinking blocks (both antml:thinking and plain thinking tags) from LLM output
export function stripThinkingBlocks(input: string): string {
  // Remove antml:thinking blocks (self-closing or with content)
  let result = input.replace(/<thinking[\s\S]*?<\/antml:thinking>/g, '');

  // Remove plain thinking blocks
  result = result.replace(/<thinking[\s\S]*?<\/thinking>/g, '');

  // Remove leading/trailing whitespace
  return result.trim();
}
