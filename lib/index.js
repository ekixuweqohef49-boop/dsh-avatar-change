/**
 * dsh-avatar-change —— 这个包主体是 bundle 补丁（cordis.patch.yml），
 * 真正的能力在 lib/server.mjs 那个 stdio MCP 服务里。
 *
 * 保留一个空插件实现，是为了让 profile 把本包当 bundle 装载时不会因为
 * 「找不到入口模块」而报错；它不注册任何东西。
 */
export const name = 'dsh-avatar-change';

export function apply() {
  // 有意的空实现：所有工具都由 cordis.patch.yml 插入的 mcp-client 提供。
}
