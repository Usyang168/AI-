/**
 * 浏览器环境自探测（多平台、零硬编码路径）。
 *
 * 读取优先级（与 headless-browser-screenshot 的既定约定一致）：
 *   1. 环境变量：DSH_PAGE_CHROME / DSH_PAGE_LIBS / DSH_PAGE_FONTCONF / DSH_PAGE_PWROOT / DSH_PAGE_SHARED_ROOT
 *   2. <DSH_HOME>/browser-env.json（本机登记过的固定记录，键：chrome / libs / fontconf / pwroot / sharedRoot）
 *   3. 自动探测：常见安装路径（linux / macOS / Windows）+ playwright 自带浏览器
 *
 * 探测不到时返回 ok:false + reason，由调用方 SKIP（不伪装通过）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const isFile = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }
const isDir = (p) => { try { return fs.statSync(p).isDirectory() } catch { return false } }

/** 各平台常见 chrome/chromium/edge 可执行文件候选。 */
function chromeCandidates() {
  const home = os.homedir()
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files'
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    const local = process.env['LOCALAPPDATA'] || path.join(home, 'AppData', 'Local')
    return [
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ]
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    ]
  }
  return [
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable', '/snap/bin/chromium', '/usr/local/bin/chromium',
    '/opt/google/chrome/chrome',
  ]
}

/** 在若干根目录下找 playwright / playwright-core。 */
function resolvePlaywright(roots = []) {
  for (const root of roots.filter(Boolean)) {
    try {
      const req = createRequire(path.join(root, 'noop.js'))
      for (const name of ['playwright', 'playwright-core']) {
        try { return { module: req(name), from: path.join(root, name) } } catch { /* 继续 */ }
      }
    } catch { /* 继续 */ }
  }
  return null
}

/**
 * @param {{ home?: string, requirePlaywright?: boolean }} opts
 * @returns {{ ok:boolean, reason?:string, chrome?:string, libs?:string, fontconf?:string, playwright?:any, source:string }}
 */
export function resolveBrowserEnv(opts = {}) {
  const home = opts.home || process.env.DSH_HOME || ''
  let recorded = {}
  const envFile = home ? path.join(home, 'browser-env.json') : ''
  if (envFile && isFile(envFile)) {
    try { recorded = JSON.parse(fs.readFileSync(envFile, 'utf8')) } catch { recorded = {} }
  }
  const sharedRoot = process.env.DSH_PAGE_SHARED_ROOT || recorded.sharedRoot || ''
  const chrome = process.env.DSH_PAGE_CHROME || recorded.chrome || chromeCandidates().find(isFile) || ''
  const libs = process.env.DSH_PAGE_LIBS || recorded.libs || ''
  const fontconf = process.env.DSH_PAGE_FONTCONF || recorded.fontconf || ''
  const pwroot = process.env.DSH_PAGE_PWROOT || recorded.pwroot || sharedRoot || ''
  const source = process.env.DSH_PAGE_CHROME ? 'env' : (recorded.chrome ? 'browser-env.json' : (chrome ? 'auto-detect' : 'none'))

  const playwright = opts.requirePlaywright === false ? null : resolvePlaywright([pwroot, home, process.cwd()])
  if (!chrome) return { ok: false, reason: '未找到浏览器可执行文件（设置 DSH_PAGE_CHROME，或跑 `ui-perf.mjs --register` 登记到 <DSH_HOME>/browser-env.json）', playwright, source }
  if (!isFile(chrome)) return { ok: false, reason: `浏览器路径不可执行：${chrome}`, playwright, source }
  if (opts.requirePlaywright !== false && !playwright) return { ok: false, reason: '未找到 playwright（设置 DSH_PAGE_PWROOT 指向含 node_modules/playwright 的目录，或用 npm i -D playwright 安装）', chrome, source }
  return { ok: true, chrome, libs, fontconf, sharedRoot, playwright, source }
}

