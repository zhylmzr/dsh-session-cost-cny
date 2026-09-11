/**
 * 会话话费（人民币）· Host 半边
 *
 * 职责：
 *   1. 抓取并解析 DeepSeek 官网价目表（中文页直接是人民币，英文页为美元价）；
 *   2. 折叠一个会话的日志（`assistant/message` 事件里的 provider 用量），
 *      按**每次调用发生的时间**判定高峰 / 空闲时段后分别计价；
 *      活跃会话走内存（`session.ownEvents()`），非活跃会话走 `sessionQuery.readSession()` 读盘，
 *      所以"刚启动 / 刚切过去、会话还不是活跃会话"时也能算出金额；
 *   3. 通过 webServer 暴露两个只读路由给客户端半边：
 *        GET  /plugins/session-cost-cny/data?sessionId=<id>   → 计价结果 JSON
 *        POST /plugins/session-cost-cny/refresh               → 手动重抓官网价目表
 *
 * 价目表不在每次启动都抓：解析结果会落到本地缓存文件，启动时优先读缓存，
 * 只有缓存不存在（或 `refreshOnStart: true`）才访问官网；点面板里的 ⟳ 会重抓并覆盖缓存。
 *
 * 没有任何包依赖：只用 ctx 上的 sessions / web / webServer 三个服务（外加可选的 sessionQuery），
 * 以及 Node 自带的 fs / os / path（真实插件运行在 Node 进程里）。
 *
 * @module dsh-session-cost-cny
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 官网中文页（人民币价目表）。 */
const PRICING_URL_ZH = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing'
/** 官网英文页（美元价目表），中文页不可用时回退。 */
const PRICING_URL_EN = 'https://api-docs.deepseek.com/quick_start/pricing'
/** 价目来源的展示名。 */
const PRICING_SITE = 'DeepSeek 官网（api-docs.deepseek.com）'
/** 官网英文页为美元价时的默认汇率。 */
const USD_CNY_DEFAULT = 7.1
/**
 * 本插件在 webServer 上占用的路径前缀。
 * 注意：**不能带尾斜杠**。`webServer.match()` 的判定是
 * `pathname === prefix || pathname.startsWith(prefix + '/')`，
 * 若写成 `/plugins/session-cost-cny/`，则 `/plugins/session-cost-cny/data`
 * 既不等前缀、也不以「前缀 + /」开头，会永远落空并落到 SPA fallback（404）。
 */
export const ROUTE_PREFIX = '/plugins/session-cost-cny'

/**
 * 按 `webServer.match()` 的规则判定一个 pathname 是否属于本插件，并取出子路由。
 * 规则：`pathname === prefix || pathname.startsWith(prefix + '/')`。
 * @param pathname - 请求的路径部分（不含 query）。
 * @returns 子路由名（`'data'` / `'refresh'`），不属于本插件或没有子路由时为 `null`。
 */
export function matchRoute(pathname) {
  if (typeof pathname !== 'string') return null
  if (pathname !== ROUTE_PREFIX && !pathname.startsWith(ROUTE_PREFIX + '/')) return null
  const sub = pathname.slice(ROUTE_PREFIX.length).replace(/^\//, '')
  return sub === '' ? null : sub
}

/**
 * 内置快照（2026-09-11 抄自官网中文页），抓取失败时使用。
 * 人民币 / 百万 tokens，空闲 → 高峰。
 */
const SNAPSHOT_ROWS = [
  { model: 'deepseek-flash', hitOff: 0.02, hitPeak: 0.04, missOff: 1, missPeak: 2, outOff: 4, outPeak: 8 },
  { model: 'deepseek-v4-pro', hitOff: 0.15, hitPeak: 0.3, missOff: 4.5, missPeak: 9, outOff: 13.5, outPeak: 27 },
]

/** 官网已下线但仍在用的旧模型名，按官网说明归并到现役模型计费。 */
const MODEL_ALIASES = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  'deepseek-v4.1-flash': 'deepseek-flash',
}

// ───────────────────────────── 纯函数（可单测） ─────────────────────────────

/**
 * 把 HTML 压成便于正则抽取的纯文本。
 * @param input - 原始 HTML 或已经是纯文本的内容。
 * @returns 标签被替换为空格、实体已解码的单行文本。
 */
