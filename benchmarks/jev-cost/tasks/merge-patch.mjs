export default {
  id: 'merge-patch', category: 'merge-patch', difficulty: 'medium',
  entry: 'patch.mjs', exportName: 'mergePatch',
  prompt: `Fix mergePatch(target, patch) in patch.mjs and its helper values.mjs.
Both inputs are arbitrary JSON values. If patch is not an object (arrays and
null are not objects here), replace target with a deep copy of patch. Otherwise
start with a deep copy of target if target is an object, or {} if it is not.
For every own key of patch: null deletes the key; any other value recursively
patches the current value at that key. Missing target keys start as null.
Arrays replace, never merge by index. Return the resulting JSON value and never
mutate either input. All string keys, including '__proto__' and 'constructor',
are ordinary own data keys; do not read inherited keys. No dependencies.`,
  files: {
    'patch.mjs': `import { isObject, copy } from './values.mjs';
export function mergePatch(target, patch) {
  if (!isObject(patch)) return copy(patch);
  return {...(isObject(target) ? target : {}), ...patch};
}
`,
    'values.mjs': `export const isObject = value => value !== null && typeof value === 'object';
export const copy = value => value;
`,
  },
  cases: [
    { args: [{ a: 1, keep: 2 }, { a: null, added: 3 }], expected: { keep: 2, added: 3 } },
    { args: [{ nested: { a: 1, b: 2 }, list: [1, 2] }, { nested: { a: null, c: 3 }, list: [9] }], expected: { nested: { b: 2, c: 3 }, list: [9] } },
    { args: [[1, 2], { a: { absent: null, x: 1 } }], expected: { a: { x: 1 } } },
    { args: [{ a: 1 }, null], expected: null },
    { args: [{ a: 1 }, [null, { b: 2 }]], expected: [null, { b: 2 }] },
    { args: [false, { x: {}, missing: null }], expected: { x: {} } },
    { args: [JSON.parse('{"__proto__":{"old":1},"constructor":{"x":2},"keep":true}'), JSON.parse('{"__proto__":{"old":null,"new":3},"constructor":null}')], expected: JSON.parse('{"__proto__":{"new":3},"keep":true}') },
    { args: [{}, JSON.parse('{"__proto__":{"safe":true},"constructor":{"name":"own"}}')], expected: JSON.parse('{"__proto__":{"safe":true},"constructor":{"name":"own"}}') },
    { args: [{ deep: { a: [1] } }, {}], expected: { deep: { a: [1] } } },
    { args: [12, 'done'], expected: 'done' },
  ],
  referenceFiles: {
    'patch.mjs': `import { isObject, copy } from './values.mjs';
export function mergePatch(target, patch) {
  if (!isObject(patch)) return copy(patch);
  const result = isObject(target) ? copy(target) : {};
  for (const key of Object.keys(patch)) {
    if (patch[key] === null) delete result[key];
    else Object.defineProperty(result, key, {
      value: mergePatch(Object.hasOwn(result, key) ? result[key] : null, patch[key]),
      enumerable: true, configurable: true, writable: true,
    });
  }
  return result;
}
`,
    'values.mjs': `export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const copy = value => JSON.parse(JSON.stringify(value));
`,
  },
};
