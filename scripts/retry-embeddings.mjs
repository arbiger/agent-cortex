#!/usr/bin/env node
import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.resolve(__dirname, '../dist/server.js');

const toolName = process.argv[2];
const argsJson = process.argv[3] || '{}';

if (!toolName) {
  console.error('Usage: node retry-embeddings.mjs <tool-name> <args-json>');
  process.exit(1);
}

let args;
try {
  args = JSON.parse(argsJson);
} catch (e) {
  console.error('Invalid JSON args:', e.message);
  process.exit(1);
}

const req = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: toolName, arguments: args }
});

const child = spawn('node', [SERVER_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });

let stdout = '';
let stderr = '';
let settled = false;

const timeout = setTimeout(() => {
  if (!settled) {
    child.kill();
    console.error('MCP call timed out');
    process.exit(1);
  }
}, 8000);

child.stdout.on('data', d => { stdout += d.toString(); });
child.stderr.on('data', d => { stderr += d.toString(); });
child.on('error', e => {
  if (!settled) {
    console.error('Spawn error:', e.message);
    process.exit(1);
  }
});

child.stdin.write(req + '\n');
child.stdin.end();

setTimeout(() => {
  clearTimeout(timeout);
  settled = true;
  const lines = stdout.trim().split('\n');
  let foundResult = false;
  let foundError = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.error) {
        foundError = true;
        console.error('MCP error:', JSON.stringify(parsed.error));
      }
      if (parsed.result) foundResult = true;
    } catch {}
  }
  if (!foundResult && !foundError) {
    if (stderr) console.error('stderr:', stderr);
    console.error('No valid response from MCP server');
    process.exit(1);
  }
  if (foundError) {
    process.exit(1);
  }
  console.log('MCP call completed');
  process.exit(0);
}, 2000);
