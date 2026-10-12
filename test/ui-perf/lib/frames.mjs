/**
 * 帧率采样与统计：用 requestAnimationFrame 间隔衡量"页面是否真的在流畅出帧"。
 * 为什么不用 FPS 平均值：平均值会被长停顿掩盖；p50/p95 + 掉帧计数才反映观感。
 *
 * 用法（在浏览器上下文里）：
 *   await installFrameSampler(page)            // 注入采样器（页面脚本之前）
 *   await startFrames(page) / stopFrames(page) // 圈定区间
 *   await readFrames(page)                     // 取回统计
 */
export const FRAME_SAMPLER = () => {
  window.__uiPerfFrames = []
  window.__uiPerfRec = false
  let last = 0
  const tick = (t) => {
    if (window.__uiPerfRec) { if (last) window.__uiPerfFrames.push(Math.round(t - last)); last = t }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  window.__uiPerfLongTasks = []
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__uiPerfLongTasks.push(Math.round(e.duration))
    }).observe({ entryTypes: ['longtask'] })
  } catch { /* 老内核无 longtask，忽略 */ }
}

/** 页面脚本执行前注入采样器（每个 context 调一次即可）。 */
export async function installFrameSampler(context) {
  await context.addInitScript(FRAME_SAMPLER)
}

export async function startFrames(page) {
  await page.evaluate(() => { window.__uiPerfFrames = []; window.__uiPerfLongTasks = []; window.__uiPerfRec = true })
}

export async function stopFrames(page) {
  await page.evaluate(() => { window.__uiPerfRec = false })
  return readFrames(page)
}

export async function readFrames(page) {
  const { frames, longTasks } = await page.evaluate(() => ({
    frames: window.__uiPerfFrames || [],
    longTasks: window.__uiPerfLongTasks || [],
  }))
  return summarize(frames, longTasks)
}

/** 帧间隔数组 → 统计量（FPS 用"总时长/帧数"推，避免把停顿算成高帧率）。 */
export function summarize(frames, longTasks = []) {
  if (!frames.length) return { 帧数: 0, FPS: 0, 平均帧ms: 0, p50: 0, p95: 0, 最大: 0, 掉帧_gt33ms: 0, 卡顿_gt50ms: 0, 严重_gt100ms: 0, 长任务数: longTasks.length, 长任务合计ms: longTasks.reduce((a, b) => a + b, 0), 最长任务ms: Math.max(0, ...longTasks) }
  const total = frames.reduce((a, b) => a + b, 0)
  const sorted = [...frames].sort((a, b) => a - b)
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] || 0
  return {
    帧数: frames.length,
    FPS: +(frames.length / Math.max(0.001, total / 1000)).toFixed(1),
    平均帧ms: +(total / frames.length).toFixed(1),
    p50: q(0.5), p95: q(0.95), 最大: sorted[sorted.length - 1],
    掉帧_gt33ms: frames.filter((f) => f > 33).length,
    卡顿_gt50ms: frames.filter((f) => f > 50).length,
    严重_gt100ms: frames.filter((f) => f > 100).length,
    长任务数: longTasks.length,
    长任务合计ms: longTasks.reduce((a, b) => a + b, 0),
    最长任务ms: Math.max(0, ...longTasks),
  }
}

/** 滑动页面（滚轮上下交替），返回过程中的帧统计。 */
export async function scrollAndMeasure(page, { steps = 10, stepPx = 700, pauseMs = 220, x = 760, y = 500 } = {}) {
  await startFrames(page)
  for (let i = 0; i < steps; i++) {
    await page.mouse.move(x, y)
    await page.mouse.wheel(0, i % 2 === 0 ? stepPx : -stepPx)
    await page.waitForTimeout(pauseMs)
  }
  return stopFrames(page)
}

/** 待机测量（不做任何交互，只看持续重绘开销）。 */
export async function idleAndMeasure(page, ms = 3000) {
  await startFrames(page)
  await page.waitForTimeout(ms)
  return stopFrames(page)
}
