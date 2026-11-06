#!/usr/bin/env node
/**
 * dsh-avatar-change —— MCP 服务端（零依赖，手写 JSON-RPC stdio）
 *
 * 设计取舍：
 *   · 不把图片 base64 塞进模型上下文（几 MB 的 base64 既烧 token 又容易被截断）
 *   · 模型只需要说「用我刚发的那张图」「用这个 URL」，取图/校验/上传都由本进程完成
 *   · 复用本机 surfcore 桥接（127.0.0.1:<consolePort> + state/console-token），
 *     不自己连 OneBot、不碰 SnowLuma
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function log(...args) {
  // stdout 是协议通道，任何日志都必须走 stderr
  try { process.stderr.write(`[avatar-change] ${args.join(' ')}\n`); } catch {}
}

function findSurfcoreRoot() {
  const candidates = [
    process.env.SURFCORE_ROOT,
    path.resolve(PLUGIN_DIR, '..', 'surfcore'),
    'C:/Users/32063/Documents/deepseek-harness/default-workspace/surfcore'
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'src', 'bridge.js'))) return dir;
    } catch {}
  }
  return '';
}

const SURFCORE_ROOT = findSurfcoreRoot();

function readSurfcoreConfig() {
  if (!SURFCORE_ROOT) return {};
  for (const name of ['config.json', 'config.example.json']) {
    try {
      const p = path.join(SURFCORE_ROOT, name);
      if (!fs.existsSync(p)) continue;
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (raw && typeof raw === 'object') return raw;
    } catch {}
  }
  return {};
}

function readConsoleToken() {
  if (!SURFCORE_ROOT) return '';
  try {
    return fs.readFileSync(path.join(SURFCORE_ROOT, 'state', 'console-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

function bridgeTarget() {
  const cfg = readSurfcoreConfig();
  const port = Number(cfg.consolePort) || 3100;
  const token = readConsoleToken();
  const ownerQQ = String(cfg.ownerQQ ?? cfg.admin ?? '').trim();
  return { port, token, ownerQQ };
}

function httpJson(pathname, { method = 'GET', body, timeoutMs = 130000 } = {}) {
  const { port, token } = bridgeTarget();
  if (!token) {
    return Promise.reject(new Error(`没找到桥接控制台令牌（${SURFCORE_ROOT || '(未定位 surfcore 目录)'}/state/console-token）。请先确认 surfcore 桥接已启动。`));
  }
  const payload = body === undefined ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method,
      timeout: timeoutMs,
      headers: {
        'x-console-token': token,
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {})
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data;
        try { data = JSON.parse(text); } catch { data = { ok: false, error: text.slice(0, 500) }; }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('timeout', () => { req.destroy(new Error(`请求超时（${timeoutMs}ms）`)); });
    req.on('error', (e) => reject(new Error(`连不上桥接 127.0.0.1:${port}：${e?.message ?? e}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

/** 所有改资料的动作都只允许落在主人私聊；ownerQQ 从 surfcore 配置读，模型改不了。 */
function ownerKey(statedKey) {
  const { ownerQQ } = bridgeTarget();
  if (!ownerQQ) throw new Error('surfcore 配置里没有 ownerQQ，无法确定主人会话');
  if (statedKey && String(statedKey) !== `private:${ownerQQ}`) {
    throw new Error(`只允许在主人私聊里改资料：期望 private:${ownerQQ}，收到 ${statedKey}`);
  }
  return `private:${ownerQQ}`;
}

