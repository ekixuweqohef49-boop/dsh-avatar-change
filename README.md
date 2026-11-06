# dsh-avatar-change

把「**看到用户发的图 → 直接换成自己的 QQ 头像 / 昵称**」打包成一个独立 DSH 插件。

它不碰 OneBot、不碰 SnowLuma、也不需要把图片 base64 塞进模型上下文：插件自带一个 stdio MCP 服务，模型只说一句「用我刚发的那张图」，取图、校验、上传全部由本机进程完成。

## 它给出的工具

| 工具 | 用途 |
| --- | --- |
| `avatar_set_from_message` | **推荐**。`messageId` 指定一条含图消息（或它的 `seq`），桥接自己去媒体缓存取图 |
| `avatar_set_from_url` | 图片直链，桥接做 SSRF 校验并下载（直连优先、代理兜底） |
| `avatar_set_from_file` | 本机绝对路径（png/jpg/jpeg/gif/webp/bmp，≤8MB） |
| `avatar_set_from_base64` | 兜底用，别塞大图 |
| `profile_set_nickname` | 改昵称 / 签名 |
| `avatar_status` | 自检：桥接在不在、令牌读到没、主人是谁 |

## 安全边界

- 只允许落在 `private:<主人QQ>`：`ownerQQ` 从 surfcore 的 `config.json` 读，**模型无法通过参数改**；
- 群聊调用会在桥接侧被 403 拒掉（`self-profile-owner-only`）；
- 图片必须过魔数校验 + 8MB / 4000 万像素上限——SnowLuma 的 `set_qq_avatar` 本身**不校验格式**，这层必须由我们兜住；
- 插件用桥接的**控制台令牌**（`state/console-token`）调用 `/api/self/*`，这个令牌只在本机、权限等同主人。

## 依赖

- 本机装好并运行着 [surfcore](https://github.com/Mieksido/surfcore) 的桥接（默认 `127.0.0.1:3100`）；
- 桥接里 `/api/self/avatar`、`/api/self/profile` 两个端点存在（surfcore ≥ 0.8.8 + 本仓库配套改动）。

插件会自动找 surfcore 目录：`SURFCORE_ROOT` 环境变量 → 同级 `../surfcore` → 常见工作区路径。

## 安装

```bash
node install.mjs --profile desktop
```

它做四件事（幂等）：生成 `cordis.patch.yml`（写入当前 node 与 server.mjs 绝对路径）→ 建两条 junction → 把 `link:` 依赖和 bundle 注册进 profile → 跑 `dsh plugin --profile desktop install`。

刷新 DSH 页面后，工具列表里会出现 `mcp__avatar-change__*`。

卸载：

```bash
node install.mjs --profile desktop --uninstall
```

## 自检

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | node lib/server.mjs
```

或在 DSH 里直接调 `avatar_status`。
