// dsh-session-cost-cny 的纯函数测试：价目表解析、峰谷判定、折叠计价。
// 只测纯函数，不依赖 Cordis 上下文，也不发网络请求。
// 运行：npm test（prepublishOnly 也会跑）
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  parseOfficialPrices,
  isPeak,
  resolvePrice,
  foldEvents,
  htmlToText,
  matchRoute,
  ROUTE_PREFIX,
  isDeepseekRoute,
  normalizeCachedRows,
  formatStamp,
  cachePath,
  readCache,
  writeCache,
  apply,
} from '../lib/index.js'

let passed = 0
// 用例输出的固定出口：插件会把启动日志打到 console.log，某些段落需要临时接管它。
const emit = console.log.bind(console)
/** @param name - 用例名。 @param fn - 断言体。 */
function check(name, fn) {
  fn()
  passed += 1
  emit('  \u2713 ' + name)
}

/** 异步用例：必须 await，否则断言失败会变成未处理的 rejection。 */
async function checkAsync(name, fn) {
  await fn()
  passed += 1
  emit('  \u2713 ' + name)
}

// 缓存用例写在临时目录里，绝不碰真实 DSH_HOME。
const envBefore = process.env.DSH_HOME
const tmp = await mkdtemp(path.join(tmpdir(), 'dshc-cache-'))

// ───────────────────────── 夹具：模拟官网页面结构 ─────────────────────────

const ZH_PAGE = `<table>
<tr><td>模型</td><td>deepseek-flash<sup>(1)</sup></td><td>deepseek-v4-pro<sup>(2)</sup></td></tr>
<tr><td>BASE URL (OpenAI 格式)</td><td>https://api.deepseek.com</td></tr>
<tr><td>价格(3)</td><td>百万tokens输入<br>（缓存命中）</td><td>空闲时段</td><td>0.02元</td><td>0.15元</td></tr>
<tr><td>高峰时段</td><td>0.04元</td><td>0.30元</td></tr>
<tr><td>百万tokens输入<br>（缓存未命中）</td><td>空闲时段</td><td>1元</td><td>4.5元</td></tr>
<tr><td>高峰时段</td><td>2元</td><td>9.0元</td></tr>
<tr><td>百万tokens输出</td><td>空闲时段</td><td>4元</td><td>13.5元</td></tr>
<tr><td>高峰时段</td><td>8元</td><td>27.0元</td></tr>
<tr><td>并发限制(4)</td><td>2500</td><td>500</td></tr>
</table>`

const EN_PAGE = `<table>
<tr><td>MODEL</td><td>deepseek-flash(1)</td><td>deepseek-v4-pro(2)</td></tr>
<tr><td>BASE URL (OpenAI Format)</td><td>https://api.deepseek.com</td></tr>
<tr><td>PRICING(3)</td><td>1M INPUT TOKENS (CACHE HIT)</td><td>OFF-PEAK</td><td>$0.003</td><td>$0.022</td></tr>
<tr><td>PEAK</td><td>$0.006</td><td>$0.044</td></tr>
<tr><td>1M INPUT TOKENS (CACHE MISS)</td><td>OFF-PEAK</td><td>$0.15</td><td>$0.66</td></tr>
<tr><td>PEAK</td><td>$0.3</td><td>$1.32</td></tr>
<tr><td>1M OUTPUT TOKENS</td><td>OFF-PEAK</td><td>$0.6</td><td>$1.98</td></tr>
<tr><td>PEAK</td><td>$1.2</td><td>$3.96</td></tr>
<tr><td>Concurrency Limit(4)</td><td>2500</td><td>500</td></tr>
</table>`

console.log('htmlToText / parseOfficialPrices')

check('HTML 标签被压成文本', () => {
  const text = htmlToText('<td>a</td><td>0.02元</td>')
  assert.equal(text.trim(), 'a 0.02元')
})

