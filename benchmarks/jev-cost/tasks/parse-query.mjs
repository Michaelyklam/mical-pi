export default {
  id: 'parse-query',
  category: 'parsing',
  difficulty: 'easy',
  entry: 'query.mjs',
  exportName: 'parseQuery',
  prompt: `Fix parseQuery(text) in query.mjs. Remove at most one leading '?', split
on '&', and ignore empty segments. Split each segment at its first '=' only;
a missing '=' means an empty value. Decode key and value independently: replace
'+' with a space, then call decodeURIComponent. If decoding a component throws,
keep that component's plus-replaced text unchanged. Ignore decoded empty keys.
Return an array of [key, valuesArray] pairs in first-key appearance order;
repeated decoded keys append values. Keys such as '__proto__' are ordinary keys.
Input is a string; return JSON data without external dependencies.`,
  files: {
    'query.mjs': `export function parseQuery(text) {
  return text.replace(/^\\?/, '').split('&').filter(Boolean).map(part => {
    const [key, value = ''] = part.split('=');
    return [key, [value]];
  });
}
`,
  },
  cases: [
    { args: ['?'], expected: [] },
    { args: ['?a=1&b=2&a=3'], expected: [['a', ['1', '3']], ['b', ['2']]] },
    { args: ['&&flag&x=a=b=c&=skip&&'], expected: [['flag', ['']], ['x', ['a=b=c']]] },
    { args: ['a+b=hello+world&a%20b=%E2%9C%93'], expected: [['a b', ['hello world', '✓']]] },
    { args: ['%ZZ+x=%41%ZZ+z&ok=%41&%61=last'], expected: [['%ZZ x', ['%41%ZZ z']], ['ok', ['A']], ['a', ['last']]] },
    { args: ['__proto__=a&constructor=b&__proto__=c&??=x'], expected: [['__proto__', ['a', 'c']], ['constructor', ['b']], ['??', ['x']]] },
  ],
  referenceFiles: {
    'query.mjs': `function decode(text) {
  const spaced = text.replace(/\\+/g, ' ');
  try { return decodeURIComponent(spaced); } catch { return spaced; }
}
export function parseQuery(text) {
  const pairs = new Map();
  for (const part of text.replace(/^\\?/, '').split('&')) {
    if (!part) continue;
    const index = part.indexOf('=');
    const key = decode(index < 0 ? part : part.slice(0, index));
    const value = decode(index < 0 ? '' : part.slice(index + 1));
    if (!key) continue;
    if (!pairs.has(key)) pairs.set(key, []);
    pairs.get(key).push(value);
  }
  return [...pairs];
}
`,
  },
};
