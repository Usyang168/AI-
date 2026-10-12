/**
 * 参数解析：命令行 > 环境变量 > 默认值。零依赖、跨平台（纯 Node，不依赖 shell）。
 *
 * 约定（避免脚本写死任何路径/端口/账号）：
 *   --url <完整地址>            直接指定 DSH 页面地址（含 token 时优先用它）
 *   --port <端口>               只给端口（缺省取 DSH_PAGE_PORT，再自动从实例日志探测；不预设任何端口）
 *   --token <令牌>              缺省时按 env → 实例日志 顺序自探测（见 lib/env.mjs）
 *   --plugin <插件名>           插件包名（默认 dsh-our-free-model）
 *   --label <设置入口文本>      默认中英双语正则；多语言界面下用它对上入口
 *   --scenario <场景>           见 ui-perf.mjs（可逗号分隔多个）
 *   --out <目录>                报告/截图输出目录（默认 ./test/ui-perf/out）
 *   --idle <毫秒>               待机采样时长（默认 3000）
 *   --steps <次数>              滑动步数（默认 10）
 *   --strict                    阈值不达标时退出码 2（CI 用）
 *   --json                      只输出 JSON（便于管道）
 */
import { fileURLToPath } from 'node:url'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { resolvePort } from './env.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PKG_ROOT = resolve(HERE, '..', '..') // test/ui-perf/lib → 插件根

/** 解析 argv（支持 `--k v` 与 `--flag` 两种形态）。 */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { out._.push(a); continue }
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else { out[key] = next; i++ }
  }
  return out
}

const envFirst = (...names) => names.map((n) => process.env[n]).find((v) => typeof v === 'string' && v !== '')

/** 归一化成一份带默认值的配置。 */
export function resolveConfig(args = {}) {
  const outDir = args.out || envFirst('DSH_PAGE_OUT') || join(PKG_ROOT, 'test', 'ui-perf', 'out')
  return {
    url: args.url || envFirst('DSH_PAGE_URL') || '',
    port: resolvePort(args.port),
    token: args.token || envFirst('DSH_PAGE_TOKEN') || '',
    plugin: args.plugin || envFirst('DSH_PAGE_PLUGIN') || 'dsh-our-free-model',
    label: args.label || envFirst('DSH_PAGE_LABEL') || 'Our Free Model|免费模型',
    settingsLabel: args['settings-label'] || envFirst('DSH_PAGE_SETTINGS_LABEL') || 'Settings|设置',
    scenarios: String(args.scenario || 'open,idle,scroll').split(',').map((s) => s.trim()).filter(Boolean),
    out: isAbsolute(outDir) ? outDir : resolve(process.cwd(), outDir),
    idleMs: Number(args.idle || envFirst('DSH_PAGE_IDLE_MS') || 3000),
    steps: Number(args.steps || envFirst('DSH_PAGE_STEPS') || 10),
    strict: args.strict === true || args.strict === 'true',
    jsonOnly: args.json === true || args.json === 'true',
    keepOpen: args['keep-open'] === true,
    headless: args.headless !== 'false',
  }
}