check('中文页解析出人民币价目表', () => {
  const parsed = parseOfficialPrices(ZH_PAGE)
  assert.ok(parsed, '解析失败')
  assert.equal(parsed.currency, 'CNY')
  assert.equal(parsed.rows.length, 2)
  const flash = parsed.rows[0]
  assert.deepEqual(
    [flash.model, flash.hitOff, flash.hitPeak, flash.missOff, flash.missPeak, flash.outOff, flash.outPeak],
    ['deepseek-flash', 0.02, 0.04, 1, 2, 4, 8],
  )
  const pro = parsed.rows[1]
  assert.deepEqual(
    [pro.model, pro.hitOff, pro.hitPeak, pro.missOff, pro.missPeak, pro.outOff, pro.outPeak],
    ['deepseek-v4-pro', 0.15, 0.3, 4.5, 9, 13.5, 27],
  )
})

check('英文页解析出美元价目表并按汇率归一', () => {
  const parsed = parseOfficialPrices(EN_PAGE, 7.1)
  assert.ok(parsed, '解析失败')
  assert.equal(parsed.currency, 'USD')
  assert.equal(parsed.rows[0].missOff, 0.15 * 7.1)
  assert.equal(parsed.rows[0].outPeak, 1.2 * 7.1)
  assert.equal(parsed.rows[1].missPeak, 1.32 * 7.1)
})

check('结构不符时返回 null 而不是抛错', () => {
  assert.equal(parseOfficialPrices('<html><body>hello</body></html>'), null)
  assert.equal(parseOfficialPrices(''), null)
  assert.equal(parseOfficialPrices(undefined), null)
})

console.log('isPeak（北京时间 周一至周五 9:00-12:00、14:00-18:00）')

// 2026-01-01 是周四，因此 2026-01-05 是周一、2026-01-10 是周六。
const utc = (y, m, d, h, min) => Date.UTC(y, m - 1, d, h, min)

check('周一北京 10:00 → 高峰', () => {
  assert.equal(isPeak(utc(2026, 1, 5, 2, 0)), true)
})
check('周一北京 13:00 → 空闲（午间空档）', () => {
  assert.equal(isPeak(utc(2026, 1, 5, 5, 0)), false)
})
check('周一北京 15:00 → 高峰', () => {
  assert.equal(isPeak(utc(2026, 1, 5, 7, 0)), true)
})
check('周一北京 08:59 → 空闲', () => {
  assert.equal(isPeak(utc(2026, 1, 5, 0, 59)), false)
})
check('周一北京 12:00 → 空闲（区间右开）', () => {
  assert.equal(isPeak(utc(2026, 1, 5, 4, 0)), false)
})
check('周一北京 18:00 → 空闲（区间右开）', () => {
  assert.equal(isPeak(utc(2026, 1, 5, 10, 0)), false)
})
check('周六北京 10:00 → 空闲', () => {
  assert.equal(isPeak(utc(2026, 1, 10, 2, 0)), false)
})
check('缺失时间戳按空闲处理', () => {
  assert.equal(isPeak(0), false)
  assert.equal(isPeak(undefined), false)
})

console.log('resolvePrice / foldEvents')

const zhRows = parseOfficialPrices(ZH_PAGE).rows
const state = { rows: zhRows, overrides: [], site: 'test', usdCny: 7.1 }

check('命中官网现役模型名', () => {
  const price = resolvePrice(state, 'opencode-go', 'deepseek-flash')
  assert.equal(price.estimated, false)
  assert.equal(price.officialModel, 'deepseek-flash')
  assert.equal(price.missPeak, 2)
})

check('已下线的旧模型名归并到 flash', () => {
  const price = resolvePrice(state, 'opencode-go', 'deepseek-v4-flash')
  assert.equal(price.officialModel, 'deepseek-flash')
  assert.equal(price.estimated, false)
})

check('未收录模型退回 flash 行并标记估算', () => {
  const price = resolvePrice(state, 'openai', 'gpt-4o')
  assert.equal(price.estimated, true)
  assert.equal(price.officialModel, 'deepseek-flash')
})