export function htmlToText(input) {
  let s = typeof input === 'string' ? input : ''
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ')
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')
  s = s.replace(/<br\s*\/?>/gi, ' ')
  s = s.replace(/<\/(td|th|tr|div|p|li|h[1-6]|table|span)>/gi, ' ')
  s = s.replace(/<[^>]*>/g, ' ')
  s = s.replace(/&nbsp;/gi, ' ')
  s = s.replace(/&amp;/gi, '&')
  s = s.replace(/&quot;/gi, '"')
  s = s.replace(/&#x27;|&#39;/gi, "'")
  s = s.replace(/&lt;/gi, '<')
  s = s.replace(/&gt;/gi, '>')
  return s.replace(/[ \t\u00a0]+/g, ' ')
}

/**
 * 多关键词取最靠前的一次出现。
 * @param text - 待搜索文本。
 * @param keys - 候选关键词。
 * @returns 最早出现的下标，都没有时返回 -1。
 */
function firstIndexOf(text, keys) {
  let best = -1
  for (let i = 0; i < keys.length; i += 1) {
    const at = text.indexOf(keys[i])
    if (at < 0) continue
    if (best < 0 || at < best) best = at
  }
  return best
}

/**
 * 解析官网价目表。
 *
 * 结构假设：模型表头单元格紧邻第一处 `BASE URL` 之前，价格区在「缓存命中 / CACHE HIT」
 * 到「并发限制 / Concurrency Limit」之间，按「3 个计费项 × 2 个时段 × N 个模型」的行列顺序排列。
 * 解析结果一律归一成人民币 / 百万 tokens。
 *
 * @param raw - 官网页面内容（HTML 或纯文本均可）。
 * @param usdCny - 美元价换算汇率。
 * @returns `{ rows, currency, url }`，结构不符时返回 `null`。
 */
export function parseOfficialPrices(raw, usdCny = USD_CNY_DEFAULT) {
  const text = htmlToText(raw)
  const baseUrlAt = text.indexOf('BASE URL')
  if (baseUrlAt < 0) return null
  const cellAt = Math.max(text.lastIndexOf('模型', baseUrlAt), text.lastIndexOf('MODEL', baseUrlAt))
  if (cellAt < 0 || baseUrlAt - cellAt > 400) return null
  const header = text.slice(cellAt, baseUrlAt)
  const models = []
  const nameRe = /[a-z][a-z0-9]*(?:[.\-_][a-z0-9]+)*/g
  let hit
  while ((hit = nameRe.exec(header)) !== null) {
    if (hit[0] === 'model') continue
    if (hit[0].length < 3) continue
    if (models.indexOf(hit[0]) >= 0) continue
    models.push(hit[0])
  }
  if (models.length === 0) return null

  const from = firstIndexOf(text, ['缓存命中', 'CACHE HIT'])
  const to = firstIndexOf(text, ['并发限制', 'Concurrency Limit'])
  if (from < 0) return null
  const region = to > from ? text.slice(from, to) : text.slice(from)
  const cny = region.indexOf('元') >= 0
  const values = []
  const numRe = cny ? /([0-9]+(?:\.[0-9]+)?)\s*元/g : /\$([0-9]+(?:\.[0-9]+)?)/g
  let n
  while ((n = numRe.exec(region)) !== null) values.push(+n[1])
  if (values.length !== models.length * 6) return null

  const k = cny ? 1 : usdCny
  const N = models.length
  const rows = []
  for (let i = 0; i < N; i += 1) {
    rows.push({
      model: models[i],
      hitOff: values[i] * k,
      hitPeak: values[N + i] * k,
      missOff: values[2 * N + i] * k,
      missPeak: values[3 * N + i] * k,
      outOff: values[4 * N + i] * k,
      outPeak: values[5 * N + i] * k,
    })
  }
  const sane = rows.length > 0 && rows[0].missOff > 0 && rows[0].outOff > 0
  return sane ? { rows, currency: cny ? 'CNY' : 'USD', url: cny ? PRICING_URL_ZH : PRICING_URL_EN } : null
}

/**
 * 该时刻是否落在官网高峰时段：北京时间（UTC+8）周一至周五 9:00–12:00、14:00–18:00。
 * @param ms - 毫秒时间戳（UTC）。
 * @returns 高峰返回 true；缺失 / 非法时间戳按空闲处理（取较低价，不虚高）。
 */
export function isPeak(ms) {
  const t = typeof ms === 'number' && ms === ms ? ms : 0
  if (t <= 0) return false
  const bj = t + 8 * 3600000
  const days = (bj - (bj % 86400000)) / 86400000
  const dow = (days + 4) % 7
  if (dow < 1 || dow > 5) return false
  const hour = ((bj - (bj % 3600000)) / 3600000) % 24
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}

/** @param value - 任意值。 @returns 有限数字，否则 0。 */
function num(value) {
  return typeof value === 'number' && value === value ? value : 0
}

/** @param value - 任意值。 @returns 去掉首尾空白的规范化 id。 */
function norm(value) {
  return (typeof value === 'string' ? value : '').toLowerCase().replace(/\s+/g, '')
}

/** @param value - 金额。 @returns 保留 6 位小数的金额。 */
function round(value) {
  return typeof value === 'number' && value === value ? +value.toFixed(6) : 0
}

/**
 * 取某条 provider/model 路由的单价（人民币 / 百万 tokens）。
 * 优先级：配置里的 routeOverrides → 官网同名模型 → 官网 flash 行（标记为估算）。
 * @param state - `{ rows, overrides, site }`。
 * @param provider - 路由的 provider 键。
 * @param model - 路由的 model id。
 * @returns 单价与来源描述。
 */
export function resolvePrice(state, provider, model) {
  const route = norm(provider) + '/' + norm(model)
  const overrides = Array.isArray(state.overrides) ? state.overrides : []
  for (let i = 0; i < overrides.length; i += 1) {
    const ov = overrides[i]
    if (norm(ov.route) !== route) continue
    return {
      officialModel: typeof ov.label === 'string' ? ov.label : route,
      src: '自定义渠道价',
      estimated: false,
      missOff: num(ov.miss),
      missPeak: num(ov.missPeak !== undefined ? ov.missPeak : ov.miss),
      hitOff: num(ov.hit),
      hitPeak: num(ov.hitPeak !== undefined ? ov.hitPeak : ov.hit),
      outOff: num(ov.out),
      outPeak: num(ov.outPeak !== undefined ? ov.outPeak : ov.out),
      write: num(ov.write),
    }
  }
  const m = norm(model)
  const alias = MODEL_ALIASES[m] !== undefined ? MODEL_ALIASES[m] : m
  for (let i = 0; i < state.rows.length; i += 1) {
    const row = state.rows[i]
    if (norm(row.model) !== alias) continue
    return {
      officialModel: row.model,
      src: state.site,
      estimated: false,
      missOff: row.missOff, missPeak: row.missPeak,
      hitOff: row.hitOff, hitPeak: row.hitPeak,
      outOff: row.outOff, outPeak: row.outPeak,
      write: 0,
    }
  }
  const fallback = state.rows[0]
  return {
    officialModel: fallback.model,
    src: state.site + ' · 估算',
    estimated: true,
    missOff: fallback.missOff, missPeak: fallback.missPeak,
    hitOff: fallback.hitOff, hitPeak: fallback.hitPeak,
    outOff: fallback.outOff, outPeak: fallback.outPeak,
    write: 0,
  }
}

/**
 * 该路由是否属于 DeepSeek 系列。只看 provider / model 两个字符串：
 * model 里含 `deepseek`（覆盖官方 `deepseek-flash`，以及第三方
 * `Pro/deepseek-ai/DeepSeek-V3.1`、`~deepseek/deepseek-v4-flash-latest` 这类 id），
 * 或 provider 本身就叫 `deepseek`。
 *
 * 插件只对 DeepSeek 系列展示话费：其他模型没有可信单价，算出来只会误导。
 * @param provider - 路由的 provider 键。
 * @param model - 路由的 model id。
 * @returns 属于 DeepSeek 系列返回 true。
 */
export function isDeepseekRoute(provider, model) {
  return norm(provider) === 'deepseek' || norm(model).indexOf('deepseek') >= 0
}

/**
 * 把一串会话事件折叠成话费汇总：只统计 `assistant/message` 携带的 provider 用量，
 * 并且**只计价 DeepSeek 系列**（非 DeepSeek 路由计入 `other` 但不计费 ——
 * 它们没有可信单价，混进来只会让总额失真）。
 * @param events - 会话自己的事件（`session.ownEvents()`）。
 * @param state - `{ rows, overrides, site, usdCny }`。
 * @returns 全局汇总 + 按路由分组的明细 + 最近一次调用所用的路由（`current`）。
 */
export function foldEvents(events, state) {
  const usdCny = num(state.usdCny) > 0 ? num(state.usdCny) : USD_CNY_DEFAULT
  const byKey = {}
  const order = []
  const rates = {}
  const tokens = { miss: 0, hit: 0, write: 0, out: 0, reasoning: 0, total: 0 }
  const cost = { in: 0, hit: 0, out: 0, write: 0, cny: 0 }
  let calls = 0
  let skipped = 0
  let peakCalls = 0
  let offCalls = 0
  let estimated = false
  const providers = []
  // 非 DeepSeek 路由的用量：只统计 token（面板要展示一条"其他模型"），不计价。
  const other = { calls: 0, miss: 0, hit: 0, write: 0, out: 0, reasoning: 0, total: 0 }

  const list = Array.isArray(events) ? events : []
  for (let i = 0; i < list.length; i += 1) {
    const event = list[i]
    if (event === null || typeof event !== 'object' || event.type !== 'assistant/message') continue
    const data = event.data
    if (data === null || typeof data !== 'object') continue
    const usage = data.usage
    if (usage === null || typeof usage !== 'object') {
      skipped += 1
      continue
    }
    const message = data.message
    const source = message !== null && typeof message === 'object' ? message.source : null
    const provider = source !== null && typeof source === 'object' && typeof source.provider === 'string' ? source.provider : '未知'
    const model = source !== null && typeof source === 'object' && typeof source.model === 'string' ? source.model : '未知'
    const miss = num(usage.inputTokens)
    const hit = num(usage.cacheReadTokens)
    const write = num(usage.cacheWriteTokens)
    const out = num(usage.outputTokens)
    const reasoning = num(usage.reasoningTokens)

    // 只计价 DeepSeek 系列：其它模型没有可信单价，混进来只会让总额失真。
    // 但它们的 token 仍然要累计，供面板里那条"其他模型（金额未知）"展示。
    if (!isDeepseekRoute(provider, model)) {
      other.calls += 1
      other.miss += miss
      other.hit += hit
      other.write += write
      other.out += out
      other.reasoning += reasoning
      other.total += miss + hit + write + out
      continue
    }
    const key = provider + '/' + model

    let entry = byKey[key]
    if (entry === undefined) {
      const row = resolvePrice(state, provider, model)
      rates[key] = row
      entry = {
        provider, model, officialModel: row.officialModel, src: row.src, estimated: row.estimated,
        calls: 0, peakCalls: 0, offCalls: 0, miss: 0, hit: 0, write: 0, out: 0, reasoning: 0,
        costIn: 0, costHit: 0, costOut: 0, costWrite: 0, costPeak: 0, costOff: 0, total: 0,
      }
      byKey[key] = entry
      order.push(key)
      if (row.estimated) estimated = true
      if (providers.indexOf(provider) < 0) providers.push(provider)
    }

    const row = rates[key]
    const peak = isPeak(num(event.time))
    const costIn = miss / 1000000 * (peak ? row.missPeak : row.missOff)
    const costHit = hit / 1000000 * (peak ? row.hitPeak : row.hitOff)
    const costOut = out / 1000000 * (peak ? row.outPeak : row.outOff)
    const costWrite = write / 1000000 * row.write
    const spent = costIn + costHit + costOut + costWrite

    entry.calls += 1
    if (peak) { entry.peakCalls += 1; peakCalls += 1; entry.costPeak += spent } else { entry.offCalls += 1; offCalls += 1; entry.costOff += spent }
    entry.miss += miss
    entry.hit += hit
    entry.write += write
    entry.out += out
    entry.reasoning += reasoning
    entry.costIn += costIn
    entry.costHit += costHit
    entry.costOut += costOut
    entry.costWrite += costWrite
    entry.total += spent

    tokens.miss += miss
    tokens.hit += hit
    tokens.write += write
    tokens.out += out
    tokens.reasoning += reasoning
    cost.in += costIn
    cost.hit += costHit
    cost.out += costOut
    cost.write += costWrite
    cost.cny += spent
    calls += 1
  }

  const routes = []
  for (let i = 0; i < order.length; i += 1) {
    const key = order[i]
    const e = byKey[key]
    const row = rates[key]
    routes.push({
      provider: e.provider,
      model: e.model,
      officialModel: e.officialModel,
      src: e.src,
      estimated: e.estimated,
      calls: e.calls,
      peakCalls: e.peakCalls,
      offCalls: e.offCalls,
      tokens: { miss: e.miss, hit: e.hit, write: e.write, out: e.out, reasoning: e.reasoning, total: e.miss + e.hit + e.write + e.out },
      cost: {
        in: round(e.costIn), hit: round(e.costHit), out: round(e.costOut), write: round(e.costWrite),
        peak: round(e.costPeak), off: round(e.costOff),
        cny: round(e.total), usd: round(e.total / usdCny),
      },
      rates: {
        missOff: round(row.missOff), missPeak: round(row.missPeak),
        hitOff: round(row.hitOff), hitPeak: round(row.hitPeak),
        outOff: round(row.outOff), outPeak: round(row.outPeak),
      },
    })
  }
  routes.sort(function (a, b) { return b.cost.cny - a.cost.cny })

  tokens.total = tokens.miss + tokens.hit + tokens.write + tokens.out
  const billedInput = tokens.miss + tokens.hit

  return {
    calls,
    skipped,
    other,
    peakCalls,
    offCalls,
    estimated,
    providers,
    cacheHitRate: billedInput > 0 ? tokens.hit / billedInput : 0,
    tokens,
    cost: {
      cny: round(cost.cny),
      usd: round(cost.cny / usdCny),
      in: round(cost.in),
      hit: round(cost.hit),
      out: round(cost.out),
      write: round(cost.write),
    },
    routes,
  }
}

// ───────────────────────────────── 插件 ─────────────────────────────────

/* ------------------------------------------------------------------ *
 * 价目表本地缓存
 * ------------------------------------------------------------------ */

/** 缓存文件格式版本；结构变了就整体作废，重新抓一次。 */
const CACHE_VERSION = 1

/**
 * 缓存文件路径：`<DSH_HOME>/plugin-data/dsh-session-cost-cny/pricing.json`。
 * DSH_HOME 缺失时退回 `~/.dsh`。
 */
export function cachePath() {
  const env = typeof process === 'object' && process !== null && typeof process.env === 'object' && process.env !== null ? process.env : {}
  const home = typeof env.DSH_HOME === 'string' && env.DSH_HOME !== '' ? env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'plugin-data', 'dsh-session-cost-cny', 'pricing.json')
}

