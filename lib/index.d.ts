/**
 * dsh-tool-lipsync — FreeLipSync 对口型口播视频生成插件（免 Key 免登录）。
 *
 * Cordis 插件包：导出 name / inject / apply。加载后在共享 tools 注册表注册
 * 5 个 `lipsync_*` 工具。
 */

import type { Context } from '@deepseek-ai/cordis'

export const name: 'tool-lipsync'
export const inject: ['tools', 'systemPrompt']

export function apply(ctx: Context): void

export default apply
