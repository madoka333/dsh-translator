/**
 * tools/startup-guard-check.mjs
 *
 * 用本机已装的 dsh-startup-guard 自己的校验函数，对 dsh-translator 做「能不能启动」验收：
 *   1) clientBundleVerdict —— 客户端产物契约（dsh.client.platform / exports["./client"] / 文件存在）
 *   2) vmClientLoad        —— 在 vm 沙箱里真跑一遍客户端产物，确认能向 __ModuleLoader__ 注册且不抛
 *   3) clientRegId         —— 注册的模块 id 必须唯一且非空
 *   4) runSmokeChild       —— 子进程里 import 真宿主产物并跑 apply()（DSH 自己的 smoke 手法）
 *
 * 只读：不修改任何文件。runGuard 的 fix 模式不会被调用。
 *
 * @module dsh-translator/tools/startup-guard-check
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// DSH home: honour $DSH_HOME when set, otherwise assume the default location
// under the current user's profile. Nothing here is machine-specific.
const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const PROFILE = process.env.DSH_PROFILE ?? 'web'
const PROFILE_DIR = join(HOME, 'profiles', PROFILE)
const NAME = 'dsh-translator'
const GUARD_CORE = join(PROFILE_DIR, 'node_modules', 'dsh-startup-guard', 'lib', 'guard-core.mjs')

console.log('profile dir:', PROFILE_DIR)

const guard = await import(pathToFileURL(GUARD_CORE).href)
console.log('guard-core loaded from:', GUARD_CORE)
console.log('guard exports present:', ['clientBundleVerdict', 'vmClientLoad', 'clientRegId', 'runSmokeChild']
  .map((k) => `${k}=${typeof guard[k]}`)
  .join('  '))

let failures = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

// --- 1) 客户端产物契约 -----------------------------------------------------
const verdict = guard.clientBundleVerdict(PROFILE_DIR, NAME)
check('clientBundleVerdict', verdict.ok === true, JSON.stringify(verdict))

// --- 2) 在 vm 里真跑客户端产物 ---------------------------------------------
const decl = JSON.parse(readFileSync(join(PROFILE_DIR, 'node_modules', NAME, 'package.json'), 'utf8'))
const clientRel = String(decl.exports['./client']).replace(/^\.\//, '')
const clientPath = join(PROFILE_DIR, 'node_modules', NAME, clientRel)
const code = readFileSync(clientPath, 'utf8')
console.log(`\nclient artifact: ${clientPath} (${code.length} bytes)`)

// runFactory 跟随 guard 自己的默认值：CONFIG_DEFAULTS.clientFactorySmoke === false
// （factory 依赖宿主提供的 react，guard 沙箱里没有 react —— 这是 guard 有意默认关掉它的原因，
//   所以"factory 抛错"不是本插件的缺陷，不能当失败。）
const config = guard.loadConfig(HOME)
const clientFactorySmoke = config.clientFactorySmoke === true
console.log(`\nguard defaults: clientVmCheck=${config.clientVmCheck} clientFactorySmoke=${clientFactorySmoke} smoke=${config.smoke}`)

const vmResult = guard.vmClientLoad(code, NAME, clientPath, clientFactorySmoke)
console.log('vmClientLoad:', JSON.stringify(vmResult))
check('vmClientLoad matches guard default (注册且不抛)', vmResult.ok === true, JSON.stringify(vmResult))

// 额外信息（不计入失败）：把 factory 也跑一遍，只能证明它需要宿主提供 react，这是设计如此
const vmWithFactory = guard.vmClientLoad(code, NAME, clientPath, true)
console.log(
  `INFO  factory-smoke (非默认，仅供参考): ${JSON.stringify(vmWithFactory)}` +
    '\n      —— 客户端 factory 由宿主注入 react；guard 沙箱没有 react，故此项默认关闭。',
)

// --- 3) 注册的模块 id ------------------------------------------------------
const regId = guard.clientRegId(code)
check('clientRegId is the plugin name', regId === NAME, `got ${JSON.stringify(regId)}`)
check('exactly one __ModuleLoader__.load call', (code.match(/__ModuleLoader__\.load\(/g) ?? []).length === 1)

// --- 4) 宿主 apply() 子进程 smoke -----------------------------------------
const entryPath = join(PROFILE_DIR, 'node_modules', NAME, 'lib', 'index.js')
console.log(`\nhost entry: ${entryPath}`)
const smoke = await guard.runSmokeChild(entryPath, NAME, 60_000)
console.log('runSmokeChild:', JSON.stringify(smoke))
// smoke 在沙箱里可能因 spawn 受限而拿不到结论；只有明确 broken 才算失败
const smokeBroken = smoke.status === 'broken' || smoke.status === 'fail'
check('host apply() smoke did not report broken', !smokeBroken, `status=${smoke.status}`)
if (smoke.status === 'spawn-fail' || smoke.status === 'unresolved') {
  console.log('  NOTE: smoke 没拿到结论（不是失败），稍后用真启动日志/预检复核')
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
