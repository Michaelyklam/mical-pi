export default {
  id: 'normalize-tags',
  category: 'normalization',
  difficulty: 'easy',
  entry: 'tags.mjs',
  exportName: 'normalizeTags',
  prompt: `Fix normalizeTags(values) in tags.mjs. Input is an array of JSON values.
Keep only strings. Trim whitespace, lowercase, then replace each run of whitespace
or underscores with one hyphen. Strip leading/trailing hyphens. Discard empty
results and deduplicate after normalization, retaining first-seen order.
Return a new array and do not mutate the input. Use no external dependencies.`,
  files: {
    'tags.mjs': `export function normalizeTags(values) {
  return [...new Set(values.filter(v => typeof v === 'string').map(v => v.trim().toLowerCase()))];
}
`,
  },
  cases: [
    { args: [[]], expected: [] },
    { args: [[' Hello World ', 'hello_world', 'NEXT']], expected: ['hello-world', 'next'] },
    { args: [[null, 12, false, {}, [], 'ok']], expected: ['ok'] },
    { args: [['', '  ', '___', '--', ' A__ B ', 'a-b']], expected: ['a-b'] },
    { args: [['Z', 'a', 'z', 'B', 'a', '\tNew\nTag_']], expected: ['z', 'a', 'b', 'new-tag'] },
    { args: [['a--b', '-a-', 'a.b', 'a__b']], expected: ['a--b', 'a', 'a.b', 'a-b'] },
  ],
  referenceFiles: {
    'tags.mjs': `export function normalizeTags(values) {
  const result = [];
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const tag = value.trim().toLowerCase().replace(/[\\s_]+/g, '-').replace(/^-+|-+$/g, '');
    if (tag && !seen.has(tag)) { seen.add(tag); result.push(tag); }
  }
  return result;
}
`,
  },
};
