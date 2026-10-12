/**
 * DSH 页面操作（不写死任何文案/端口/路径）：
 *   · 打开设置 → 点开指定插件的设置页（入口文本可传参，默认中英双语正则）
 *   · 稳定判据（SSE 常驻连接下不能用 networkidle）
 *   · 视觉开销统计（毛玻璃元素/面积、阴影、动画、节点）
 *   · 动画审计（谁在动：animation-name 直方图 + 样例）
 *   · 注入 CSS 做 A/B 隔离
 */

/** 等页面"稳定"：连续 quietMs 无新响应 且 无长任务。SSE(/events) 常驻，故不用 networkidle。 */
export async function waitForSettle(page, { quietMs = 1200, maxMs = 20000, pollMs = 250 } = {}) {
  const t0 = Date.now()
  let lastActivity = Date.now()
  let lastCount = -1
  page.on('response', () => { lastActivity = Date.now() })
  await page.evaluate(() => { window.__uiPerfLongTasks = [] })
  while (Date.now() - t0 < maxMs) {
    await page.waitForTimeout(pollMs)
    const { count } = await page.evaluate(() => {
      const l = window.__uiPerfLongTasks || []
      const has = l.length > 0
      window.__uiPerfLongTasks = []
      return { count: has ? 1 : 0 }
    })
    if (count > 0) lastActivity = Date.now()
    if (lastCount !== count) lastCount = count
    if (Date.now() - lastActivity >= quietMs) return { settledMs: Date.now() - t0, quiet: true }
  }
  return { settledMs: Date.now() - t0, quiet: false }
}

/** 打开设置面板；失败返回 { ok:false, reason }（不抛，让调用方决定 SKIP/失败）。 */
export async function openSettings(page, { label = 'Settings|设置', timeoutMs = 15000 } = {}) {
  try {
    await page.getByRole('button', { name: new RegExp(`^(${label})$`) }).first().click({ timeout: timeoutMs })
    await page.waitForTimeout(1200)
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: `点不开设置入口（--settings-label 传实际文案）：${String(e).split('\n')[0]}` }
  }
}

/** 打开插件设置页（入口文本可用 --label 传参；默认匹配中英文两种）。 */
export async function openPluginPage(page, { label = 'Our Free Model|免费模型', timeoutMs = 15000, settle = true } = {}) {
  const t0 = Date.now()
  try {
    await page.getByRole('button', { name: new RegExp(`^(${label})$`) }).first().click({ timeout: timeoutMs })
  } catch (e) {
    return { ok: false, reason: `找不到插件入口（--label 传实际文案）：${String(e).split('\n')[0]}` }
  }
  if (settle) await waitForSettle(page)
  return { ok: true, ms: Date.now() - t0 }
}

/** 视觉开销统计：毛玻璃元素与总面积、阴影、动画、节点数。 */
export async function visualCost(page) {
  return page.evaluate(() => {
    const all = document.querySelectorAll('*')
    let blur = 0, blurArea = 0, shadow = 0, anim = 0
    for (const el of all) {
      const st = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      if (st.backdropFilter && st.backdropFilter !== 'none') { blur++; blurArea += Math.round(Math.max(0, r.width) * Math.max(0, r.height)) }
      if (st.boxShadow && st.boxShadow !== 'none') shadow++
      if (st.animationName && st.animationName !== 'none') anim++
    }
    return { 节点: all.length, 毛玻璃元素: blur, 毛玻璃总面积px2: blurArea, 阴影元素: shadow, 动画元素: anim }
  })
}

/** 毛玻璃元素清单（按面积降序）——定位"最大的那块玻璃"。 */
export async function blurAudit(page, { topN = 15 } = {}) {
  return page.evaluate((n) => {
    const out = []
    for (const el of document.querySelectorAll('*')) {
      const st = getComputedStyle(el)
      if (!st.backdropFilter || st.backdropFilter === 'none') continue
      const r = el.getBoundingClientRect()
      out.push({
        类名: (el.className || '').toString().slice(0, 48), 标签: el.tagName,
        模糊: st.backdropFilter, 宽: Math.round(r.width), 高: Math.round(r.height),
        面积: Math.round(Math.max(0, r.width) * Math.max(0, r.height)),
        可滚动: el.scrollHeight > el.clientHeight + 20,
      })
    }
    return out.sort((a, b) => b.面积 - a.面积).slice(0, n)
  }, topN)
}

/** 动画审计：谁在动（按 animation-name 计数）+ 样例（含尺寸/时长）。 */
export async function animationAudit(page, { topN = 12 } = {}) {
  return page.evaluate((n) => {
    const byName = {}
    const samples = []
    for (const el of document.querySelectorAll('*')) {
      const st = getComputedStyle(el)
      if (!st.animationName || st.animationName === 'none') continue
      byName[st.animationName] = (byName[st.animationName] || 0) + 1
      if (samples.length < n) {
        const r = el.getBoundingClientRect()
        samples.push({ 标签: el.tagName, 类名: (el.className || '').toString().slice(0, 36), 动画: st.animationName, 时长: st.animationDuration, 尺寸: `${Math.round(r.width)}x${Math.round(r.height)}` })
      }
    }
    return { 按动画名: byName, 样例: samples }
  }, topN)
}

/** 注入 CSS 覆盖（A/B 隔离用）。 */
export async function applyCss(page, css) {
  if (!css) return
  await page.addStyleTag({ content: css })
  await page.waitForTimeout(600)
}

/** 控制台错误收集器：返回数组，调用方自行断言。 */
export function collectErrors(page) {
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)) })
  return errors
}

/** 屏蔽 token：报告里绝不留明文。 */
export function maskUrl(url) {
  return String(url).replace(/([?&]token=)[A-Za-z0-9_-]+/g, '$1***')
}