function ok(text) {
  return { content: [{ type: 'text', text }] };
}
function fail(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

async function setAvatar(payload, label) {
  const res = await httpJson('/api/self/avatar', { method: 'POST', body: payload });
  if (!res.data?.ok) return fail(`换头像失败（${label}）：${res.data?.error || `HTTP ${res.status}`}`);
  return ok(`头像已更新（${label}）：${res.data.width || '?'}x${res.data.height || '?'}，${res.data.bytes} 字节。`);
}

const TOOLS = [
  {
    name: 'avatar_set_from_message',
    description: '把某条聊天消息里的图片设成自己的 QQ 头像（最省事，不需要下载或转 base64）。主人刚发了一张图时用这个：messageId 用最近消息里的 id/seq。桥接自己取图、校验魔数、上传。',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: { type: ['string', 'number'], description: '那条含图消息的 messageId 或 seq' },
        messageKey: { type: 'string', description: '消息所在会话，默认主人的私聊' },
        mediaIndex: { type: 'number', description: '一条消息多张图时取第几张，默认 0' },
        key: { type: 'string', description: '改资料的目标会话，必须是 private:<主人QQ>（一般不用传）' }
      },
      required: ['messageId']
    },
    handler: async (a) => {
      const key = ownerKey(a.key);
      const payload = { key, messageId: String(a.messageId) };
      if (a.messageKey) payload.messageKey = String(a.messageKey);
      if (Number.isInteger(a.mediaIndex)) payload.mediaIndex = a.mediaIndex;
      return setAvatar(payload, `消息 ${a.messageId}`);
    }
  },
  {
    name: 'avatar_set_from_url',
    description: '用图片 URL 设成自己的 QQ 头像。桥接会做 SSRF 校验并自己下载（支持直连/代理兜底）。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http/https 图片直链（不要网页地址）' },
        key: { type: 'string', description: '必须是 private:<主人QQ>，一般不用传' }
      },
      required: ['url']
    },
    handler: async (a) => setAvatar({ key: ownerKey(a.key), url: String(a.url) }, 'URL')
  },
  {
    name: 'avatar_set_from_file',
    description: '用本机图片文件设成自己的 QQ 头像（扩展名限 png/jpg/jpeg/gif/webp/bmp，≤8MB）。',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '本机绝对路径' },
        key: { type: 'string', description: '必须是 private:<主人QQ>，一般不用传' }
      },
      required: ['file']
    },
    handler: async (a) => setAvatar({ key: ownerKey(a.key), file: String(a.file) }, '本地文件')
  },
  {
    name: 'avatar_set_from_base64',
    description: '用 base64 图片设成自己的 QQ 头像。只在拿不到 messageId/URL/文件时用，别把超大图塞进来。',
    inputSchema: {
      type: 'object',
      properties: {
        imageBase64: { type: 'string', description: '图片 base64，可带 data:image/png;base64, 前缀' },
        key: { type: 'string', description: '必须是 private:<主人QQ>，一般不用传' }
      },
      required: ['imageBase64']
    },
    handler: async (a) => setAvatar({ key: ownerKey(a.key), imageBase64: String(a.imageBase64) }, 'base64')
  },
  {
    name: 'profile_set_nickname',
    description: '改自己的 QQ 昵称（可同时改个性签名）。只在主人私聊里明确要求时才用。',
    inputSchema: {
      type: 'object',
      properties: {
        nickname: { type: 'string', description: '新昵称，1~24 个字符，不能含链接、@、换行' },
        signature: { type: 'string', description: '可选：新签名，≤60 字符' },
        key: { type: 'string', description: '必须是 private:<主人QQ>，一般不用传' }
      },
      required: ['nickname']
    },
    handler: async (a) => {
      const body = { key: ownerKey(a.key), nickname: String(a.nickname) };
      if (a.signature !== undefined) body.signature = String(a.signature);
      const res = await httpJson('/api/self/profile', { method: 'POST', body });
      if (!res.data?.ok) return fail(`改昵称失败：${res.data?.error || `HTTP ${res.status}`}`);
      return ok(`昵称已更新：${res.data.previousNickname || '(空)'} → ${res.data.nickname}`);
    }
  },
  {
    name: 'avatar_status',
    description: '查看换头像插件是否就绪：桥接是否在线、当前模式、主人账号、控制台令牌是否读到。',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const { port, token, ownerQQ } = bridgeTarget();
      const lines = [
        `surfcore 目录：${SURFCORE_ROOT || '(未找到)'}`,
        `桥接控制台：127.0.0.1:${port}　令牌：${token ? '已读取' : '缺失'}`,
        `主人 QQ：${ownerQQ || '(未配置 ownerQQ)'}`
      ];
      try {
        const res = await httpJson('/api/status', { timeoutMs: 5000 });
        lines.push(`桥接状态：${res.data?.ok === false ? '异常' : '在线'}（HTTP ${res.status}）`);
        if (res.data?.mode) lines.push(`当前模式：${res.data.mode}`);
      } catch (e) {
        lines.push(`桥接状态：连不上（${e?.message ?? e}）`);
      }
      return ok(lines.join('\n'));
    }
  }
];

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { log('无法解析的输入行，已忽略'); continue; }
    handle(msg).catch((e) => log('处理失败', e?.message ?? e));
  }
});

async function handle(msg) {
  const { id, method, params } = msg || {};
  const isNotification = id === undefined || id === null;

  if (method === 'initialize') {
    if (isNotification) return;
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'dsh-avatar-change', version: '0.1.0' }
      }
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'ping') {
    if (!isNotification) send({ jsonrpc: '2.0', id, result: {} });
    return;
  }
  if (method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }
    });
    return;
  }
  if (method === 'tools/call') {
    const name = params?.name;
    const tool = TOOL_MAP.get(name);
    if (!tool) {
      send({ jsonrpc: '2.0', id, result: fail(`未知工具：${name}`) });
      return;
    }
    try {
      const result = await tool.handler(params?.arguments || {});
      send({ jsonrpc: '2.0', id, result });
    } catch (e) {
      send({ jsonrpc: '2.0', id, result: fail(`${name} 失败：${e?.message ?? e}`) });
    }
    return;
  }
  if (isNotification) return;
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
}

log(`已启动；surfcore=${SURFCORE_ROOT || '(未定位)'}`);
