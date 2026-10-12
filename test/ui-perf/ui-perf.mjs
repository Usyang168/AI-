#!/usr/bin/env node
/**
 * ui-perf —— DSH 插件设置页「前端刷新/滚动卡顿」通用测量工具。
 *
 * 目标：把「页面卡不卡、卡在哪」变成可复现的数字（帧率、长任务、毛玻璃面积、CPU 自耗时），
 *       而不是靠肉眼争论。适用于任何 DSH 插件页，不绑定本插件、不写死路径/端口/文案。
 *
 * 用法：
 *   node test/ui-perf/ui-perf.mjs                                  # 默认 open,idle,scroll
 *   node test/ui-perf/ui-perf.mjs --scenario boot,idle,scroll,ab    # 多场景
 *   node test/ui-perf/ui-perf.mjs --port <端口> --plugin dsh-git-push --label "Git 提交推送|Git"
 *   node test/ui-perf/ui-perf.mjs --url "http://<主机地址>:<端口>/?token=xxx"
 *   node test/ui-perf/ui-perf.mjs --strict --min-idle-fps 20 --max-scroll-p50 150
 *   node test/ui-perf/ui-perf.mjs --register                       # 探测并登记浏览器环境
 *
 * 退出码：0 正常（含 SKIP）｜2 --strict 阈值不达标｜3 --strict 且环境缺失（SKIP）
 * 环境变量：DSH_HOME / DSH_PAGE_URL / DSH_PAGE_PORT / DSH_PAGE_TOKEN / DSH_PAGE_CHROME /
 *          DSH_PAGE_LIBS / DSH_PAGE_FONTCONF / DSH_PAGE_PWROOT / DSH_PAGE_LABEL /
 *          DSH_PAGE_EXTRA_ARGS（额外 chrome 启动参数，空格分隔，如 "--use-angle=swiftshader"）
 */
import path from 'node:path'
import { parseArgs, resolveConfig } from './lib/args.mjs'
import { resolveBrowserEnv, registerBrowserEnv, browserProcessEnv, launchArgs, probeHost, resolveToken } from './lib/env.mjs'
import { installFrameSampler, idleAndMeasure, scrollAndMeasure, readFrames } from './lib/frames.mjs'
import { startProfile, stopProfile, topSelfTime } from './lib/cdp.mjs'
import { waitForSettle, openSettings, openPluginPage, visualCost, blurAudit, animationAudit, applyCss, collectErrors, maskUrl } from './lib/dsh-page.mjs'
import { ensureDir, shot, writeJson, renderMarkdown, writeMarkdown, checkThresholds } from './lib/report.mjs'

const args = parseArgs()
if (args.register) {
  const r = registerBrowserEnv()
  console.log(r.ok ? `已登记浏览器环境 → ${r.file}\n${JSON.stringify(r.wrote, null, 2)}` : `SKIP: ${r.reason}`)
  process.exit(r.ok ? 0 : 3)
}

const cfg = resolveConfig(args)
const env = resolveBrowserEnv()
if (!env.ok) {
  console.log(`SKIP: ${env.reason}`)
  process.exit(cfg.strict ? 3 : 0)
}
const token = resolveToken(cfg.token)
// 端口不预设任何值：给不到就明确让调用方传参（各人实例端口不同）。
if (!cfg.url && !cfg.port) {
  console.log('SKIP: 未探测到实例端口 —— 请用 --port/--url 指定，或设置 DSH_PAGE_PORT')
  process.exit(cfg.strict ? 3 : 0)
}
// 本机回环只是「未指定时的默认探测目标」，跨机测试请用 --url 或 DSH_PAGE_URL 指定可访问地址。
const base = cfg.url || `http://127.0.0.1:${cfg.port}/${token ? `?token=${token}` : ''}`
if (!(await probeHost(cfg.port)) && !cfg.url) {
  console.log(`SKIP: 本机 :${cfg.port} 不可达（宿主没在跑？用 --port/--url 指定可访问地址）`)
  process.exit(cfg.strict ? 3 : 0)
}
ensureDir(cfg.out)

const extraArgs = String(process.env.DSH_PAGE_EXTRA_ARGS || '').split(/\s+/).filter(Boolean)
const { chromium } = env.playwright.module
const browser = await chromium.launch({
  executablePath: env.chrome,
  headless: cfg.headless,
  args: launchArgs(extraArgs),
  env: browserProcessEnv(env),
})
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await installFrameSampler(context)
const page = await context.newPage()
const errors = collectErrors(page)
const results = {}
const extra = {}

const gotoPage = async (p = page) => { await p.goto(base, { waitUntil: 'load', timeout: 90000 }); await p.waitForTimeout(9000) }

// 任何"页内测量"场景都必须先站在插件设置页上；否则量到的是主会话页（会假绿）。
let pluginPageOpen = false
let pluginPageOpenMs = 0
const ensurePluginPage = async () => {
  if (pluginPageOpen) return { ok: true, cached: true, ms: pluginPageOpenMs }
  const t0 = Date.now()
  const s = await openSettings(page, { label: cfg.settingsLabel })
  if (!s.ok) return s
  const o = await openPluginPage(page, { label: cfg.label })
  if (!o.ok) return o
  pluginPageOpen = true
  pluginPageOpenMs = Date.now() - t0
  return { ...o, ms: pluginPageOpenMs }
}

