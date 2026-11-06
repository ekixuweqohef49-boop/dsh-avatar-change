#!/usr/bin/env node
/**
 * dsh-avatar-change 安装器
 *
 * 做四件事（全部幂等，改前先备份）：
 *   1. 生成 cordis.patch.yml（把当前 node 与 server.mjs 的绝对路径写进去）
 *   2. ~/.dsh/plugins/dsh-avatar-change → 本目录（junction）
 *   3. <profile>/node_modules/dsh-avatar-change → 上面那个 junction
 *   4. profile package.json 加 link: 依赖 + bundles 里加自己，然后跑 dsh plugin install
 *
 * 用法：
 *   node install.mjs                     # 默认 profile=desktop
 *   node install.mjs --profile desktop
 *   node install.mjs --uninstall
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const PKG = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'package.json'), 'utf8'));
const NAME = PKG.name;

const argv = process.argv.slice(2);
const profileIdx = argv.indexOf('--profile');
const PROFILE = profileIdx >= 0 ? String(argv[profileIdx + 1] || 'desktop') : 'desktop';
const UNINSTALL = argv.includes('--uninstall');

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const PROFILE_DIR = path.join(DSH_HOME, 'profiles', PROFILE);
const PLUGIN_LINK = path.join(DSH_HOME, 'plugins', NAME);
const NODE_LINK = path.join(PROFILE_DIR, 'node_modules', NAME);
const PATCH_FILE = path.join(PLUGIN_DIR, 'cordis.patch.yml');

function log(...a) { console.log(...a); }
function fail(msg) { console.error(`✗ ${msg}`); process.exit(1); }

function backup(file) {
  if (!fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${file}.bak-${stamp}`;
  fs.copyFileSync(file, dest);
  return dest;
}

function ensureDirLink(linkPath, targetPath) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  try {
    const st = fs.lstatSync(linkPath);
    if (st.isSymbolicLink() || st.isDirectory()) {
      // 目录型 junction 在 Windows 上 lstat 为 symlink
      fs.rmSync(linkPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(linkPath);
    }
  } catch {}
  fs.symlinkSync(targetPath, linkPath, 'junction');
  log(`  link ${linkPath} → ${targetPath}`);
}

function writePatch() {
  const nodeExe = process.execPath.replace(/\\/g, '/');
  const server = path.join(PLUGIN_DIR, 'lib', 'server.mjs').replace(/\\/g, '/');
  const yaml = `# 由 dsh-avatar-change/install.mjs 自动生成；改路径请重跑 install.mjs。
# 一个 bundle 只插一条：stdio MCP 客户端 → lib/server.mjs。
- insert:
    - id: mcp-avatar-change
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: avatar-change
        transport: stdio
        command: '${nodeExe}'
        args:
          - '${server}'
        toolCallTimeoutMs: 130000
`;
  const old = fs.existsSync(PATCH_FILE) ? fs.readFileSync(PATCH_FILE, 'utf8') : '';
  if (old === yaml) { log('  cordis.patch.yml 已是最新'); return; }
  if (old) backup(PATCH_FILE);
  fs.writeFileSync(PATCH_FILE, yaml, 'utf8');
  log(`  cordis.patch.yml 已写入（node=${nodeExe}）`);
}

function patchProfilePackage() {
  const pkgFile = path.join(PROFILE_DIR, 'package.json');
  if (!fs.existsSync(pkgFile)) fail(`找不到 ${pkgFile}；先确认 DSH profile "${PROFILE}" 存在`);
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  pkg.dependencies = pkg.dependencies || {};
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  pkg.dsh.profile.bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];

  if (UNINSTALL) {
    delete pkg.dependencies[NAME];
    pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== NAME);
  } else {
    pkg.dependencies[NAME] = `link:${PLUGIN_LINK.replace(/\\/g, '/')}`;
    if (!pkg.dsh.profile.bundles.includes(NAME)) pkg.dsh.profile.bundles.push(NAME);
  }
  const copy = backup(pkgFile);
  if (copy) log(`  package.json 备份 → ${path.basename(copy)}`);
  fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  log(`  ${UNINSTALL ? '移除' : '注册'} bundle: ${NAME}${UNINSTALL ? '' : `（link:${PLUGIN_LINK}）`}`);
}

function runInstall() {
  // 直接按 dsh.cmd 的做法调用：Electron 可执行文件 + app.asar 里的 cli.js，
  // 以 ELECTRON_RUN_AS_NODE 运行。走 cmd 传参会被 # 和引号拆坏，这里避免 shell。
  const exe = process.env.DSH_EXE || 'D:\\#DSH\\DeepSeek Harness.exe';
  const cli = process.env.DSH_CLI
    || 'D:\\#DSH\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js';
  if (!fs.existsSync(exe)) {
    log(`  跳过 dsh plugin install（没找到 ${exe}）；DSH 下次启动时也会加载 profile。`);
    return;
  }
  const r = spawnSync(exe, ['--expose-internals', cli, 'plugin', '--profile', PROFILE, 'install'], {
    encoding: 'utf8',
    timeout: 180000,
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (r.status === 0) {
    log('  dsh plugin install: OK');
    if (out) log(`  ${out.split('\n').slice(-3).join('\n  ')}`);
  } else {
    log(`  dsh plugin install 退出码 ${r.status}（插件文件已就位，通常重启 DSH 即可）`);
    if (out) log(`  ${out.split('\n').slice(-6).join('\n  ')}`);
  }
}

log(`dsh-avatar-change v${PKG.version} → profile "${PROFILE}"`);
log(`插件目录：${PLUGIN_DIR}`);
log(`DSH home：${DSH_HOME}`);

if (UNINSTALL) {
  log('卸载：');
} else {
  log('1) 生成 cordis.patch.yml');
  writePatch();
  log('2) 建立链接');
  ensureDirLink(PLUGIN_LINK, PLUGIN_DIR);
  ensureDirLink(NODE_LINK, PLUGIN_LINK);
}
log(`${UNINSTALL ? '3' : '3'}) 更新 profile package.json`);
patchProfilePackage();
log('4) dsh plugin install');
runInstall();

if (UNINSTALL) {
  for (const p of [NODE_LINK, PLUGIN_LINK]) {
    try { fs.rmSync(p, { recursive: true, force: true }); log(`  已删除 ${p}`); } catch (e) { log(`  删除 ${p} 失败：${e.message}`); }
  }
  try { fs.rmSync(PATCH_FILE, { force: true }); } catch {}
}

log(UNINSTALL ? '完成。重启 DSH 后生效。' : '完成。刷新 DSH 页面（或重启）后，工具列表里会出现 avatar_* / profile_set_nickname。');
