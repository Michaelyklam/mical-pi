#!/usr/bin/env node
/** Maintained Pi 0.87.1 source patch. Adds a between-turn request and one compaction owner.
 * Applies to the SDK and CLI bundle, not runtime prototypes. Remove when Pi ships this interface.
 *
 * The marker carries the patch revision: pristine 0.87.1 and prior-revision installs are both
 * patched to the current revision; current-revision installs are left byte-identical. Unknown
 * versions or shapes fail before any file in a package is written.
 *
 * Usage: node scripts/patch-pi-coding-agent-compaction-lifecycle.mjs [--check] [--root PACKAGE_ROOT]
 */
import { parse } from 'acorn';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MARKER = 'PI_COMPACTION_LIFECYCLE_V3';
export const PRIOR_MARKERS = ['PI_COMPACTION_LIFECYCLE_V2', 'PI_COMPACTION_LIFECYCLE_V1'];
export const SUPPORTED_PI_VERSION = '0.87.1';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const methodsSource = readFileSync(new URL('./compaction-lifecycle-methods.mjs', import.meta.url), 'utf8');
const template = parse(methodsSource, { ecmaVersion: 'latest', sourceType: 'module' }).body[0].declaration;
const replacements = new Map(template.body.body.map(m => [m.key.name, methodsSource.slice(m.start, m.end)]));

function visit(node, fn) {
  if (!node || typeof node !== 'object') return;
  fn(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(v => visit(v, fn));
    else if (value && typeof value === 'object') visit(value, fn);
  }
}

/**
 * Remove the inline edits of a prior revision so the current edits apply to clean
 * anchors. Replaced method bodies need no restoration: this patch replaces them by
 * name. Only the deterministic inline snippets and the trailing marker remain.
 */
export function stripPriorRevision(source) {
  let out = source;
  out = out.replace(/if \(this\._requestedCompaction\) \{ const signal = this\.agent\.signal; await this\._runRequestedCompaction\(\); this\._flushPendingCustomMessages\(\); signal\?\.throwIfAborted\(\); return \{ \.\.\.\w+, messages: (?:this\.agent\.state\.messages\.slice\(\)|this\.sessionManager\.buildSessionProjection\(\)\.messages) \}; \}\n?/g, '');
  out = out.replace(/;this\.agent\.signal\?\.throwIfAborted\(\);/g, '');
  out = out.replace(/requestCompaction: \(options\) => this\.requestCompaction\(options\), abortCompaction: \(\) => this\.abortCompaction\(\), /g, '');
  out = out.replace(/\n?this\.requestCompactionFn = \w+\.requestCompaction; this\.abortCompactionFn = \w+\.abortCompaction;\n?/g, '');
  out = out.replace(/requestCompaction: \(options\) => \{ \w+\.assertActive\(\); \w+\.requestCompactionFn\(options\); \}, abortCompaction: \(\) => \{ \w+\.assertActive\(\); \w+\.abortCompactionFn\(\); \}, /g, '');
  for (const marker of PRIOR_MARKERS) out = out.replace(new RegExp(`\\n*// ${marker}\\n*`, 'g'), '\n');
  return out;
}

const HELPERS = ['prepareCompaction', 'estimateMessagesTokens'];
const HELPER_CALL = new RegExp(`\\b(${HELPERS.join('|')})\\(`, 'g');

/** Map each helper to the single identifier (e.g. prepareCompaction2) called within scope. */
export function resolveHelpers(scope) {
  const seen = Object.fromEntries(HELPERS.map(helper => [helper, new Set()]));
  visit(scope, n => {
    if (n.type !== 'CallExpression' || n.callee.type !== 'Identifier') return;
    const helper = HELPERS.find(h => new RegExp(`^${h}\\d*$`).test(n.callee.name));
    if (helper) seen[helper].add(n.callee.name);
  });
  return Object.fromEntries(HELPERS.map(helper => {
    const names = [...seen[helper]];
    if (names.length !== 1) throw new Error(`Unsupported Pi: compaction helper ${helper} changed (${names.length ? names.join(', ') : 'not called'})`);
    return [helper, names[0]];
  }));
}