check('routeOverrides 优先级高于官网', () => {
  const withOverride = {
    rows: zhRows,
    usdCny: 7.1,
    site: 'test',
    overrides: [{ route: 'opencode-go/deepseek-flash', label: 'opencode-go', miss: 3, hit: 0.1, out: 9, write: 0 }],
  }
  const price = resolvePrice(withOverride, 'opencode-go', 'deepseek-flash')
  assert.equal(price.src, '自定义渠道价')
  assert.equal(price.missOff, 3)
  assert.equal(price.missPeak, 3)
  assert.equal(price.outOff, 9)
})

/** @param ms - 事件时间。 @param usage - 用量桶。 @returns 一条 assistant/message 事件。 */
function assistantEvent(ms, usage) {
  return {
    type: 'assistant/message',
    time: ms,
    data: { message: { source: { provider: 'opencode-go', model: 'deepseek-flash' } }, usage },
  }
}

check('按调用时刻分别计价：高峰输入 + 空闲输出', () => {
  const events = [
    assistantEvent(utc(2026, 1, 5, 2, 0), { inputTokens: 1000000, outputTokens: 0 }), // 高峰 ¥2/M
    assistantEvent(utc(2026, 1, 5, 12, 0), { inputTokens: 0, outputTokens: 1000000 }), // 空闲 ¥4/M
  ]
  const folded = foldEvents(events, state)
  assert.equal(folded.calls, 2)
  assert.equal(folded.peakCalls, 1)
  assert.equal(folded.offCalls, 1)
  assert.equal(folded.tokens.miss, 1000000)
  assert.equal(folded.tokens.out, 1000000)
  assert.equal(folded.cost.in, 2)
  assert.equal(folded.cost.out, 4)
  assert.equal(folded.cost.cny, 6)
  assert.equal(folded.routes.length, 1)
  assert.equal(folded.routes[0].cost.peak, 2)
  assert.equal(folded.routes[0].cost.off, 4)
})

check('缓存命中与未命中分别按各自单价计费', () => {
  const events = [
    assistantEvent(utc(2026, 1, 5, 12, 0), { inputTokens: 1000000, cacheReadTokens: 1000000, outputTokens: 0 }),
  ]
  const folded = foldEvents(events, state)
  assert.equal(folded.cost.in, 1) // 未命中 空闲 ¥1/M
  assert.equal(folded.cost.hit, 0.02) // 命中 空闲 ¥0.02/M
  assert.equal(folded.cacheHitRate, 0.5)
})

check('多路由分别计价并按花费排序', () => {
  const events = [
    assistantEvent(utc(2026, 1, 5, 12, 0), { inputTokens: 0, outputTokens: 1000000 }),
    {
      type: 'assistant/message',
      time: utc(2026, 1, 5, 12, 0),
      data: { message: { source: { provider: 'deepseek', model: 'deepseek-v4-pro' } }, usage: { inputTokens: 0, outputTokens: 1000000 } },
    },
  ]
  const folded = foldEvents(events, state)
  assert.equal(folded.routes.length, 2)
  assert.equal(folded.routes[0].model, 'deepseek-v4-pro') // ¥13.5/M 更高，排前面
  assert.equal(folded.routes[1].model, 'deepseek-flash')
  assert.equal(folded.cost.cny, 4 + 13.5)
})

check('无用量的事件只计入 skipped，不计费', () => {
  const events = [{ type: 'assistant/message', time: utc(2026, 1, 5, 12, 0), data: { message: {} } }]
  const folded = foldEvents(events, state)
  assert.equal(folded.calls, 0)
  assert.equal(folded.skipped, 1)
  assert.equal(folded.cost.cny, 0)
})

check('非 assistant/message 事件被忽略', () => {
  const folded = foldEvents([{ type: 'tool/call', data: {} }, { type: 'user/message', data: {} }], state)
  assert.equal(folded.calls, 0)
  assert.equal(folded.skipped, 0)
})

