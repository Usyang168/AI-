/**
 * CDP：采 CPU profile 并按「自耗时」归因（samples 命中数 = 自耗时占比）。
 *
 * 为什么看自耗时而不是 total time：total 会被调用栈上层放大，找不到真正的热点
 * （见 skill perf-profile-first）。解析出的表可直接看出是 JS 热点还是纯渲染（(idle)/(program) 占比高）。
 */
import fs from 'node:fs'
import path from 'node:path'

export async function startProfile(cdp, { interval = 500 } = {}) {
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval })
  await cdp.send('Profiler.start')
}

export async function stopProfile(cdp, outFile) {
  const { profile } = await cdp.send('Profiler.stop')
  if (outFile) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true })
    fs.writeFileSync(outFile, JSON.stringify(profile))
  }
  return profile
}

/** 聚合：按自耗时排序的 topN 函数 + 按文件汇总。 */
export function topSelfTime(profile, { topN = 20 } = {}) {
  const byId = new Map((profile.nodes || []).map((n) => [n.id, n]))
  const self = new Map()
  let total = 0
  for (const id of profile.samples || []) {
    const n = byId.get(id)
    if (!n) continue
    const cf = n.callFrame || {}
    const url = String(cf.url || '').replace(/^https?:\/\/[^/]+/, '')
    const key = `${cf.functionName || '(anonymous)'} @ ${url}:${(cf.lineNumber ?? -1) + 1}`
    self.set(key, (self.get(key) || 0) + 1)
    total++
  }
  const rows = [...self.entries()].map(([k, v]) => ({ 位置: k, 样本: v, 占比: +((v / Math.max(1, total)) * 100).toFixed(2) }))
    .sort((a, b) => b.样本 - a.样本)
  const byFile = new Map()
  for (const r of rows) {
    const f = (r.位置.split(' @ ')[1] || '(unknown)').replace(/:\d+$/, '')
    byFile.set(f, (byFile.get(f) || 0) + r.样本)
  }
  return {
    样本总数: total,
    采样时长秒: +((total * 0.0005)).toFixed(2),
    top函数: rows.slice(0, topN),
    按文件: [...byFile.entries()].map(([文件, 样本]) => ({ 文件, 样本, 占比: +((样本 / Math.max(1, total)) * 100).toFixed(2) })).sort((a, b) => b.样本 - a.样本).slice(0, 15),
  }
}
