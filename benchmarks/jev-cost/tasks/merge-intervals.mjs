export default {
  id: 'merge-intervals',
  category: 'algorithm',
  difficulty: 'easy',
  entry: 'intervals.mjs',
  exportName: 'mergeIntervals',
  prompt: `Fix mergeIntervals(intervals) in intervals.mjs. Input is an array of
[start, end] pairs of finite integers. Normalize reversed endpoints, discard
zero-length intervals, and merge overlapping OR touching intervals. Return pairs
sorted by ascending start with disjoint, non-touching ranges. Do not mutate the
input or its nested arrays. Use no external dependencies.`,
  files: {
    'intervals.mjs': `export function mergeIntervals(intervals) {
  const sorted = intervals.map(pair => [...pair]).sort((a, b) => a[0] - b[0]);
  const result = [];
  for (const pair of sorted) {
    const last = result.at(-1);
    if (last && pair[0] < last[1]) last[1] = pair[1];
    else result.push(pair);
  }
  return result;
}
`,
  },
  cases: [
    { args: [[]], expected: [] },
    { args: [[[5, 7], [1, 3], [3, 5]]], expected: [[1, 7]] },
    { args: [[[1, 10], [2, 3], [4, 8]]], expected: [[1, 10]] },
    { args: [[[9, 2], [0, 0], [-2, -5]]], expected: [[-5, -2], [2, 9]] },
    { args: [[[2, 2], [-1, -1]]], expected: [] },
    { args: [[[8, 10], [1, 2], [1, 2], [5, 7], [7, 8]]], expected: [[1, 2], [5, 10]] },
  ],
  referenceFiles: {
    'intervals.mjs': `export function mergeIntervals(intervals) {
  const sorted = intervals.map(([a, b]) => [Math.min(a, b), Math.max(a, b)])
    .filter(([a, b]) => a !== b).sort((a, b) => a[0] - b[0]);
  const result = [];
  for (const [start, end] of sorted) {
    const last = result.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else result.push([start, end]);
  }
  return result;
}
`,
  },
};