export function patchSource(source) {
  if (source.includes(MARKER)) return source;
  const upgrading = PRIOR_MARKERS.some(marker => source.includes(marker));
  if (upgrading) source = stripPriorRevision(source);
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const edits = [];
  let found = false;
  const insert = (at, text) => edits.push({ start: at, end: at, text });
  visit(ast, node => {
    if (!['ClassDeclaration', 'ClassExpression'].includes(node.type)) return;
    const methods = new Map(node.body.body.filter(m => m.type === 'MethodDefinition').map(m => [m.key.name, m]));
    if (methods.has('_compactBeforeNextAssistantResponse') && methods.has('compact')) {
      found = true;
      for (const name of ['compact', '_runAutoCompaction', 'abortCompaction', 'abort', 'isCompacting', '_emitAgentSettled', '_bindExtensionCore', '_installAgentNextTurnRefresh', 'prompt', '_refreshFinalizedContext', '_resolveIdleWaitIfIdle', 'abortBranchSummary', '_flushPendingCustomMessages']) {
        if (!methods.has(name)) throw new Error(`Unsupported Pi: missing AgentSession.${name}`);
      }
      // The injected methods call module-level helpers. esbuild may rename them in the CLI
      // bundle (0.87.1 ships prepareCompaction2), so bind to the names this class really calls:
      // native compact() when pristine, or any method (the prior revision's) when upgrading.
      const helperNames = resolveHelpers(upgrading ? node.body : methods.get('compact'));
      for (const [name, rawText] of replacements) {
        const text = rawText.replace(HELPER_CALL, (call, helper) => `${helperNames[helper]}(`);
        const old = methods.get(name);
        if (old) edits.push({ start: old.start, end: old.end, text });
        else insert(node.body.end - 1, `\n${text}\n`);
      }
      const next = methods.get('_compactBeforeNextAssistantResponse');
      const context = next.value.params[0].name;
      insert(next.value.body.start + 1, `\nif (this._requestedCompaction) { const signal = this.agent.signal; await this._runRequestedCompaction(); this._flushPendingCustomMessages(); signal?.throwIfAborted(); return { ...${context}, messages: this.sessionManager.buildSessionProjection().messages }; }\n`);
      let abortGuard = false;
      visit(methods.get('_installAgentNextTurnRefresh').value.body, n => {
        if (n.type === 'VariableDeclaration' && n.declarations.some(d => d.init?.type === 'AwaitExpression' && d.init.argument?.callee?.property?.name === '_compactBeforeNextAssistantResponse')) {
          abortGuard = true;
          insert(n.end, ';this.agent.signal?.throwIfAborted();');
        }
      });
      if (!abortGuard) throw new Error('Unsupported Pi: next-turn refresh changed');
      let bound = false;
      visit(methods.get('_bindExtensionCore').value.body, n => {
        if (n.type === 'Property' && n.key.name === 'compact') {
          bound = true;
          insert(n.start, 'requestCompaction: (options) => this.requestCompaction(options), abortCompaction: () => this.abortCompaction(), ');
        }
      });
      if (!bound) throw new Error('Unsupported Pi: compact context binding not found');
      // Streaming prompts must reach the normal steering queue during a requested compaction.
      let guarded = false;
      visit(methods.get('prompt').value.body, n => {
        if (n.type !== 'IfStatement') return;
        const test = source.slice(n.test.start, n.test.end);
        if (test.includes('this._compactionAbortController')) {
          guarded = true;
          edits.push({ start: n.test.start, end: n.test.end, text: 'this.isCompacting && !this.isStreaming' });
        } else if (test === 'this.isCompacting && !this.isStreaming') {
          guarded = true; // already at the current revision (prior-revision upgrade)
        }
      });
      if (!guarded) throw new Error('Unsupported Pi: prompt compaction guard not found');
    }
    if (methods.has('createContext') && methods.has('bindCore')) {
      found = true;
      const bind = methods.get('bindCore');
      const actions = bind.value.params[1].name;
      insert(bind.value.body.start + 1, `\nthis.requestCompactionFn = ${actions}.requestCompaction; this.abortCompactionFn = ${actions}.abortCompaction;\n`);
      let forwarded = false;
      visit(methods.get('createContext').value.body, n => {
        if (n.type === 'Property' && n.key.name === 'compact') {
          // createContext keeps a local runner reference for lazy, stale-context-safe methods.
          const compact = source.slice(n.start, n.end);
          const receiver = compact.match(/([\w$]+)\.compactFn/)?.[1];
          if (!receiver) throw new Error('Unsupported Pi: runner compact forwarding not found');
          forwarded = true;
          insert(n.start, `requestCompaction: (options) => { ${receiver}.assertActive(); ${receiver}.requestCompactionFn(options); }, abortCompaction: () => { ${receiver}.assertActive(); ${receiver}.abortCompactionFn(); }, `);
        }
      });
      if (!forwarded) throw new Error('Unsupported Pi: ExtensionRunner.createContext forwarding not found');
    }
  });
  if (!found) throw new Error('Unsupported Pi source: no session or extension runner found');
  // Reverse application preserves all unaffected bytes, including existing maintained patches.
  let patched = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) patched = patched.slice(0, edit.start) + edit.text + patched.slice(edit.end);
  patched += `\n// ${MARKER}\n`;
  parse(patched, { ecmaVersion: 'latest', sourceType: 'module' });
  return patched;
}