/** 缓存里的六档单价字段名。 */
const CACHE_RATE_KEYS = ['hitOff', 'hitPeak', 'missOff', 'missPeak', 'outOff', 'outPeak']

/**
 * 校验并归一化缓存里的价目行：任何一行不合法就整体作废（宁可重抓）。
 * @param rows - 缓存文件里的 `rows` 字段。
 * @returns 归一化后的行数组；不合法时返回 null。
 */
export function normalizeCachedRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null
  const out = []
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]
    if (row === null || typeof row !== 'object') return null
    if (typeof row.model !== 'string' || row.model === '') return null
    const next = { model: row.model }
    for (let k = 0; k < CACHE_RATE_KEYS.length; k += 1) {
      const key = CACHE_RATE_KEYS[k]
      const value = row[key]
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
      next[key] = value
    }
    out.push(next)
  }
  return out
}

/** 把时间戳格式化成 `YYYY-MM-DD HH:mm`（本地时区），给标签和日志用。 */
export function formatStamp(ts) {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return '未知时间'
  const date = new Date(ts)
  const pad = function (n) {
    return n < 10 ? '0' + n : String(n)
  }
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
}

/**
 * 读取本地缓存。文件不存在、JSON 损坏、版本不符、行不合法都返回 null。
 * @param usdCny - 当前配置的美元汇率；英文页折算出的人民币价会随汇率变化，对不上就作废。
 * @returns `{ url, currency, fetchedAt, rows }` 或 null。
 */
