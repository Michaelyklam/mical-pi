export default {
  id: 'lease-state', category: 'concurrency-state', difficulty: 'medium',
  entry: 'lease.mjs', exportName: 'simulateLease',
  prompt: `Fix simulateLease(operations) in lease.mjs. Model one shared lease,
initially free, and a fencing counter initially 0. Operations have nondecreasing
nonnegative integer at times. Before EACH operation, expire a lease when
expiresAt <= at. Types:
- {type:'acquire', at, owner, ttl}: if free, increment counter, grant a lease
  {owner, token:counter, expiresAt:at+ttl}, and return its token. If occupied,
  return null, even for the same owner.
- {type:'renew', at, owner, token, ttl}: if owner AND token match the live lease,
  set expiresAt to at+ttl and return true; otherwise false.
- {type:'release', at, owner, token}: clear only a matching live lease and return
  true; otherwise false.
Return {results:[one result per operation], lease:finalLeaseOrNull}. ttl is a
positive integer, owner a string, and tokens positive integers. A failed operation
does not increment the counter. Tokens are never reused after release or expiry.
No input mutation, timers, network, or external dependencies.`,
  files: {
    'lease.mjs': `export function simulateLease(operations) {
  let lease = null;
  const results = [];
  for (const op of operations) {
    if (lease && lease.expiresAt < op.at) lease = null;
    if (op.type === 'acquire') {
      if (lease) results.push(null);
      else { lease = {owner: op.owner, token: 1, expiresAt: op.at + op.ttl}; results.push(1); }
    } else {
      const matches = lease !== null && lease.owner === op.owner;
      results.push(matches);
      if (matches && op.type === 'release') lease = null;
      if (matches && op.type === 'renew') lease.expiresAt = op.at + op.ttl;
    }
  }
  return {results, lease};
}
`,
  },
  cases: [
    { args: [[]], expected: { results: [], lease: null } },
    { args: [[{ type: 'acquire', at: 0, owner: 'a', ttl: 5 }, { type: 'acquire', at: 1, owner: 'a', ttl: 9 }, { type: 'acquire', at: 5, owner: 'b', ttl: 2 }]], expected: { results: [1, null, 2], lease: { owner: 'b', token: 2, expiresAt: 7 } } },
    { args: [[{ type: 'acquire', at: 1, owner: 'a', ttl: 10 }, { type: 'release', at: 2, owner: 'a', token: 1 }, { type: 'acquire', at: 2, owner: 'a', ttl: 4 }, { type: 'release', at: 3, owner: 'a', token: 1 }]], expected: { results: [1, true, 2, false], lease: { owner: 'a', token: 2, expiresAt: 6 } } },
    { args: [[{ type: 'acquire', at: 0, owner: 'a', ttl: 10 }, { type: 'renew', at: 1, owner: 'b', token: 1, ttl: 99 }, { type: 'renew', at: 2, owner: 'a', token: 2, ttl: 99 }, { type: 'renew', at: 3, owner: 'a', token: 1, ttl: 2 }]], expected: { results: [1, false, false, true], lease: { owner: 'a', token: 1, expiresAt: 5 } } },
    { args: [[{ type: 'acquire', at: 0, owner: 'a', ttl: 3 }, { type: 'renew', at: 3, owner: 'a', token: 1, ttl: 2 }, { type: 'release', at: 3, owner: 'a', token: 1 }]], expected: { results: [1, false, false], lease: null } },
    { args: [[{ type: 'release', at: 0, owner: 'x', token: 1 }, { type: 'acquire', at: 1, owner: 'x', ttl: 1 }, { type: 'acquire', at: 3, owner: 'y', ttl: 1 }, { type: 'release', at: 3, owner: 'y', token: 2 }]], expected: { results: [false, 1, 2, true], lease: null } },
  ],
  referenceFiles: {
    'lease.mjs': `export function simulateLease(operations) {
  let lease = null, counter = 0;
  const results = [];
  for (const op of operations) {
    if (lease && lease.expiresAt <= op.at) lease = null;
    if (op.type === 'acquire') {
      if (lease) results.push(null);
      else {
        lease = {owner: op.owner, token: ++counter, expiresAt: op.at + op.ttl};
        results.push(counter);
      }
    } else {
      const matches = lease !== null && lease.owner === op.owner && lease.token === op.token;
      results.push(matches);
      if (matches && op.type === 'release') lease = null;
      if (matches && op.type === 'renew') lease.expiresAt = op.at + op.ttl;
    }
  }
  return {results, lease};
}
`,
  },
};
