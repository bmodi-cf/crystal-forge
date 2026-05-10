#!/usr/bin/env node
// Deterministic stand-in for the `claude` CLI. Reads "user" lines from stdin
// (terminated by Enter) and emits a fake assistant reply. Also writes a
// session JSONL transcript so the watcher imports it into the DB.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const sessionId = process.argv.slice(2).find((a) => a.startsWith('--resume='))?.replace('--resume=', '')
  ?? crypto.randomUUID();
const cwd = process.cwd();
const projectDir = path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[\/.]/g, '-'));
fs.mkdirSync(projectDir, { recursive: true });
const file = path.join(projectDir, `${sessionId}.jsonl`);
function emit(line) { fs.appendFileSync(file, JSON.stringify(line) + '\n'); }

process.stdout.write(`stub-claude session ${sessionId}\n> `);
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    emit({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: line }] }, sessionId });
    const reply = `you said: ${line}`;
    emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply }] }, sessionId });
    process.stdout.write(`${reply}\n> `);
  }
});
process.stdin.on('end', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
