import normalizeTags from './normalize-tags.mjs';
import parseQuery from './parse-query.mjs';
import mergeIntervals from './merge-intervals.mjs';
import eventScheduler from './event-scheduler.mjs';
import retryPolicy from './retry-policy.mjs';
import mergePatch from './merge-patch.mjs';
import leaseState from './lease-state.mjs';
import dependencyOrder from './dependency-order.mjs';

// Parent-only registry. Never send this object wholesale to a model.
export const tasks = [
  normalizeTags, parseQuery, mergeIntervals, eventScheduler,
  retryPolicy, mergePatch, leaseState, dependencyOrder,
];
export default tasks;
