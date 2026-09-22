export default {
  id: 'dependency-order', category: 'algorithm', difficulty: 'medium',
  entry: 'dependencies.mjs', exportName: 'dependencyOrder',
  prompt: `Fix dependencyOrder(nodes) in dependencies.mjs. Each node has a unique
string id and an array deps of ids that must come before it. Return an array of
all ids in a valid topological order. At EVERY step, choose the earliest node in
original input order among all currently ready nodes (not lexical order and not
FIFO discovery order). Duplicate dependencies count once. Return null if any
dependency is unknown, or any cycle exists, including self-dependencies. Empty
input returns []. Do not mutate inputs. Use no external dependencies.`,
  files: {
    'dependencies.mjs': `export function dependencyOrder(nodes) {
  const done = new Set();
  const output = [];
  for (const node of nodes) {
    if (!node.deps.every(id => done.has(id))) return null;
    done.add(node.id);
    output.push(node.id);
  }
  return output;
}
`,
  },
  cases: [
    { args: [[]], expected: [] },
    { args: [[{ id: 'build', deps: ['compile'] }, { id: 'compile', deps: ['fetch'] }, { id: 'fetch', deps: [] }]], expected: ['fetch', 'compile', 'build'] },
    { args: [[{ id: 'a', deps: ['b'] }, { id: 'b', deps: [] }, { id: 'c', deps: [] }]], expected: ['b', 'a', 'c'] },
    { args: [[{ id: 'z', deps: [] }, { id: 'a', deps: [] }, { id: 'x', deps: ['z', 'z', 'a'] }]], expected: ['z', 'a', 'x'] },
    { args: [[{ id: 'a', deps: ['missing'] }]], expected: null },
    { args: [[{ id: 'ok', deps: [] }, { id: 'a', deps: ['b'] }, { id: 'b', deps: ['a'] }]], expected: null },
    { args: [[{ id: 'a', deps: ['a'] }]], expected: null },
    { args: [[{ id: '__proto__', deps: ['constructor'] }, { id: 'constructor', deps: [] }]], expected: ['constructor', '__proto__'] },
  ],
  referenceFiles: {
    'dependencies.mjs': `export function dependencyOrder(nodes) {
  const known = new Set(nodes.map(node => node.id));
  if (nodes.some(node => node.deps.some(id => !known.has(id)))) return null;
  const done = new Set();
  const output = [];
  while (output.length < nodes.length) {
    const next = nodes.find(node => !done.has(node.id) && node.deps.every(id => done.has(id)));
    if (!next) return null;
    done.add(next.id);
    output.push(next.id);
  }
  return output;
}
`,
  },
};