check('非 DeepSeek 路由只累计 token，不计价', () => {
  const events = [
    assistantEvent(utc(2026, 1, 5, 12, 0), { inputTokens: 0, outputTokens: 1000000 }),
    {
      type: 'assistant/message',
      time: utc(2026, 1, 5, 12, 0),
      data: {
        message: { source: { provider: 'anthropic', model: 'claude-sonnet-4' } },
        usage: { inputTokens: 100, outputTokens: 9999999, cacheReadTokens: 200 },
      },
    },
  ]
  const folded = foldEvents(events, state)
  assert.equal(folded.calls, 1)
  assert.equal(folded.cost.cny, 4) // 只算 DeepSeek 那条（空闲输出 ¥4/M）
  assert.equal(folded.routes.length, 1)
  assert.equal(folded.routes[0].model, 'deepseek-flash')
  // 非 DeepSeek 的 token 单独累计，供面板"其他模型 … 金额未知"那一行展示
  assert.equal(folded.other.calls, 1)
  assert.equal(folded.other.miss, 100)
  assert.equal(folded.other.hit, 200)
  assert.equal(folded.other.out, 9999999)
  assert.equal(folded.other.total, 100 + 200 + 9999999)
})

check('空会话返回全零而不是抛错', () => {
  const folded = foldEvents([], state)
  assert.equal(folded.calls, 0)
  assert.equal(folded.cost.cny, 0)
  assert.equal(folded.cacheHitRate, 0)
  assert.deepEqual(folded.routes, [])
  assert.equal(foldEvents(undefined, state).cost.cny, 0)
})

console.log('isDeepseekRoute（决定哪些用量进入计价）')

check('官方与第三方 DeepSeek 路由都识别', () => {
  assert.equal(isDeepseekRoute('opencode-go', 'deepseek-flash'), true)
  assert.equal(isDeepseekRoute('opencode-go', 'deepseek-v4-pro'), true)
  assert.equal(isDeepseekRoute('openrouter', 'Pro/deepseek-ai/DeepSeek-V3.1'), true)
  assert.equal(isDeepseekRoute('deepseek', 'v4'), true) // provider 本身就叫 deepseek
  assert.equal(isDeepseekRoute('MOONSHOTAI', 'DeepSeek-V3'), true) // 大小写不敏感
})

check('其它厂商的模型不识别', () => {
  assert.equal(isDeepseekRoute('moonshotai', 'kimi-k2'), false)
  assert.equal(isDeepseekRoute('openai', 'gpt-4o'), false)
  assert.equal(isDeepseekRoute('anthropic', 'claude-sonnet-4'), false)
  assert.equal(isDeepseekRoute(undefined, undefined), false)
  assert.equal(isDeepseekRoute(null, null), false)
})

check('全程只用非 DeepSeek 的会话：calls 为 0（客户端据此整枚隐藏）', () => {
  const events = [
    {
      type: 'assistant/message',
      time: utc(2026, 1, 5, 12, 0),
      data: {
        message: { source: { provider: 'anthropic', model: 'claude-sonnet-4' } },
        usage: { inputTokens: 10, outputTokens: 20 },
      },
    },
  ]
  const folded = foldEvents(events, state)
  assert.equal(folded.calls, 0)
  assert.equal(folded.cost.cny, 0)
  assert.deepEqual(folded.routes, [])
  assert.equal(folded.other.calls, 1) // 但 token 照样统计下来
  assert.equal(folded.other.total, 30)
})

console.log('matchRoute（必须与 webServer.match() 的规则一致）')

check('前缀不带尾斜杠', () => {
  assert.equal(ROUTE_PREFIX, '/plugins/session-cost-cny')
  assert.equal(ROUTE_PREFIX.endsWith('/'), false)
})

check('子路由能被命中', () => {
  assert.equal(matchRoute('/plugins/session-cost-cny/data'), 'data')
  assert.equal(matchRoute('/plugins/session-cost-cny/refresh'), 'refresh')
})

check('裸前缀、近似前缀、其它路径都不命中', () => {
  assert.equal(matchRoute('/plugins/session-cost-cny'), null)
  assert.equal(matchRoute('/plugins/session-cost-cny-other/data'), null)
  assert.equal(matchRoute('/plugins/other/data'), null)
  assert.equal(matchRoute('/'), null)
  assert.equal(matchRoute(undefined), null)
})

console.log('价目表本地缓存')

