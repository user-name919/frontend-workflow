#!/usr/bin/env node

/**
 * 解决什么问题：npx / CLI 需要一个稳定入口，把安装、项目落地和体检交给同一套逻辑，避免调用方各自拼路径。冲突时绝不能半写入，否则用户目录或业务仓库会被改坏。入口层还要把失败码和冲突提示统一抛给终端。
 * 通过什么方式解决：本文件只转发 argv 给 installer.runCli，自己不写盘、不备份。成功时仅当 result.ok === false 才设退出码 1；捕获 ConflictError 时额外提示“未改任何文件”，并建议复查或加 --force。
 * 触发时机：人用 npx github:... 或本地 bin 执行 install / setup / doctor / help 时。
 * 被谁控制触发：人直接跑 CLI；主 Agent 或其它脚本也可以调用本入口，但冲突是否写盘仍由 installer 决定。
 */

import { ConflictError, runCli } from '../src/installer.mjs'

try {
  const result = await runCli(process.argv.slice(2))
  if (result.ok === false) process.exitCode = 1
} catch (error) {
  console.error(error.message)
  // ConflictError 表示分类后发现冲突或非普通文件，applyPlan 尚未写盘。
  if (error instanceof ConflictError) {
    console.error('\nNothing was changed. Review the files or rerun with --force to create backups and replace them.')
  }
  process.exitCode = 1
}
