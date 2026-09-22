import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
export const JEV_MODEL = 'typesafe/jev-1.13';
export const JEV_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
export async function decide({ state, questions, ledger, label, outDir, fetchImpl = fetch, apiKey }) {
  const body = { model: JEV_MODEL, state, questions };
  const serialized = JSON.stringify(body);
  // Well below provider's 32k-token limit; no free-form generation, no paid retries.
  if (Buffer.byteLength(serialized) > 90000) throw Error('Jev request exceeds pilot byte limit.');
  const key = apiKey ?? process.env.OPENROUTER_API_KEY ?? JSON.parse(fs.readFileSync(path.join(os.homedir(), '.pi/agent/auth.json'), 'utf8')).openrouter?.key;
  if (!key) throw Error('OpenRouter API key unavailable.');
  // 32k * $0.042/M = $0.001344. Reserve over 7x that; fail closed on unexpected charges.
  const reservation = ledger.reserve(label, 0.01, 'openrouter-actual');
  const start = Date.now();
  const response = await fetchImpl(JEV_ENDPOINT, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: serialized, signal: AbortSignal.timeout(30000),
  });
  const data = await response.json();
  if (outDir) { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, `${reservation}.json`), JSON.stringify({ request: body, status: response.status, response: data, durationMs: Date.now() - start }, null, 2), { mode: 0o600 }); }
  if (!response.ok || data.error) throw Error(`Jev failed HTTP ${response.status}; reservation retained. ${JSON.stringify(data.error ?? {}).slice(0, 250)}`);
  const cost = data.usage?.cost;
  if (typeof cost !== 'number' || !Number.isFinite(cost)) throw Error('Jev response lacks actual usage.cost; stop and reconcile reservation.');
  ledger.settle(reservation, cost, { usage: data.usage, model: data.model, durationMs: Date.now() - start });
  for (const [id,q] of Object.entries(questions)) {
    const a=data.answers?.[id];
    if (!a || a.type !== q.type) throw Error(`Invalid Jev answer ${id}`);
    if (q.type==='choice' && !Object.hasOwn(q.criteria,a.choice)) throw Error(`Out-of-set Jev choice ${id}`);
    if (q.type==='noul' && !(typeof a.noul==='number' && Number.isFinite(a.noul) && a.noul>=0 && a.noul<=1)) throw Error(`Invalid Jev probability ${id}`);
  }
  return { ...data, durationMs: Date.now() - start, ledgerId: reservation };
}
