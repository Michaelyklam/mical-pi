export default {
  id: 'event-scheduler',
  category: 'event-scheduling',
  difficulty: 'medium',
  entry: 'scheduler.mjs',
  exportName: 'runSchedule',
  prompt: `Fix runSchedule(commands) in scheduler.mjs. Simulate a queue, initially
empty with clock 0. Commands arrive in array order:
- {type:'schedule', id, at, value}: replace any pending event with this string id.
  Its due time is max(clock, at). Every schedule gets a new increasing sequence.
- {type:'cancel', id}: remove a pending event if present.
- {type:'advance', to}: move clock to max(clock, to), emit and remove all events
  due at or before clock, ordered by due time then scheduling sequence.
Return all emitted events as {id, at, value}, with at equal to the clamped due
time. Scheduling never emits by itself; pending events at the end are ignored.
Times are nonnegative integers, values are JSON, command types are valid.
Do not mutate inputs. No wall-clock timers, I/O, or external dependencies.`,
  files: {
    'scheduler.mjs': `export function runSchedule(commands) {
  let pending = [];
  const output = [];
  for (const command of commands) {
    if (command.type === 'schedule') pending.push({id: command.id, at: command.at, value: command.value});
    if (command.type === 'cancel') pending = pending.filter(e => e.id !== command.id);
    if (command.type === 'advance') {
      output.push(...pending.filter(e => e.at <= command.to));
      pending = pending.filter(e => e.at > command.to);
    }
  }
  return output;
}
`,
  },
  cases: [
    { args: [[{ type: 'advance', to: 9 }]], expected: [] },
    { args: [[{ type: 'schedule', id: 'late', at: 8, value: 1 }, { type: 'schedule', id: 'early', at: 2, value: 2 }, { type: 'advance', to: 8 }]], expected: [{ id: 'early', at: 2, value: 2 }, { id: 'late', at: 8, value: 1 }] },
    { args: [[{ type: 'schedule', id: 'a', at: 3, value: 'old' }, { type: 'schedule', id: 'b', at: 3, value: 0 }, { type: 'schedule', id: 'a', at: 3, value: 'new' }, { type: 'advance', to: 3 }]], expected: [{ id: 'b', at: 3, value: 0 }, { id: 'a', at: 3, value: 'new' }] },
    { args: [[{ type: 'advance', to: 10 }, { type: 'schedule', id: 'x', at: 1, value: null }, { type: 'advance', to: 4 }, { type: 'advance', to: 20 }]], expected: [{ id: 'x', at: 10, value: null }] },
    { args: [[{ type: 'cancel', id: 'missing' }, { type: 'schedule', id: 'x', at: 0, value: {} }, { type: 'cancel', id: 'x' }, { type: 'advance', to: 0 }, { type: 'schedule', id: 'x', at: 0, value: [1] }, { type: 'advance', to: 0 }, { type: 'schedule', id: 'left', at: 1, value: false }]], expected: [{ id: 'x', at: 0, value: [1] }] },
    { args: [[{ type: 'schedule', id: 'x', at: 1, value: 1 }, { type: 'schedule', id: 'x', at: 9, value: 2 }, { type: 'advance', to: 1 }, { type: 'advance', to: 8 }]], expected: [] },
  ],
  referenceFiles: {
    'scheduler.mjs': `export function runSchedule(commands) {
  const pending = new Map();
  const output = [];
  let clock = 0, sequence = 0;
  for (const command of commands) {
    if (command.type === 'schedule') pending.set(command.id, {
      id: command.id, at: Math.max(clock, command.at), value: command.value, sequence: sequence++,
    });
    if (command.type === 'cancel') pending.delete(command.id);
    if (command.type === 'advance') {
      clock = Math.max(clock, command.to);
      const due = [...pending.values()].filter(e => e.at <= clock)
        .sort((a, b) => a.at - b.at || a.sequence - b.sequence);
      for (const {id, at, value} of due) {
        output.push({id, at, value});
        pending.delete(id);
      }
    }
  }
  return output;
}
`,
  },
};
