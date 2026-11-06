#!/usr/bin/env node
/**
 * 冒烟测试：只打 MCP 协议本身，不碰真实 QQ（不会改头像/昵称）。
 *   node test/smoke.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(process.execPath, [path.join(ROOT, 'lib', 'server.mjs')], {
  stdio: ['pipe', 'pipe', 'pipe']
});

let buf = '';
const waiters = new Map();

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const resolve = waiters.get(msg.id);
    if (resolve) {
      waiters.delete(msg.id);
      resolve(msg);
    }
  }
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiters.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => { if (waiters.delete(id)) reject(new Error(`${method} 超时`)); }, 15000);
  });
}

const fail = (m) => { console.error(`✗ ${m}`); child.kill(); process.exit(1); };

const init = await rpc('initialize', { protocolVersion: '2025-06-18' });
if (init.result?.serverInfo?.name !== 'dsh-avatar-change') fail('initialize 握手失败');

const list = await rpc('tools/list', {});
const names = (list.result?.tools ?? []).map((t) => t.name);
for (const need of ['avatar_set_from_message', 'avatar_set_from_url', 'avatar_set_from_file', 'avatar_set_from_base64', 'profile_set_nickname', 'avatar_status']) {
  if (!names.includes(need)) fail(`缺少工具 ${need}`);
}

const status = await rpc('tools/call', { name: 'avatar_status', arguments: {} });
const text = status.result?.content?.[0]?.text ?? '';
if (!text.includes('桥接控制台')) fail('avatar_status 返回异常');

console.log('✓ 冒烟通过');
console.log(names.map((n) => `  · ${n}`).join('\n'));
console.log(text.split('\n').map((l) => `  ${l}`).join('\n'));
child.kill();
