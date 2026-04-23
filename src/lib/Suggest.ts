export function nearest(
  input: string,
  candidates: string[],
  max = 3,
): string[] {
  if (!input || candidates.length === 0) {
    return [];
  }

  if (candidates.includes(input)) {
    return [];
  }

  const threshold = Math.max(2, Math.ceil(input.length / 3));
  const distances = candidates.map((candidate) => ({
    candidate,
    distance: levenshteinDistance(input, candidate),
  }));

  return distances
    .filter(({ distance }) => distance <= threshold)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, max)
    .map(({ candidate }) => candidate);
}

function levenshteinDistance(a: string, b: string): number {
  const aChars = Array.from(a);
  const bChars = Array.from(b);
  const aLen = aChars.length;
  const bLen = bChars.length;

  let prev = Array(bLen + 1)
    .fill(0)
    .map((_, i) => i);
  let curr = Array(bLen + 1).fill(0);

  for (let i = 1; i <= aLen; i++) {
    curr[0] = i;
    for (let j = 1; j <= bLen; j++) {
      const cost = aChars[i - 1] === bChars[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost,
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[bLen];
}