function sources(root) {
  const files = [join(root, 'dist/core/agent-session.js'), join(root, 'dist/core/extensions/runner.js')];
  function walk(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith('.js')) {
        const s = readFileSync(file, 'utf8');
        if (s.includes('_compactBeforeNextAssistantResponse') || (s.includes('compactFn') && s.includes('createContext'))) files.push(file);
      }
    }
  }
  walk(join(root, 'dist/bundle'));
  return files.filter(existsSync);
}

export function patchPackage(root, check = false) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const files = sources(root);
  const pending = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    if (source.includes(MARKER)) continue;
    if (manifest.version !== SUPPORTED_PI_VERSION) throw new Error(`Unsupported Pi ${manifest.version}. Review the lifecycle patch before applying.`);
    pending.push({ file, source, patched: patchSource(source) });
  }
  if (check && pending.length) throw new Error(`Lifecycle patch missing or stale in ${pending.length} files in ${root}`);
  // Validate every target before writing any of them: no partial package rewrites.
  for (const { file, patched } of pending) writeFileSync(file, patched);
  return { files: files.length, patched: pending.length };
}

export function installRoots(args = [], env = process.env) {
  const rootIndex = args.indexOf('--root');
  const roots = new Set(rootIndex >= 0 ? [resolve(args[rootIndex + 1])] : [join(ROOT, 'node_modules/@earendil-works/pi-coding-agent')]);
  if (rootIndex < 0) {
    try { roots.add(join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), '@earendil-works/pi-coding-agent')); } catch { /* Local-only if npm is unavailable. */ }
    for (const extra of (env.PI_AI_PATCH_ROOTS ?? '').split(':')) {
      // Same meaning as the sibling cost patches: entries are node_modules roots.
      if (extra) roots.add(join(extra, '@earendil-works/pi-coding-agent'));
    }
  }
  return [...roots];
}

function main() {
  for (const root of installRoots(process.argv.slice(2))) {
    if (!existsSync(join(root, 'package.json'))) continue;
    const result = patchPackage(root, process.argv.slice(2).includes('--check'));
    console.log(`[${MARKER}] ${root}: ${result.files} files, ${result.patched} patched`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { console.error(`[${MARKER}] ${error.message}`); process.exitCode = 1; }
}