// ── boot：整页加载（F5）的长任务与资源
if (cfg.scenarios.includes('boot')) {
  await page.evaluate(() => { window.__uiPerfLongTasks = [] }).catch(() => {})
  await gotoPage()
  const lt = await page.evaluate(() => window.__uiPerfLongTasks || [])
  const res = await page.evaluate(() => performance.getEntriesByType('resource')
    .map((r) => ({ 名称: r.name.replace(location.origin, '').slice(0, 120), 字节: r.transferSize || r.encodedBodySize || 0, ms: Math.round(r.duration) }))
    .sort((a, b) => b.字节 - a.字节).slice(0, 10))
  results.boot = {
    长任务数: lt.length,
    长任务合计ms: lt.reduce((a, b) => a + b, 0),
    最长任务ms: Math.max(0, ...lt),
    总阻塞时间ms: lt.reduce((a, b) => a + Math.max(0, b - 50), 0),
  }
  extra['boot 最大资源'] = res
  await shot(page, cfg.out, 'boot')
} else {
  await gotoPage()
}

// ── open：打开插件设置页 → 稳定
if (cfg.scenarios.includes('open')) {
  const o = await ensurePluginPage()
  if (!o.ok) results.open = { 错误: o.reason }
  else results.open = { 打开插件页ms: o.ms, ...(await visualCost(page)) }
  await shot(page, cfg.out, 'plugin-page')
}

// ── idle / scroll / profile / blur-audit / dom（都要求已站在插件页）
const pageScoped = ['idle', 'scroll', 'profile', 'blur-audit', 'dom', 'shot', 'ab'].some((s) => cfg.scenarios.includes(s))
if (pageScoped) {
  const o = await ensurePluginPage()
  if (!o.ok) {
    console.log(`SKIP: 无法进入插件设置页（${o.reason}）`)
    await browser.close()
    process.exit(cfg.strict ? 3 : 0)
  }
}

if (cfg.scenarios.includes('idle')) results.idle = await idleAndMeasure(page, cfg.idleMs)
if (cfg.scenarios.includes('scroll')) results.scroll = await scrollAndMeasure(page, { steps: cfg.steps })
if (cfg.scenarios.includes('profile')) {
  const cdp = await context.newCDPSession(page)
  await startProfile(cdp)
  await page.waitForTimeout(cfg.idleMs)
  const profile = await stopProfile(cdp, path.join(cfg.out, 'idle.cpuprofile'))
  results.profile = topSelfTime(profile, { topN: 10 })
}
if (cfg.scenarios.includes('blur-audit')) {
  extra['毛玻璃元素（按面积）'] = await blurAudit(page)
  extra['动画审计'] = await animationAudit(page)
}
if (cfg.scenarios.includes('dom')) {
  const txt = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 1200))
  results.dom = { 文本开头: txt }
}
if (cfg.scenarios.includes('shot')) await shot(page, cfg.out, 'page', { fullPage: args.full === true })

// ── ab：隔离矩阵（内置四组 + --ab-css 追加）
if (cfg.scenarios.includes('ab')) {
  const matrix = []
  const run = async (name) => { matrix.push({ 处置: name, ...(await idleAndMeasure(page, cfg.idleMs)) }) }
  await run('A 原样')
  await applyCss(page, '*{backdrop-filter:none !important;-webkit-backdrop-filter:none !important}')
  await run('B 去 backdrop-filter')
  await applyCss(page, '[class*="wallpaper"],[class*="mediascape"]{display:none !important}')
  await run('C 再隐藏壁纸')
  await applyCss(page, '*,*::before,*::after{animation:none !important;transition:none !important}')
  await run('D 再冻结动画')
  if (args['ab-css']) { await applyCss(page, String(args['ab-css'])); await run('E 自定义 --ab-css') }
  results.ab = matrix
}

results.consoleErrors = errors
const thresholds = {
  minIdleFps: args['min-idle-fps'] != null ? Number(args['min-idle-fps']) : null,
  maxScrollP50: args['max-scroll-p50'] != null ? Number(args['max-scroll-p50']) : null,
  maxOpenMs: args['max-open-ms'] != null ? Number(args['max-open-ms']) : null,
  maxConsoleErrors: args['max-console-errors'] != null ? Number(args['max-console-errors']) : null,
}
const verdict = checkThresholds(results, thresholds)

const outDir = cfg.out
const tag = args.tag ? String(args.tag) : `ui-perf-${Date.now()}`
const payload = { 工具: 'test/ui-perf', 目标: maskUrl(base), 插件: cfg.plugin, 场景: cfg.scenarios, 浏览器来源: env.source, 结果: results, 附加: extra, 阈值判定: verdict }
const jsonFile = writeJson(outDir, tag, payload)
const mdFile = writeMarkdown(outDir, tag, renderMarkdown({
  title: `ui-perf 报告（${cfg.plugin}）`,
  config: { urlMasked: maskUrl(base), plugin: cfg.plugin, browserSource: env.source },
  results, extra,
}))

if (!cfg.jsonOnly) {
  console.log(`ui-perf 场景=${cfg.scenarios.join(',')} 插件=${cfg.plugin} 浏览器来源=${env.source}`)
  for (const [k, v] of Object.entries(results)) console.log(`  ${k}: ${JSON.stringify(v)}`)
  if (verdict.failures.length) console.log(`  阈值未达标: ${verdict.failures.join(' / ')}`)
  console.log(`报告: ${jsonFile}\n      ${mdFile}`)
} else {
  console.log(JSON.stringify(payload))
}

if (!cfg.keepOpen) await browser.close()
if (cfg.strict && !verdict.ok) process.exit(2)
process.exit(0)
