/**
 * 会话话费（人民币）· Client 半边
 *
 * 这是一个客户端插件 bundle：脚本执行时只向 `window.__ModuleLoader__` 注册工厂，
 * 所有副作用（含 CSS 注入）都发生在工厂体内、即模块 materialize 时。
 * factory 收到的 `require` 只能取 shell 预置的种子模块（react / react-dom 等）。
 *
 * 数据来源：Host 半边注册的两个只读路由
 *   GET  /plugins/session-cost-cny/data?sessionId=<id>
 *   POST /plugins/session-cost-cny/refresh
 *
 * UI：注册到 `conversation.composer.dock`（输入框下方的状态条区域），
 * 金额胶囊紧接在官方统计胶囊之后；点击金额在其正上方弹出明细面板。
 *
 * 位置**不做任何计算**：该槽位的容器是官方自己的 flex 行
 * （`.uV2eYG_dock{display:flex;justify-content:center;align-items:center;gap:12px}`，
 * 里面是官方 stats 条目 + 本插件条目 + 官方硬编码的 ContextMeter 等）。
 * 槽位出口由 shell 渲染成 `<div data-slot="<槽位键>" style="display:contents">`
 * （见 `@deepseek-ai/dsh-client-ui-renderer` 的 `SlotOutlet`：锚点不参与布局，
 * flex / grid 父容器看到的就是槽位自己的子节点），所以本插件在布局上**本来就是**那一行的
 * 直接子项 —— 不需要查询任何父节点，也不依赖 `.uV2eYG_` 这类 CSS Module 哈希类名
 * （哈希每次构建都可能变；真要按 DOM 定位，稳定选择器是 `[data-slot="conversation.composer.dock"]`）。
 * 于是：`flex:none`（金额不被压扁/裁掉）+ CSS `order:1`（排到所有官方元素之后，
 * 官方硬编码的兄弟节点用槽位 order 是排不过去的，只能靠 flex 的 order）；官方以后新增的
 * 元素默认 `order:0`，自然仍排在本插件前面。
 * 曾经用过"容器 0×0 + 芯片绝对定位到前一个兄弟节点的最后一枚胶囊右侧"的写法，
 * 那种写法不占布局宽度，官方往这一行新增任何东西都会被压在芯片底下（表现为重叠），
 * 已废弃；tests/test.mjs 里有结构性回归护栏。
 *
 * 拉取节奏是事件驱动（挂载 / 每个 step·turn 关闭 / 手动刷新价目表），不做定时轮询；
 * 只在宿主"暂时答不上来"（会话尚未就绪、日志还在落盘）时按固定退避补拉几次，
 * 拿到一次成功响应即停。结果按会话打标，切换会话时旧会话的数字不参与渲染。
 *
 * 数据未到时也照常渲染（只是 `visibility:hidden`）：那一行是 `justify-content:center` 的，
 * 本插件"从无到有"会把官方内容挤走半个宽度，切换会话就会看到底栏抖一下。
 * 占位与真实金额等宽（金额文本 `.dshc-amount{min-width:5.5ch}`），所以布局自始至终不动。
 *
 * @module dsh-session-cost-cny/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-cost-cny',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    // 面板要挂到 document.body（与官方弹窗一致）：portal 之外的地方，
    // position:fixed 会被带 transform/filter/contain 的祖先当成包含块，z-index 也只在该层叠上下文里比较。
    const ReactDOM = require('react-dom')
    const createPortal = typeof ReactDOM.createPortal === 'function' ? ReactDOM.createPortal : null

    const DATA_URL = '/plugins/session-cost-cny/data'
    const REFRESH_URL = '/plugins/session-cost-cny/refresh'
    const PLUGIN_ID = 'dsh-session-cost-cny'
    const CSS_TAG_ID = PLUGIN_ID + '/client.css'
    // 宿主暂未就绪时的补拉间隔（毫秒）：一共 5 次尝试、约 6 秒内收敛，之后交给 step/turn 事件驱动。
    const RETRY_DELAYS = [300, 700, 1500, 3000]

    /** 面板外观逐值取自官方 stat-dialog.module.css；胶囊样式对齐官方统计胶囊。 */
    const CSS = [
      // 关键：状态条那一行（conversation.composer.dock 的容器）就是官方自己的 flex 行
      //   .uV2eYG_dock{display:flex;justify-content:center;align-items:center;gap:12px}
      // 里面依次是：槽位条目（官方 stats 条目 + 本插件条目）、官方硬编码的 ContextMeter（上下文圆环）。
      // 槽位条目外面那层 `<div data-slot="…" style="display:contents">` 不产生盒子，
      // 所以本元素在布局上就是那一行的 flex 项。基于这一点：
      //   flex:none + white-space:nowrap —— 金额永远不被压扁/裁掉（要挤也是官方那条先省略）；
      //   order:1 --------------------- 排在所有官方元素**之后**（官方那些都没写 order，默认 0）。
      //   千万不要再改成 width:0 + 绝对定位——那样不占布局宽度，官方往这行新增任何东西
      //   （ContextMeter、新的 pill、新的条目）都会被画在芯片底下，形成重叠。
      // order 这条也正好满足"官方以后新增元素仍排在最后"：新元素默认 order:0，自然在本插件前面；
      // 与 `order` 的槽位注册顺序无关（那个只管 DOM 次序，管不到官方硬编码的兄弟节点）。
      // 若将来某个官方元素自己写了正的 order，则 order 大者靠后、相同则按 DOM 顺序。
      '.dshc-root{display:inline-flex;align-items:center;flex:none;min-width:0;margin:0;padding:0;order:1;}',
      '.dshc-chip{display:inline-flex;align-items:center;gap:6px;padding:1px 8px;border-radius:24px;border:none;background:0 0;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font:inherit;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));font-variant-numeric:tabular-nums;white-space:nowrap;cursor:pointer;user-select:none;transition:background .12s ease,color .12s ease;}',
      '.dshc-chip svg{flex:none;width:14px;height:14px;}',
      // 金额文本定宽：tabular-nums 下数字等宽，5.5ch 正好容下 `¥7.387` 这类 6 字符金额。
      // 数据未到时文本为空，宽度仍由 min-width 撑住 —— 于是"占位 → 金额"不改变胶囊宽度，
      // 居中的状态条也就不会抖（这是切换会话时最主要的一处抖动来源）。
      // 金额位数变化（0.1 / 10 / 100 这三个量级切换会多一位）仍会有约半个字符的位移，属固有代价。
      '.dshc-amount{display:inline-block;min-width:5.5ch;}',
      // 数据未到 / 未知：占位但不可见，不可点也不可聚焦。
      '.dshc-chip[data-hidden="1"]{visibility:hidden;pointer-events:none;}',
      '.dshc-chip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);}',
      '.dshc-panel{z-index:1100;box-sizing:border-box;position:fixed;background:var(--dsw-specific-menu);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);width:max-content;min-width:min(300px,100vw - 24px);max-width:min(440px,100vw - 24px);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;border-radius:12px;padding:16px;font-size:12px;line-height:18px;}',
      '.dshc-title{color:var(--dsw-alias-label-primary);justify-content:space-between;gap:16px;margin-bottom:8px;font-weight:500;display:flex;}',
      '.dshc-title-label{align-items:center;gap:6px;min-width:0;display:inline-flex;}',
      '.dshc-title-label svg{flex:none;width:14px;height:14px;}',
      '.dshc-title-right{align-items:center;gap:8px;display:inline-flex;}',
      '.dshc-title-value{font-variant-numeric:tabular-nums;}',
      '.dshc-refresh{display:inline-flex;align-items:center;justify-content:center;flex:none;width:18px;height:18px;margin:0;padding:0;border:none;border-radius:5px;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer;transition:background .12s ease,color .12s ease;}',
      '.dshc-refresh:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);}',
      '.dshc-refresh[disabled]{cursor:default;opacity:.55;}',
      '.dshc-refresh[data-failed="1"]{color:var(--dsw-alias-state-error-primary);}',
      '.dshc-refresh svg{width:14px;height:14px;}',
      '.dshc-spin{animation:dshc-spin .8s linear infinite;}',
      '@keyframes dshc-spin{to{transform:rotate(360deg)}}',
      '.dshc-rule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px;}',
      '.dshc-details{color:var(--dsw-alias-label-tertiary);grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0;display:grid;}',
      '.dshc-details dt,.dshc-details dd{min-width:0;margin:0;}',
      '.dshc-details dd{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right;}',
      '.dshc-dim{color:var(--dsw-alias-label-tertiary);white-space:nowrap;}',
    ].join('\n')

    // CSS 在工厂体内注入（模块首次 materialize 时），与官方客户端插件的做法一致。
    // 注意：**已存在同 id 的 style 时必须覆盖它的内容**，不能直接跳过 ——
    // HMR（clientModules.rebuilt）会重新 materialize 本 bundle，但 document 里的旧
    // <style> 节点还在；只判存在就跳过的话，JS 换了、CSS 还是旧的，
    // 会留下"新布局 + 旧样式"的混合状态，最难查。
    if (typeof document !== 'undefined' && document !== null) {
      const selector = 'style[data-plugin-css=' + JSON.stringify(CSS_TAG_ID) + ']'
      const existing = typeof document.querySelector === 'function' ? document.querySelector(selector) : null
      const tag = existing === null || existing === undefined ? document.createElement('style') : existing
      if (tag.textContent !== CSS) tag.textContent = CSS
      if (existing === null || existing === undefined) {
        tag.dataset.plugin = PLUGIN_ID
        tag.dataset.pluginCss = CSS_TAG_ID
        document.head.appendChild(tag)
      }
    }

    /** @param value - 任意值。 @returns 有限数字，否则 0。 */
    function num(value) {
      return typeof value === 'number' && value === value ? value : 0
    }

    /**
     * 人民币金额格式化：按数量级选择小数位，避免小额被抹成 0.00。
     * @param value - 金额（元）。
     * @returns 形如 `¥0.1444` 的文本。
     */
    function rmb(value) {
      const n = num(value)
      const a = n < 0 ? -n : n
      if (a === 0) return '¥0.00'
      if (a < 0.001) return '¥' + n.toFixed(5)
      if (a < 0.1) return '¥' + n.toFixed(4)
      if (a < 10) return '¥' + n.toFixed(3)
      return '¥' + n.toFixed(2)
    }

    /**
     * 精确整数 + 千位分隔，与官方弹窗的 formatExactTokens 一致。
     * @param value - token 数。
     * @returns 形如 `17,337,088` 的文本。
     */
    function exact(value) {
      const n = Math.round(num(value))
      const digits = '' + (n < 0 ? -n : n)
      let out = ''
      for (let i = 0; i < digits.length; i += 1) {
        out += digits.charAt(i)
        const rest = digits.length - 1 - i
        if (rest > 0 && rest % 3 === 0) out += ','
      }
      return (n < 0 ? '-' : '') + out
    }

    /** @returns 与官方胶囊同尺寸（14x14）的人民币图标。 */
    function coinIcon() {
      return React.createElement('svg', {
        viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true, focusable: false,
      },
        React.createElement('circle', {
          cx: 8, cy: 8, r: 6.4, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2,
        }),
        React.createElement('path', {
          d: 'M5.5 5.4 8 8.7l2.5-3.3M8 8.7v2.5M6.1 9.1h3.8M6.1 10.5h3.8',
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
      )
    }

    /**
     * @param spin - 是否处于刷新中。
     * @returns 刷新按钮图标。
     */
    function refreshIcon(spin) {
      return React.createElement('svg', {
        viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true, focusable: false,
        className: spin ? 'dshc-spin' : undefined,
      },
        React.createElement('path', {
          d: 'M14 8a6 6 0 1 1-6-6c1.68 0 3.29.67 4.49 1.83L14 5.33',
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
        React.createElement('path', {
          d: 'M14 2v3.33h-3.33',
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
      )
    }

    /**
     * 面板定位：底边落在锚点上方 `gap` 处，并整体夹进视口（四周留 `margin`）；
     * 视口尺寸变化、滚动、面板自身尺寸变化都会重新量算，因此窗口缩小时不会跑出可视范围。
     *
     * 水平对齐由 `align` 决定：
     *   · `'end'`（本插件使用）—— 面板右缘对齐锚点右缘，因为金额胶囊是状态条的最后一项；
     *   · `'start'` —— 面板左缘对齐锚点左缘（官方 `useAnchoredPosition` 的默认语义）。
     * 两者最后都会被夹进视口，所以窄窗口下都不会溢出。
     *
     * @param options - `{ open, anchorRef, panelRef, gap, margin, align }`。
     * @returns 面板的 `{ left, top }`；还没量出来时为 `null`（调用方据此先隐藏面板）。
     */
    function useAnchoredAbove(options) {
      const open = options.open
      const anchorRef = options.anchorRef
      const panelRef = options.panelRef
      const gap = options.gap
      const margin = options.margin
      const align = options.align === 'end' ? 'end' : 'start'
      const [pos, setPos] = React.useState(null)
      React.useLayoutEffect(function () {
        if (!open) {
          setPos(null)
          return undefined
        }
        const place = function () {
          const anchorEl = anchorRef.current
          if (anchorEl === null || anchorEl === undefined) return
          const anchor = anchorEl.getBoundingClientRect()
          const panel = panelRef.current
          const width = panel !== null && panel !== undefined ? panel.offsetWidth : 0
          const height = panel !== null && panel !== undefined ? panel.offsetHeight : 0
          let left = align === 'end' ? anchor.right - width : anchor.left
          let top = anchor.top - gap - height
          if (width > 0) left = Math.min(Math.max(left, margin), window.innerWidth - width - margin)
          if (height > 0) top = Math.min(Math.max(top, margin), window.innerHeight - height - margin)
          setPos({ left: left, top: top })
        }
        place()
        window.addEventListener('scroll', place, true)
        window.addEventListener('resize', place)
        const panel = panelRef.current
        let observer = null
        if (typeof ResizeObserver !== 'undefined' && panel !== null && panel !== undefined) {
          observer = new ResizeObserver(place)
          observer.observe(panel)
        }
        return function () {
          if (observer !== null) observer.disconnect()
          window.removeEventListener('scroll', place, true)
          window.removeEventListener('resize', place)
        }
      }, [open, anchorRef, panelRef, gap, margin, align])
      return pos
    }

    /**
     * 状态条里的金额胶囊 + 上方的明细面板。
     * @param props - 槽位标准 props（用到 `sessionId`）。
     * @returns 胶囊及其展开面板。
     */
    function SessionCost(props) {
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      // 计价结果连同它属于哪个会话一起存：切换会话时旧数字不参与渲染，避免闪一下别人家的金额。
      const [data, setData] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      const [node, setNode] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [failed, setFailed] = React.useState(false)
      const [bump, setBump] = React.useState(0)
      // 面板锚点：金额胶囊自己（面板要贴在它正上方）。
      const chipRef = React.useRef(null)
      const panelRef = React.useRef(null)
      // 事件驱动，而不是定时轮询：sessionStats 的 steps / turns 每次关闭一个 step 或 turn 才变，
      // 正好就是"每一步完成"这个时机（用量事件 assistant/message 早于 step/end 落盘，取到的一定是最新值）。
      const stats = props.useProjection('sessionStats')
      const steps = stats !== null && stats !== undefined && typeof stats.steps === 'number' ? stats.steps : -1
      const turns = stats !== null && stats !== undefined && typeof stats.turns === 'number' ? stats.turns : -1

      // 拉一次计价结果：挂载时、每个 step/turn 关闭后、以及手动刷新价目表后各一次。
      // 宿主偶尔会"暂时答不上来"（会话刚建立、日志还在落盘、服务尚未就绪），
      // 这里按退避补几次：拿到一次 ok 就停，所以既不是轮询，也不会让胶囊一直空着。
      React.useEffect(function () {
        if (sessionId === '') return undefined
        let alive = true
        let timer = 0
        let attempt = 0
        const load = function () {
          fetch(DATA_URL + '?sessionId=' + encodeURIComponent(sessionId), { headers: { accept: 'application/json' } })
            .then(function (res) {
              return res.ok ? res.json() : null
            })
            .then(function (json) {
              if (!alive) return
              const ok = json !== null && typeof json === 'object' && json.ok === true
              if (ok) {
                setData({ id: sessionId, value: json })
                return
              }
              if (attempt < RETRY_DELAYS.length) {
                const delay = RETRY_DELAYS[attempt]
                attempt += 1
                timer = window.setTimeout(load, delay)
              }
            }, function () {
              // 网络层失败（例如 dsh 正在重启）同样补几次。
              if (!alive) return
              if (attempt < RETRY_DELAYS.length) {
                const delay = RETRY_DELAYS[attempt]
                attempt += 1
                timer = window.setTimeout(load, delay)
              }
            })
        }
        load()
        return function () {
          alive = false
          if (timer !== 0) window.clearTimeout(timer)
        }
      }, [sessionId, steps, turns, bump])

      // 位置完全交给官方那一行的 flex 布局：本插件是它中间的一个 flex 项（见顶部 CSS 注释）。
      // 这里不再做任何量测 / 绝对定位 / 观察器，因此官方增删状态条内容都不会与本插件重叠。

      // 点击面板外部收起（pointerdown 与官方 useDismissOnOutsidePointer 一致）。
      React.useEffect(function () {
        if (!open) return undefined
        if (typeof document === 'undefined' || document === null || typeof document.addEventListener !== 'function') return undefined
        const onDown = function (event) {
          const target = event.target
          const root = node
          if (root !== null && root !== undefined && typeof root.contains === 'function' && root.contains(target)) return
          // 面板已 portal 到 body，不再是 root 的后代，必须单独判一次，否则点面板内部也会被当成"外部"
          const panel = panelRef.current
          if (panel !== null && panel !== undefined && typeof panel.contains === 'function' && panel.contains(target)) return
          setOpen(false)
        }
        document.addEventListener('pointerdown', onDown)
        return function () {
          document.removeEventListener('pointerdown', onDown)
        }
      }, [open, node])

      // 只有"这份结果属于当前会话"时才可用；跨会话瞬间的旧结果一律当作没有数据。
      const payload = data !== null && data.id === sessionId && typeof data.value === 'object' ? data.value : null
      const ready = payload !== null
      // 面板位置：视口自适应，窗口缩放/滚动都会重算（未量出前先隐藏，避免闪一下错误位置）。
      // 注意必须放在任何 early return 之前，保证 hook 调用顺序稳定。
      const panelPos = useAnchoredAbove({
        open: open && ready,
        anchorRef: chipRef,
        panelRef: panelRef,
        gap: 8,
        margin: 12,
        align: 'end',
      })

      // 换会话就收起面板：否则切过去会拿新会话的数字自动弹开。
      React.useEffect(function () {
        setOpen(false)
      }, [sessionId])

      if (sessionId === '') return null

      // 已知这个会话没用过 DeepSeek（宿主算出 calls === 0）：整枚不渲染，把位置让回官方布局。
      // 字段缺失（版本差异）时按"显示"处理，别把本来能算的会话也藏掉。
      if (ready && payload.hasDeepseek === false) return null

      // 关键：这里**没有** `if (!ready) return null`。
      // 状态条那一行是 justify-content:center 的，本插件"从无到有"会把官方内容整体挤走半个宽度，
      // 于是在切换会话（先无数据、随后到达）时能看到底栏抖一下。
      // 所以数据未到时照常渲染，只是让胶囊不可见（visibility:hidden，见 CSS）：占位尺寸与真实金额
      // 完全一致（金额文本定宽 .dshc-amount），"占位 → 金额"只是换个字，布局纹丝不动。
      const visible = ready && payload.hasDeepseek !== false

      const cost = ready ? payload.cost : null
      const tokens = ready ? payload.tokens : null
      // 数据未到时金额留空：文本跨度由 CSS 定宽，占位与真实金额一样宽。
      const chipText = ready && cost !== null && cost !== undefined ? rmb(cost.cny) : ''

      const attach = function (element) {
        if (element === null || element === undefined) return
        setNode(function (current) {
          return current === element ? current : element
        })
      }
      const onToggle = function () {
        setOpen(!open)
      }
      const onRefresh = function () {
        if (busy) return
        setBusy(true)
        fetch(REFRESH_URL, { method: 'POST', headers: { accept: 'application/json' } })
          .then(function (res) {
            return res.ok ? res.json() : null
          })
          .then(function (json) {
            const ok = json !== null && typeof json === 'object' && json.ok === true
            setBusy(false)
            setFailed(!ok)
            if (ok) setBump(function (current) { return current + 1 })
          }, function () {
            setBusy(false)
            setFailed(true)
          })
      }

      // 芯片就是一个普通行内元素：宽度、间距、垂直对齐全部由官方那一行 flex 负责。
      // 数据未到时用 data-hidden 让它不可见（不是不渲染），从而占住同样的尺寸、避免布局抖动；
      // 同时 disabled + tabIndex:-1 + aria-hidden，免得键盘/读屏落在一个看不见的按钮上。
      const chip = React.createElement('button', {
        type: 'button',
        className: 'dshc-chip',
        'data-hidden': visible ? '0' : '1',
        disabled: !visible,
        tabIndex: visible ? undefined : -1,
        'aria-hidden': visible ? undefined : 'true',
        ref: chipRef,
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        onClick: onToggle,
      }, coinIcon(), React.createElement('span', { className: 'dshc-amount' }, chipText))
      const rootProps = {
        className: 'dshc-root',
        ref: attach,
      }

      // 没有数据时只渲染胶囊（不渲染面板）：此刻也没有可展示的数字。
      if (!open || !ready) {
        return React.createElement('div', rootProps, chip)
      }

      const rows = []
      let row = 0
      const addRow = function (label, count, value) {
        rows.push(React.createElement('dt', { key: 'k' + row }, label))
        rows.push(React.createElement('dd', { key: 'v' + row },
          [React.createElement('span', { className: 'dshc-dim', key: 'd' }, exact(count) + ' tok'), ' · ' + value]))
        row += 1
      }
      addRow('输入 · 未命中缓存', tokens.miss, rmb(cost.in))
      addRow('输入 · 缓存命中', tokens.hit, rmb(cost.hit))
      if (num(tokens.write) > 0) addRow('缓存写入', tokens.write, rmb(cost.write))
      addRow('输出', tokens.out, rmb(cost.out))

      // 会话里用过的非 DeepSeek 模型：只报 token 数（没有可信单价，金额无法计算）。
      const other = payload.other !== undefined && payload.other !== null && typeof payload.other === 'object' ? payload.other : null
      const otherTokens = other !== null ? num(other.total) : 0
      if (otherTokens > 0) {
        rows.push(React.createElement('dt', { key: 'ko' }, '其他模型'))
        rows.push(React.createElement('dd', { key: 'vo' },
          [React.createElement('span', { className: 'dshc-dim', key: 'do' }, exact(otherTokens) + ' tok'), ' · 金额未知']))
      }

      const refreshButton = React.createElement('button', {
        type: 'button',
        className: 'dshc-refresh',
        disabled: busy,
        'data-failed': failed ? '1' : '0',
        'aria-label': '刷新价目表',
        onClick: onRefresh,
      }, refreshIcon(busy))

      const panel = React.createElement('div', {
        className: 'dshc-panel',
        role: 'dialog',
        'aria-label': '本会话话费明细',
        ref: panelRef,
        style: panelPos !== null
          ? { left: panelPos.left, top: panelPos.top }
          : { visibility: 'hidden', left: 0, top: 0 },
      },
        React.createElement('div', { className: 'dshc-title' },
          React.createElement('span', { className: 'dshc-title-label' }, coinIcon(), '会话话费'),
          React.createElement('span', { className: 'dshc-title-right' },
            React.createElement('span', { className: 'dshc-title-value' }, rmb(cost.cny)),
            refreshButton,
          ),
        ),
        React.createElement('div', { className: 'dshc-rule' }),
        React.createElement('dl', { className: 'dshc-details' }, rows),
      )
      // 与官方 stat dialog 一致：挂到 document.body，z-index 与 fixed 定位都在顶层生效。
      const body = typeof document !== 'undefined' && document !== null ? document.body : null
      const mounted = createPortal !== null && body !== null ? createPortal(panel, body) : panel

      return React.createElement('div', rootProps, chip, mounted)
    }

    /** 事件驱动，不再需要 timer（轮询）等任何 Cordis 服务。 */
    const inject = []

    /**
     * 把金额胶囊注册进输入框下方的状态条槽位。
     * @param ctx - 客户端 Cordis 上下文。
     */
    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      /**
       * 把槽位 props 转交给组件：组件需要 sessionId 与 useProjection。
       * 槽位若没给 useProjection（版本差异），传一个返回 undefined 的替身，
       * 组件会退化成"只在挂载时拉一次"，而不是抛错让整个条目被摘掉。
       * @param props - 槽位标准 props。
       * @returns 渲染结果。
       */
      function SessionCostBound(props) {
        return React.createElement(SessionCost, {
          sessionId: props.sessionId,
          useProjection: typeof props.useProjection === 'function' ? props.useProjection : function () { return undefined },
        })
      }
      slots.inject('conversation.composer.dock', function () {
        return slots.register(
          // order 只管槽位条目之间的 DOM 次序（官方 stats 条目是 0，这里给 1 紧随其后）。
          // 视觉位置由本插件自己的 CSS `order:1` 决定：官方硬编码的兄弟节点（上下文圆环等）
          // 不是槽位条目，靠槽位 order 是排不到它们后面的，CSS order 才行。
          { name: 'conversation.composer.dock', id: 'session-cost-cny', order: 1, label: '本会话话费' },
          SessionCostBound,
        )
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