check('权威行原样通过，多余字段被丢掉', () => {
  const rows = normalizeCachedRows([
    { model: 'deepseek-flash', hitOff: 0.02, hitPeak: 0.04, missOff: 1, missPeak: 2, outOff: 4, outPeak: 8, note: 'x' },
  ])
  assert.deepEqual(rows, [{ model: 'deepseek-flash', hitOff: 0.02, hitPeak: 0.04, missOff: 1, missPeak: 2, outOff: 4, outPeak: 8 }])
})

check('缺字段 / 负数 / 非数字 / 空数组一律作废', () => {
  const good = { model: 'm', hitOff: 0, hitPeak: 0, missOff: 1, missPeak: 1, outOff: 1, outPeak: 1 }
  const bad = [
    [],
    null,
    'x',
    [{ ...good, hitPeak: undefined }],
    [{ ...good, outOff: -1 }],
    [{ ...good, missOff: '1' }],
    [{ ...good, model: '' }],
    [{ ...good, missOff: Number.NaN }],
    [good, null],
  ]
  for (let i = 0; i < bad.length; i += 1) assert.equal(normalizeCachedRows(bad[i]), null, '第 ' + i + ' 个应当作废')
  assert.equal(normalizeCachedRows([good]).length, 1)
})

check('时间戳格式化：补零、无效值给占位文案', () => {
  const ts = new Date(2026, 8, 11, 9, 5).getTime() // 本地时间 2026-09-11 09:05
  assert.equal(formatStamp(ts), '2026-09-11 09:05')
  assert.equal(formatStamp(0), '未知时间')
  assert.equal(formatStamp(undefined), '未知时间')
})

check('缓存路径跟随 DSH_HOME', () => {
  const before = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = path.join(tmp, 'home-a')
    assert.equal(cachePath(), path.join(tmp, 'home-a', 'plugin-data', 'dsh-session-cost-cny', 'pricing.json'))
    delete process.env.DSH_HOME
    assert.match(cachePath(), /plugin-data[\\/]dsh-session-cost-cny[\\/]pricing\.json$/)
  } finally {
    if (before === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = before
  }
})

// 写读一遍；DSH_HOME 指向临时目录，不碰真实用户数据。
process.env.DSH_HOME = tmp
const ROWS = [{ model: 'deepseek-flash', hitOff: 0.02, hitPeak: 0.04, missOff: 1, missPeak: 2, outOff: 4, outPeak: 8 }]
const STAMP = new Date(2026, 8, 11, 10, 30).getTime()

const roundTrip = await writeCache({ url: 'https://example.com/zh', currency: 'CNY', fetchedAt: STAMP, rows: ROWS, usdCny: 6.71 })
check('写入缓存成功（目录会自动建出来）', () => {
  assert.equal(roundTrip, true)
  assert.equal(existsSync(cachePath()), true)
})
await checkAsync('读回缓存内容一致', async () => {
  const cached = await readCache(6.71)
  assert.deepEqual(cached, { url: 'https://example.com/zh', currency: 'CNY', fetchedAt: STAMP, rows: ROWS })
})
await checkAsync('人民币价目不受汇率影响', async () => {
  assert.notEqual(await readCache(7.3), null)
})
await checkAsync('损坏的缓存当作没有缓存', async () => {
  await writeFile(cachePath(), '{ 这不是 JSON', 'utf8')
  assert.equal(await readCache(6.71), null)
})
await checkAsync('格式版本不符当作没有缓存', async () => {
  await writeFile(cachePath(), JSON.stringify({ version: 99, rows: ROWS, currency: 'CNY' }), 'utf8')
  assert.equal(await readCache(6.71), null)
})
await checkAsync('行为空当作没有缓存', async () => {
  await writeFile(cachePath(), JSON.stringify({ version: 1, rows: [], currency: 'CNY' }), 'utf8')
  assert.equal(await readCache(6.71), null)
})
await checkAsync('英文页折算的缓存：汇率变了就重新抓', async () => {
  await writeCache({ url: 'https://example.com/en', currency: 'USD', fetchedAt: STAMP, rows: ROWS, usdCny: 6.71 })
  assert.equal((await readCache(6.71)) !== null, true)
  assert.equal(await readCache(7.3), null)
})
await checkAsync('文件不存在时安静返回 null', async () => {
  await rm(cachePath(), { force: true })
  assert.equal(await readCache(6.71), null)
})