export async function readCache(usdCny) {
  try {
    const raw = JSON.parse(await readFile(cachePath(), 'utf8'))
    if (raw === null || typeof raw !== 'object') return null
    if (raw.version !== CACHE_VERSION) return null
    const rows = normalizeCachedRows(raw.rows)
    if (rows === null) return null
    const currency = typeof raw.currency === 'string' && raw.currency !== '' ? raw.currency : 'CNY'
    const rate = typeof raw.usdCny === 'number' && Number.isFinite(raw.usdCny) ? raw.usdCny : null
    if (currency !== 'CNY' && rate !== usdCny) return null
    return {
      url: typeof raw.url === 'string' && raw.url !== '' ? raw.url : PRICING_URL_ZH,
      currency,
      fetchedAt: typeof raw.fetchedAt === 'number' && Number.isFinite(raw.fetchedAt) ? raw.fetchedAt : 0,
      rows,
    }
  } catch (error) {
    return null
  }
}

/**
 * 写本地缓存。失败只影响下次启动会不会重新抓，不影响本次计价，因此不抛错。
 * @returns 是否写入成功。
 */
export async function writeCache(snapshot) {
  try {
    const file = cachePath()
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify({ version: CACHE_VERSION, ...snapshot }), 'utf8')
    return true
  } catch (error) {
    return false
  }
}