/** 把探测结果登记进 <DSH_HOME>/browser-env.json（换机/换版本时跑一次）。 */
export function registerBrowserEnv(home = process.env.DSH_HOME) {
  const r = resolveBrowserEnv({ home, requirePlaywright: false })
  if (!r.ok) return { ok: false, reason: r.reason }
  const file = path.join(home, 'browser-env.json')
  let cur = {}
  try { cur = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { cur = {} }
  const next = { ...cur, chrome: r.chrome, libs: r.libs || cur.libs || '', fontconf: r.fontconf || cur.fontconf || '', pwroot: process.env.DSH_PAGE_PWROOT || cur.pwroot || r.sharedRoot || '', sharedRoot: r.sharedRoot || cur.sharedRoot || '' }
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
  return { ok: true, file, wrote: next }
}

/** 启动参数：无 GPU 环境给软件渲染兜底，容器/CI 常见限制一并绕开。 */
export function launchArgs(extra = []) {
  return ['--no-sandbox', '--disable-dev-shm-usage', ...extra]
}

/** 子进程/浏览器所需环境（库路径与字体只在被登记时注入）。 */
export function browserProcessEnv(env) {
  const out = { ...process.env }
  if (env.libs) out.LD_LIBRARY_PATH = env.libs
  if (env.fontconf) out.FONTCONFIG_FILE = env.fontconf
  return out
}

/**
 * 取实例端口：**不写死任何端口** —— 显式传入 > DSH_PAGE_PORT > 实例主日志里的 `127.0.0.1:<port>`。
 * 每个实例端口都不同（各人环境各异），所以只做「参数化 + 自动探测」，探测不到就让调用方明确传参。
 * 日志路径与 resolveToken 同源；取最后一次出现（最新一次启动）。
 */
export function resolvePort(explicit, home = process.env.DSH_HOME) {
  if (explicit) return String(explicit)
  if (process.env.DSH_PAGE_PORT) return String(process.env.DSH_PAGE_PORT)
  if (!home) return ''
  const candidates = [
    path.join(path.dirname(home), 'DeepSeekHarness-NAS.log'),
    path.join(home, 'logs', 'dsh.log'),
  ]
  for (const f of candidates) {
    try {
      const hits = fs.readFileSync(f, 'utf8').match(/127\.0\.0\.1:(\d{2,5})/g)
      if (hits && hits.length) return hits[hits.length - 1].split(':')[1]
    } catch { /* 继续 */ }
  }
  return ''
}

/** 端口探活：宿主没起来就别假装测了。 */
export async function probeHost(port, timeoutMs = 3000) {
  if (!port) return false
  const net = await import('node:net')
  return new Promise((resolvePromise) => {
    const sock = net.connect(Number(port), '127.0.0.1')
    const done = (ok) => { try { sock.destroy() } catch { /* ignore */ } ; resolvePromise(ok) }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
  })
}

/**
 * 取实例 token：显式传入 > DSH_PAGE_TOKEN > 实例主日志里的 token=（只读最后一条，不打印）。
 * 日志路径按 DSH_HOME 推导（<DSH_HOME>/.. 下的 DeepSeekHarness-NAS.log），找不到就返回空串。
 */
export function resolveToken(explicit, home = process.env.DSH_HOME) {
  if (explicit) return explicit
  if (process.env.DSH_PAGE_TOKEN) return process.env.DSH_PAGE_TOKEN
  if (!home) return ''
  const candidates = [
    path.join(path.dirname(home), 'DeepSeekHarness-NAS.log'),
    path.join(home, 'logs', 'dsh.log'),
  ]
  for (const f of candidates) {
    try {
      const hits = fs.readFileSync(f, 'utf8').match(/token=([A-Za-z0-9_-]+)/g)
      if (hits && hits.length) return hits[hits.length - 1].slice(6)
    } catch { /* 继续 */ }
  }
  return ''
}

export { isDir, isFile }