console.log('启动流程：有缓存就不抓官网，没缓存才抓一次')

/** 等条件成立（支持异步条件），超时即失败。 */
async function until(cond, label) {
  for (let i = 0; i < 400; i += 1) {
    if (await cond()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('等待超时：' + label)
}

/** 缓存文件的解析结果；还没写完 / 坏掉都返回 null。 */
async function cacheFile() {
  try {
    return JSON.parse(await readFile(cachePath(), 'utf8'))
  } catch (error) {
    return null
  }
}

/** 造一个只够 apply() 用的假 ctx：web.fetch 可注入，webServer.register 记下来，其余服务按需给。 */
function makeCtx(fetchImpl, services) {
  const routes = []
  const extra = services !== undefined && services !== null ? services : {}
  return {
    routes,
    ctx: {
      get(name) {
        if (name === 'web') return { fetch: fetchImpl }
        return Object.prototype.hasOwnProperty.call(extra, name) ? extra[name] : undefined
      },
      effect(fn) {
        return fn()
      },
      webServer: {
        register(route) {
          routes.push(route)
          return function () {}
        },
      },
    },
  }
}

/** 直接调插件注册的路由处理器，拿回 `{ status, body }`（2 秒无响应即失败）。 */
function callRoute(holder, url, method) {
  const hit = new Promise(function (resolve, reject) {
    const res = {
      status: 0,
      writeHead(status) {
        this.status = status
      },
      end(text) {
        resolve({ status: res.status, body: JSON.parse(text) })
      },
    }
    try {
      holder.routes[0].handler({ url: url, method: method === undefined ? 'GET' : method }, res)
    } catch (error) {
      reject(error)
    }
  })
  const guard = new Promise(function (resolve, reject) {
    setTimeout(function () {
      reject(new Error('路由无响应：' + url))
    }, 2000)
  })
  return Promise.race([hit, guard])
}

/** 一条可用的 assistant/message 事件（DeepSeek 官方路由，1M 未命中输入 = 空闲 ¥1）。 */
function dzEvent(seq, ms) {
  const event = assistantEvent(ms, { inputTokens: 1000000, outputTokens: 0 })
  event.seq = seq
  return event
}

/** 在捕获 console.log 的情况下跑一段，返回日志行与回调结果。 */
async function captureLog(fn) {
  const logs = []
  const original = console.log
  console.log = function (...args) {
    logs.push(args.join(' '))
  }
  try {
    await fn(logs)
  } finally {
    console.log = original
  }
  return logs
}

// ① 没有缓存：抓一次官网，并把结果落盘。
await rm(cachePath(), { force: true })
let fetchA = 0
const caseA = makeCtx(async () => {
  fetchA += 1
  return { body: { content: ZH_PAGE } }
})
apply(caseA.ctx, {})
await until(async () => (await cacheFile()) !== null, '首次抓取并写入缓存')
check('没有缓存时抓一次官网', () => {
  assert.equal(fetchA, 1)
})
await checkAsync('抓到后写入缓存：版本、时间、单价都在', async () => {
  const written = await cacheFile()
  assert.equal(written.version, 1)
  assert.equal(written.currency, 'CNY')
  assert.equal(written.rows.length, 2)
  assert.equal(written.rows[0].model, 'deepseek-flash')
  assert.equal(written.rows[0].missOff, 1)
  assert.equal(written.rows[0].hitOff, 0.02)
  assert.equal(written.fetchedAt > 0, true)
})
check('路由已注册（前缀不带尾斜杠）', () => {
  assert.equal(caseA.routes.length, 1)
  assert.equal(caseA.routes[0].path, ROUTE_PREFIX)
})

// ② 有缓存：一次官网都不抓。
let fetchB = 0
const caseB = makeCtx(async () => {
  fetchB += 1
  return { body: { content: EN_PAGE } }
})
await captureLog(async (logs) => {
  apply(caseB.ctx, {})
  await until(() => logs.some((line) => line.indexOf('本地缓存') >= 0), '启动时读取缓存')
})
check('有缓存时完全不联网', () => {
  assert.equal(fetchB, 0)
})

// ③ refreshOnStart: true 才是每次启动都重抓。
let fetchC = 0
const caseC = makeCtx(async () => {
  fetchC += 1
  return { body: { content: ZH_PAGE } }
})
apply(caseC.ctx, { refreshOnStart: true })
await until(() => fetchC === 1, 'refreshOnStart:true 强制重抓')
// 等这一轮的缓存写入也落盘，免得它在下一个用例开始后才写回来。
await until(async () => (await cacheFile()) !== null, 'refreshOnStart 这一轮写缓存')
check('refreshOnStart:true 忽略缓存直接重抓', () => {
  assert.equal(fetchC, 1)
})

// ④ 没有缓存且抓取失败：不抛错、不写缓存，退回内置快照。
await rm(cachePath(), { force: true })
assert.equal(existsSync(cachePath()), false)
const caseD = makeCtx(async () => {
  throw new Error('offline')
})
await captureLog(async (logs) => {
  apply(caseD.ctx, {})
  await until(() => logs.some((line) => line.indexOf('内置快照') >= 0), '抓取失败的兜底日志')
})
check('抓取失败：没有留下半个缓存文件', () => {
  assert.equal(existsSync(cachePath()), false)
})

// ⑤ refreshOnStart: true 但抓取失败、且有旧缓存：退回缓存，不覆盖、不降级到内置快照。
await writeCache({ url: 'https://example.com/zh', currency: 'CNY', fetchedAt: STAMP, rows: ROWS, usdCny: 6.71 })
const caseE = makeCtx(async () => {
  throw new Error('offline')
})
await captureLog(async (logs) => {
  apply(caseE.ctx, { refreshOnStart: true })
  await until(() => logs.some((line) => line.indexOf('退回本地缓存') >= 0), '强制重抓失败后退回缓存')
})
await checkAsync('强制重抓失败：退回旧缓存而不是内置快照', async () => {
  assert.equal(existsSync(cachePath()), true)
  const kept = await cacheFile()
  assert.equal(kept.fetchedAt, STAMP) // 失败的那一轮不会写缓存
})

// 收尾：临时目录清掉，DSH_HOME 恢复原样。（放在最后：后面的用例还要用这个临时 DSH_HOME，
// 否则 apply() 会读到真实用户目录、甚至把缓存写到那儿去。）
async function cleanupTempHome() {
  await rm(tmp, { recursive: true, force: true })
  if (envBefore === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = envBefore
}

emit('会话读取：活跃会话走内存，非活跃会话读盘（切换会话不该有空窗）')
// 这一节每个 apply() 都会异步启动一次，启动日志与被临时接管的 console.log 交错；
// 统一静音，用例输出走 emit 照常打印。
const bootNoise = console.log
console.log = function () {}
const PAGE_FETCH = async () => ({ body: { content: ZH_PAGE } })
const ROW_URL = ROUTE_PREFIX + '/data?sessionId='

// ① 活跃会话：只读 ownEvents()，绝不去读盘。
{
  const events = [dzEvent(1, utc(2026, 1, 5, 12, 0))]
  let readCalls = 0
  const holder = makeCtx(PAGE_FETCH, {
    sessions: { get: () => ({ seq: 7, ownEvents: () => events }) },
    sessionQuery: {
      readSession: async () => {
        readCalls += 1
        return { session: { id: 's1' }, inheritedEventCount: 0, events }
      },
    },
  })
  apply(holder.ctx, {})
  await checkAsync('活跃会话：用内存事件计价，不碰 sessionQuery', async () => {
    const out = await callRoute(holder, ROW_URL + 's1')
    assert.equal(out.status, 200)
    assert.equal(out.body.ok, true)
    assert.equal(out.body.hasDeepseek, true)
    assert.equal(out.body.calls, 1)
    assert.equal(out.body.cost.in, 1)
    assert.equal(readCalls, 0)
  })
}

// ② 非活跃会话（dsh 刚启动 / 刚切过去）：回落到 sessionQuery.readSession 读盘，照样出金额。
{
  const events = [dzEvent(1, utc(2026, 1, 5, 12, 0))]
  let readCalls = 0
  const holder = makeCtx(PAGE_FETCH, {
    sessions: { get: () => undefined },
    sessionQuery: {
      readSession: async (id) => {
        readCalls += 1
        assert.equal(id, 'ghost')
        return { session: { id: 'ghost' }, inheritedEventCount: 0, events }
      },
    },
  })
  apply(holder.ctx, {})
  await checkAsync('非活跃会话：读持久化日志，不再回 session-not-live', async () => {
    const out = await callRoute(holder, ROW_URL + 'ghost')
    assert.equal(out.body.ok, true)
    assert.equal(out.body.hasDeepseek, true)
    assert.equal(out.body.cost.in, 1)
    assert.equal(readCalls, 1)
  })
}

// ③ fork / 恢复继承来的前缀要被跳过，否则父会话的用量会被重复计一遍。
// 真实日志里 seq 就是数组下标（seq = log.length 的连续性约定），inheritedEventCount 是前缀长度。
{
  const inherited = [dzEvent(0, utc(2026, 1, 5, 12, 0)), dzEvent(1, utc(2026, 1, 5, 12, 0))]
  const own = [dzEvent(2, utc(2026, 1, 5, 12, 0))]
  const holder = makeCtx(PAGE_FETCH, {
    sessions: { get: () => undefined },
    sessionQuery: {
      readSession: async () => ({ session: { id: 'fork' }, inheritedEventCount: 2, events: inherited.concat(own) }),
    },
  })
  apply(holder.ctx, {})
  await checkAsync('继承的前缀不计费，只算自己的事件', async () => {
    const out = await callRoute(holder, ROW_URL + 'fork')
    assert.equal(out.body.calls, 1)
    assert.equal(out.body.cost.in, 1)
  })
}

// ④ 两种兜底：没有 sessionQuery 服务 / 读盘抛错。
{
  const noQuery = makeCtx(PAGE_FETCH, { sessions: { get: () => undefined } })
  apply(noQuery.ctx, {})
  await checkAsync('没有 sessionQuery 且会话不活跃：明确回 session-not-live', async () => {
    const out = await callRoute(noQuery, ROW_URL + 'gone')
    assert.equal(out.body.ok, false)
    assert.equal(out.body.reason, 'session-not-live')
  })
}
{
  const broken = makeCtx(PAGE_FETCH, {
    sessions: { get: () => undefined },
    sessionQuery: {
      readSession: async () => {
        throw new Error('replay validation failed')
      },
    },
  })
  apply(broken.ctx, {})
  await checkAsync('读盘失败：回 session-read-failed 而不是 500', async () => {
    const out = await callRoute(broken, ROW_URL + 'bad')
    assert.equal(out.status, 200)
    assert.equal(out.body.ok, false)
    assert.equal(out.body.reason, 'session-read-failed')
  })
}

// ⑤ 路由层：只认 GET，且缺 sessionId 时报 400。
{
  const holder = makeCtx(PAGE_FETCH, { sessions: { get: () => undefined } })
  apply(holder.ctx, {})
  await checkAsync('缺 sessionId → 400；POST /data → 405', async () => {
    const missing = await callRoute(holder, ROUTE_PREFIX + '/data')
    assert.equal(missing.status, 400)
    assert.equal(missing.body.reason, 'no-session-id')
    const wrong = await callRoute(holder, ROW_URL + 'x', 'POST')
    assert.equal(wrong.status, 405)
    assert.equal(wrong.body.reason, 'method-not-allowed')
  })
}

await cleanupTempHome()
// 等各次 apply() 的异步启动流程收尾（它们的启动日志已经被静音）。
await new Promise(function (resolve) {
  setTimeout(resolve, 120)
})
console.log = bootNoise

emit('\n' + passed + ' 项全部通过')