/** 需要 webServer 才能把数据交给客户端半边。 */
export const inject = ['webServer']

/**
 * 装载插件。
 * @param ctx - Cordis 上下文。
 * @param config - 可选配置：`{ usdCny?, refreshOnStart?, routeOverrides? }`。
 */
export function apply(ctx, config) {
  const cfg = config !== null && typeof config === 'object' ? config : {}
  const usdCny = typeof cfg.usdCny === 'number' && cfg.usdCny > 0 ? cfg.usdCny : USD_CNY_DEFAULT
  const overrides = Array.isArray(cfg.routeOverrides) ? cfg.routeOverrides : []
  // 默认 false：启动时先读本地缓存，只有没缓存才抓官网；显式 true 才是每次启动都重抓。
  const refreshOnStart = cfg.refreshOnStart === true

  let official = {
    kind: 'snapshot',
    label: '内置快照 · 2026-09-11',
    url: PRICING_URL_ZH,
    currency: 'CNY',
    fetchedAt: 0,
    rows: SNAPSHOT_ROWS,
  }
  let priceGen = 0
  let warned = false
  // 折叠结果缓存：会话序号 + 价目表版本不变就不重算。
  let cacheKey = ''
  let cacheValue = null

  /** 计价上下文：折叠与会话无关，只依赖价目表状态。 */
  function state() {
    return { rows: official.rows, overrides, site: PRICING_SITE, usdCny }
  }

  /** 客户端的 source 字段。 */
  function sourceInfo() {
    const models = []
    for (let i = 0; i < official.rows.length; i += 1) models.push(official.rows[i].model)
    return {
      kind: official.kind,
      site: PRICING_SITE,
      label: official.label,
      url: official.url,
      currency: official.currency,
      fetchedAt: official.fetchedAt,
      ageMs: official.fetchedAt > 0 ? Date.now() - official.fetchedAt : 0,
      models,
    }
  }

  /**
   * 采用一份价目表（官网实时 / 本地缓存 / 内置快照）并让折叠缓存失效。
   * @param next - 完整价目表状态。
   */
  function adopt(next) {
    official = next
    priceGen += 1
    cacheKey = ''
  }

  /**
   * 拉取一次官网价目表；这是本插件唯一的网络请求入口，成功后覆盖本地缓存。
   * @returns `{ ok: true, ... }` 或 `{ ok: false, reason }`。
   */
  async function refresh() {
    const web = ctx.get('web')
    if (web === undefined || web === null || typeof web.fetch !== 'function') {
      return { ok: false, reason: 'web-unavailable' }
    }
    const urls = [PRICING_URL_ZH, PRICING_URL_EN]
    let reason = 'fetch-failed'
    for (let i = 0; i < urls.length; i += 1) {
      try {
        const res = await web.fetch({ url: urls[i] })
        const body = res !== null && typeof res === 'object' ? res.body : null
        const content = body !== null && typeof body === 'object' && typeof body.content === 'string' ? body.content : ''
        if (content === '') {
          reason = 'empty-body'
          continue
        }
        const parsed = parseOfficialPrices(content, usdCny)
        if (parsed === null || parsed.rows.length === 0) {
          reason = 'parse-failed'
          continue
        }
        const fetchedAt = Date.now()
        adopt({
          kind: 'live',
          label: '官网实时 · ' + formatStamp(fetchedAt),
          url: parsed.url,
          currency: parsed.currency,
          fetchedAt,
          rows: parsed.rows,
        })
        const cached = await writeCache({
          url: parsed.url,
          currency: parsed.currency,
          fetchedAt,
          rows: parsed.rows,
          usdCny,
        })
        return {
          ok: true,
          kind: 'live',
          currency: parsed.currency,
          models: parsed.rows.length,
          url: parsed.url,
          fetchedAt,
          cached,
        }
      } catch (error) {
        reason = error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : 'fetch-failed'
        if (!warned) {
          warned = true
          console.log('[session-cost-cny] 官网价目拉取失败，继续用当前价目表（本地缓存或内置快照）：' + reason)
        }
      }
    }
    return { ok: false, reason }
  }

  /**
   * 取一个会话「自己的」事件，活跃会话优先，其次读持久化日志。
   *
   * 为什么不能只认 `sessions.get()`：dsh 启动后或刚切到某个历史会话时，那个会话可能
   * 还不是内存里的活跃会话（GUI 展示的是磁盘上的日志），此时 `sessions.get()` 会落空，
   * 界面上就会"切换几次才显示金额"。`sessionQuery.readSession()` 是 live-preferred 的
   * 读取入口：活跃会话走内存，非活跃会话读盘并做重放校验，且**不会**把会话变成活跃。
   *
   * @param sessionId - 会话 id。
   * @returns `{ events, seq, source }` 或 `{ error }`。
   */
  async function readOwnEvents(sessionId) {
    const sessions = ctx.get('sessions')
    if (sessions !== undefined && sessions !== null && typeof sessions.get === 'function') {
      const live = sessions.get(sessionId)
      if (live !== undefined && live !== null) {
        let events = null
        if (typeof live.ownEvents === 'function') events = live.ownEvents()
        else if (typeof live.snapshotEvents === 'function') events = live.snapshotEvents()
        if (events !== null && events !== undefined) {
          return { events, seq: typeof live.seq === 'number' ? live.seq : events.length, source: 'live' }
        }
      }
    }
    const query = ctx.get('sessionQuery')
    if (query === undefined || query === null || typeof query.readSession !== 'function') {
      return { error: 'session-not-live' }
    }
    let snapshot = null
    try {
      snapshot = await query.readSession(sessionId)
    } catch (error) {
      return { error: 'session-read-failed' }
    }
    if (snapshot === null || snapshot === undefined || !Array.isArray(snapshot.events)) {
      return { error: 'session-read-failed' }
    }
    // 与 ownEvents() 完全对齐：它就是 snapshotEvents(inheritedEventCount)，
    // 即"砍掉 fork / 恢复继承来的前缀"，避免把父会话的用量重复计一遍。
    const skip = typeof snapshot.inheritedEventCount === 'number' && snapshot.inheritedEventCount > 0
      ? snapshot.inheritedEventCount
      : 0
    const events = skip > 0 ? snapshot.events.slice(skip) : snapshot.events
    const last = events.length > 0 ? events[events.length - 1] : null
    const seq = last !== null && last !== undefined && typeof last.seq === 'number' ? last.seq : events.length
    return { events, seq, source: 'persisted' }
  }

  /** 组装给客户端的一份完整响应。 */
  async function payload(sessionId) {
    const read = await readOwnEvents(sessionId)
    if (read.error !== undefined) return { ok: false, reason: read.error }
    const events = read.events
    const key = sessionId + '#' + read.source + '#' + read.seq + '@' + priceGen + '@' + official.fetchedAt
    let folded = cacheValue
    if (folded === null || cacheKey !== key) {
      folded = foldEvents(events, state())
      cacheKey = key
      cacheValue = folded
    }
    const thirdParty = []
    for (let i = 0; i < folded.providers.length; i += 1) {
      if (folded.providers[i] !== 'deepseek') thirdParty.push(folded.providers[i])
    }
    return {
      ok: true,
      // 客户端据此决定显不显示：只要这个会话用过 DeepSeek 系列（calls > 0）就展示；
      // 全程没用过 DeepSeek 的会话没有任何可算的花费，整枚胶囊不渲染。
      hasDeepseek: folded.calls > 0,
      calls: folded.calls,
      skipped: folded.skipped,
      estimated: folded.estimated,
      peakCalls: folded.peakCalls,
      offCalls: folded.offCalls,
      cacheHitRate: folded.cacheHitRate,
      tokens: folded.tokens,
      cost: folded.cost,
      routes: folded.routes,
      // 非 DeepSeek 路由的 token 用量（面板里展示"其他模型 … 金额未知"）。
      other: folded.other,
      usdCny,
      tierNow: isPeak(Date.now()) ? 'peak' : 'offpeak',
      source: sourceInfo(),
      caveat: thirdParty.length > 0 && folded.calls > 0
        ? '当前路由由 ' + thirdParty.join('、') + ' 提供，金额按 DeepSeek 官网价目估算，实际账单以该渠道为准'
        : '',
    }
  }

  /** 两个只读路由的处理器。 */
  async function handle(req, res) {
    const url = new URL(typeof req.url === 'string' ? req.url : '/', 'http://localhost')
    // 用与 webServer.match() 同一套规则取子路由；不属于本插件则落到下面的 404。
    const sub = matchRoute(url.pathname)
    const json = function (status, body) {
      const text = JSON.stringify(body)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(text),
      })
      res.end(text)
    }
    if (sub === 'refresh') {
      if (req.method !== 'POST') {
        json(405, { ok: false, reason: 'method-not-allowed' })
        return
      }
      json(200, await refresh())
      return
    }
    if (sub === 'data') {
      if (req.method !== 'GET') {
        json(405, { ok: false, reason: 'method-not-allowed' })
        return
      }
      const sessionId = url.searchParams.get('sessionId')
      if (typeof sessionId !== 'string' || sessionId === '') {
        json(400, { ok: false, reason: 'no-session-id' })
        return
      }
      json(200, await payload(sessionId))
      return
    }
    json(404, { ok: false, reason: 'unknown-route' })
  }

  ctx.effect(function () {
    return ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: handle })
  })

  /**
   * 采用一份本地缓存价目表。
   * @param cached - `readCache()` 的返回值。
   */
  function adoptCache(cached) {
    adopt({
      kind: 'cache',
      label: '本地缓存 · ' + formatStamp(cached.fetchedAt),
      url: cached.url,
      currency: cached.currency,
      fetchedAt: cached.fetchedAt,
      rows: cached.rows,
    })
  }

  /**
   * 启动流程：默认先读本地缓存，没有缓存（或显式 refreshOnStart: true）才抓官网；
   * 抓不到就退回旧缓存，再不行才用内置快照，全程不阻塞激活、不抛错。
   */
  async function boot() {
    const cached = refreshOnStart ? null : await readCache(usdCny)
    if (cached !== null) {
      adoptCache(cached)
      console.log('[session-cost-cny] 价目表取自本地缓存（' + formatStamp(cached.fetchedAt) + '），点 ⟳ 可重新抓取。')
      return
    }
    const result = await refresh()
    if (result.ok === true) return
    // 抓不到时，旧缓存也比内置快照准（refreshOnStart 模式下才会走到这里还有缓存）。
    if (refreshOnStart) {
      const fallback = await readCache(usdCny)
      if (fallback !== null) {
        adoptCache(fallback)
        console.log('[session-cost-cny] 强制重抓失败（' + result.reason + '），退回本地缓存（' + formatStamp(fallback.fetchedAt) + '）。')
        return
      }
    }
    console.log('[session-cost-cny] 尚无本地缓存且官网拉取失败（' + result.reason + '），本次使用内置快照。')
  }

  boot().catch(function (error) {
    const message = error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error)
    console.log('[session-cost-cny] 价目表初始化异常：' + message)
  })
}
