/**
 * 报告输出：JSON（机器读）+ Markdown（人读）+ 截图落盘。
 * 报告里出现的 URL 一律脱敏（token → ***）。
 */
import fs from 'node:fs'
import path from 'node:path'

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export async function shot(page, outDir, name, opts = {}) {
  ensureDir(outDir)
  const file = path.join(outDir, `${name}.png`)
  await page.screenshot({ path: file, ...opts })
  return file
}

export function writeJson(outDir, tag, data) {
  ensureDir(outDir)
  const file = path.join(outDir, `${tag}.json`)
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
  return file
}

const row = (k, v) => `| ${k} | ${typeof v === 'object' ? '`' + JSON.stringify(v) + '`' : v} |`

/** 把结果渲染成 Markdown（表格化，便于贴进 issue/PR/会话）。 */
export function renderMarkdown({ title, config, results, extra = {} }) {
  const lines = [`# ${title}`, '', `- 生成时间：${new Date().toISOString()}`, `- 目标：${config.urlMasked}`, `- 插件：${config.plugin}`, `- 浏览器来源：${config.browserSource}`, '']
  for (const [name, data] of Object.entries(results)) {
    lines.push(`## ${name}`, '')
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      lines.push('| 指标 | 值 |', '|---|---|')
      for (const [k, v] of Object.entries(data)) lines.push(row(k, v))
    } else {
      lines.push('```json', JSON.stringify(data, null, 2), '```')
    }
    lines.push('')
  }
  for (const [name, list] of Object.entries(extra)) {
    lines.push(`## ${name}`, '', '```json', JSON.stringify(list, null, 2), '```', '')
  }
  return lines.join('\n')
}

export function writeMarkdown(outDir, tag, md) {
  ensureDir(outDir)
  const file = path.join(outDir, `${tag}.md`)
  fs.writeFileSync(file, md)
  return file
}

/**
 * 阈值判定（--strict 时用）。只对显式给出的阈值负责，避免把环境差异当失败。
 * @returns {{ok:boolean, failures:string[]}}
 */
export function checkThresholds(results, thresholds = {}) {
  const failures = []
  const pick = (obj, key) => (obj && typeof obj === 'object' ? obj[key] : undefined)
  if (thresholds.minIdleFps != null) {
    const v = pick(results.idle, 'FPS')
    if (typeof v === 'number' && v < thresholds.minIdleFps) failures.push(`待机 FPS ${v} < ${thresholds.minIdleFps}`)
  }
  if (thresholds.maxScrollP50 != null) {
    const v = pick(results.scroll, 'p50')
    if (typeof v === 'number' && v > thresholds.maxScrollP50) failures.push(`滑动 p50 ${v}ms > ${thresholds.maxScrollP50}ms`)
  }
  if (thresholds.maxOpenMs != null) {
    const v = pick(results.open, '打开插件页ms')
    if (typeof v === 'number' && v > thresholds.maxOpenMs) failures.push(`打开插件页 ${v}ms > ${thresholds.maxOpenMs}ms`)
  }
  if (thresholds.maxConsoleErrors != null) {
    const v = Array.isArray(results.consoleErrors) ? results.consoleErrors.length : 0
    if (v > thresholds.maxConsoleErrors) failures.push(`控制台错误 ${v} > ${thresholds.maxConsoleErrors}`)
  }
  return { ok: failures.length === 0, failures }
}
