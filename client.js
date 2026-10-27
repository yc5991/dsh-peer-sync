window.__ModuleLoader__.load({
  id: 'dsh-peer-sync',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState } = React

    const zh = typeof navigator !== 'undefined' && /^zh/i.test(navigator.language || '')
    const L = (cn, en) => (zh ? cn : en)

    const S = {
      page: { display: 'flex', flexDirection: 'column', gap: 18, padding: '4px 0 24px' },
      section: { display: 'flex', flexDirection: 'column', gap: 8 },
      title: {
        fontSize: 13,
        fontWeight: 600,
        color: 'var(--dsw-alias-label-primary)',
        margin: 0,
      },
      hint: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', margin: 0, lineHeight: 1.6 },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 12,
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      },
      row: { display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 },
      name: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      mono: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary)',
      },
      dim: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 },
      dot: (color) => ({
        width: 8,
        height: 8,
        borderRadius: 4,
        flex: '0 0 auto',
        background: color,
        marginTop: 1,
      }),
      list: { display: 'flex', flexDirection: 'column', gap: 8, margin: 0, padding: 0, listStyle: 'none' },
      code: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 11,
        color: 'var(--dsw-alias-label-secondary)',
        wordBreak: 'break-all',
      },
      button: {
        alignSelf: 'flex-start',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: 8,
        padding: '5px 12px',
        fontSize: 12,
        cursor: 'pointer',
      },
      tag: {
        fontSize: 11,
        padding: '1px 6px',
        borderRadius: 6,
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-secondary)',
      },
      textarea: {
        width: '100%',
        boxSizing: 'border-box',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'inherit',
        fontSize: 13,
        padding: '8px 10px',
        resize: 'vertical',
      },
      reply: {
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        borderLeft: '2px solid var(--dsw-alias-state-success-primary)',
        paddingLeft: 10,
      },
      pre: {
        margin: 0,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12,
        color: 'var(--dsw-alias-label-primary)',
        maxHeight: 220,
        overflow: 'auto',
      },
      warn: {
        margin: 0,
        fontSize: 12,
        color: 'var(--dsw-alias-state-warning-primary, var(--dsw-alias-label-secondary))',
        lineHeight: 1.6,
      },
    }

    function when(value) {
      if (!value) return '—'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return '—'
      const pad = (n) => String(n).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function size(bytes) {
      const value = Number(bytes) || 0
      if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
      if (value >= 1024) return `${Math.round(value / 1024)} KB`
      return `${value} B`
    }

    /**
     * Which machine runs this session. The list used to be titled "mirror" and
     * only appeared after a copy was pulled, which left the common case — the
     * peer publishes, this machine copies nothing — looking empty.
     */
    function Where(props) {
      const item = props.item
      if (item.where === 'local') return h('span', { style: S.tag }, L('本地', 'local'))
      return h(
        'span',
        { style: S.tag },
        `${L('远程', 'remote')} · ${item.peer || '?'}`,
      )
    }

    function Section(props) {
      return h('section', { style: S.section }, h('h3', { style: S.title }, props.title), props.children)
    }

    /**
     * The panel's write path lives on the GUI server (loopback only), not on the
     * peer listener: the page is already talking to that origin, and the peer
     * token must never end up in a page.
     */
    async function api(path, init) {
      const response = await fetch(`/api/peer-sync${path}`, {
        ...(init || {}),
        headers: { 'content-type': 'application/json', ...((init && init.headers) || {}) },
      })
      const value = await response.json().catch(() => null)
      if (!value || typeof value !== 'object') return { ok: false, reason: `http-${response.status}` }
      if (!response.ok && value.ok !== false) return { ...value, ok: false, reason: value.reason || `http-${response.status}` }
      return value
    }

    /**
     * What a non-reply outcome means for the person looking at it.
     *
     * The API's `hint` is written for a caller and stays English; this table is
     * for the person who has to decide what to do next, and falls through to the
     * raw reason plus the server hint when the case is not known here.
     */
    const REASONS = {
      'agent-busy': ['对端前面还有一个回合在跑，这条排在它后面', 'a turn is already running there; this one is queued'],
      'awaiting-owner-approval': ['对端卡在一个需要本机批准的审批上，等多久都不会动', 'blocked on an approval only the owner can click'],
      'turn-in-progress': ['对端还在跑，等待上限到了', 'still running when the wait budget expired'],
      'turn-ended-without-reply': ['对端那个回合结束了但没说话（可能被中断，或只调用了工具）', 'the turn ended without text (cancelled, or tools only)'],
      'not-started': ['对端收到了，但没有开回合', 'accepted, but no turn started'],
      'remote-prompts-disabled': ['对端没有允许远程投递（remotePrompts）', 'the peer does not allow remote prompts'],
      'peer-revoked': ['这个对端已被撤销，先恢复信任', 'this peer is revoked; restore trust first'],
      'not-found': ['对端版本太旧，没有这条路由', 'the peer build has no such route'],
      'request-failed': ['请求没到对端或超时', 'the request did not reach the peer'],
      'unknown-peer': ['没有这个对端', 'no such peer'],
      'missing-session': ['没有指定会话', 'no session given'],
      'empty-text': ['没有内容可发', 'nothing to send'],
      'archive-failed': ['对端拒绝归档（回合进行中的会话不能归档）', 'the peer refused to archive it (a running turn blocks it)'],
      'not-live': ['那台没有正在跑的回合（会话未附着），不需要中断', 'that session has no running turn in memory'],
      'cancel-failed': ['对端拒绝中断', 'the peer refused to cancel'],
      'read-failed': ['读不到那个会话（不存在或没附着）', 'could not read that session'],
      'create-failed': ['对端建会话失败', 'the peer could not create the session'],
    }

    function explain(reason) {
      const pair = REASONS[reason]
      return pair ? L(pair[0], pair[1]) : reason
    }

    /**
     * Give a `/result` answer the same shape as a `/prompt` answer.
     *
     * The result route answers `{replied, running, blocked}` without a `reason`,
     * because "why" is a property of the wait, not of the read. The panel still
     * has to say something, so the three cases are named here once.
     */
    function asOutcome(value) {
      if (!value || value.replied || value.reason) return value
      return {
        ...value,
        reason: value.blocked ? 'awaiting-owner-approval' : value.running ? 'turn-in-progress' : 'not-started',
      }
    }

    /** One line of truth about a delivered prompt, whatever came back. */
    function Outcome(props) {
      const value = props.value
      if (!value) return null
      if (value.replied) {
        return h(
          'div',
          { style: S.reply },
          h('span', { style: S.dim }, `${L('回话', 'reply')} · ${((Number(value.waitedMs) || 0) / 1000).toFixed(1)}s`),
          h('pre', { style: S.pre }, String(value.reply || '')),
        )
      }
      const reason = value.reason || (value.ok ? 'unknown' : 'failed')
      // A cancel answers `{ok, accepted}` with no reason: reporting "unknown" for
      // a request that worked is worse than saying it was accepted.
      if (value.ok && !value.replied && !value.reason) {
        return h('p', { style: S.hint }, L('对端已受理', 'Accepted by the peer'))
      }
      // When a turn is stuck on an approval, which tool it wants is the only part
      // of the story the person who has to click it does not already know.
      const approval = value.approval && value.approval.tool ? value.approval : null
      const tool = approval ? `${approval.tool}${approval.id ? ` (${String(approval.id).slice(0, 8)})` : ''}` : ''
      const known = REASONS[reason]
      const raw = known ? '' : ` · ${reason}`
      const note = value.hint || value.message || ''
      return h(
        'p',
        { style: S.warn },
        `${explain(reason)}${tool ? ` · ${tool}` : ''}${raw}${note && !known ? ` · ${note}` : ''}`,
      )
    }

    function SessionRow(props) {
      const item = props.item
      const [open, setOpen] = useState(false)
      const [text, setText] = useState('')
      const [pending, setPending] = useState(false)
      const [result, setResult] = useState(null)
      const [stopping, setStopping] = useState(false)

      const stop = async () => {
        if (stopping) return
        setStopping(true)
        setResult(null)
        try {
          const value = await api('/cancel', {
            method: 'POST',
            body: JSON.stringify({ peer: item.peer, sessionId: item.id }),
          })
          setResult(value)
          if (props.onChanged) props.onChanged()
        } catch (error) {
          setResult({ ok: false, reason: 'network-error', message: String((error && error.message) || error) })
        } finally {
          setStopping(false)
        }
      }

      // The wait has a budget; the turn does not. When the budget runs out, come
      // back for the answer instead of losing it.
      const refetch = async () => {
        setResult(null)
        try {
          const value = await api('/result', {
            method: 'POST',
            body: JSON.stringify({ peer: item.peer, sessionId: item.id }),
          })
          setResult(asOutcome(value))
        } catch (error) {
          setResult({ ok: false, reason: 'network-error', message: String((error && error.message) || error) })
        }
      }

      // Tidying happens from here too: the stray sessions this plugin creates on
      // the peer (drills, remote-created sessions) are visible in this list.
      const archiveThere = async () => {
        setResult(null)
        try {
          const value = await api('/session/archive', {
            method: 'POST',
            body: JSON.stringify({ peer: item.peer, sessionId: item.id }),
          })
          setResult(value)
          if (props.onChanged) props.onChanged()
        } catch (error) {
          setResult({ ok: false, reason: 'network-error', message: String((error && error.message) || error) })
        }
      }

      const send = async () => {
        if (pending || !text.trim()) return
        setPending(true)
        setResult(null)
        try {
          let value = await api('/prompt', {
            method: 'POST',
            body: JSON.stringify({ peer: item.peer, sessionId: item.id, text, wait: true, waitSeconds: 120 }),
          })
          // The 120s is this panel's budget, not the turn's. While the peer is
          // still producing, come back for it instead of dumping the decision on
          // the user: three reads, four seconds apart, then hand it over.
          for (let attempt = 0; attempt < 3 && value && !value.replied && value.reason === 'turn-in-progress'; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 4000))
            const again = await api('/result', {
              method: 'POST',
              body: JSON.stringify({ peer: item.peer, sessionId: item.id }),
            })
            if (again) value = asOutcome(again)
          }
          setResult(value)
          if (value && value.replied) setText('')
          if (props.onChanged) props.onChanged()
        } catch (error) {
          setResult({ ok: false, reason: 'network-error', message: String((error && error.message) || error) })
        } finally {
          setPending(false)
        }
      }

      return h(
        'li',
        { style: S.card },
        h(
          'div',
          { style: S.row },
          h(Where, { item }),
          h('span', { style: S.name }, item.title || L('(无标题)', '(untitled)')),
          item.mirrored ? h('span', { style: S.tag }, L('已镜像', 'mirrored')) : null,
          item.archived ? h('span', { style: S.tag }, L('已归档', 'archived')) : null,
        ),
        h('div', { style: S.row }, h('span', { style: S.dim }, `${when(item.updatedAt)} · ${size(item.size)}`)),
        h('span', { style: S.code }, item.cwd || ''),
        h(
          'div',
          { style: S.row },
          h(
            'button',
            { type: 'button', style: S.button, onClick: () => setOpen(!open), disabled: item.archived },
            open ? L('收起', 'Close') : L('在这里发一句', 'Send a message'),
          ),
          // Peeking is useful on its tonight: the last answer of a session that
          // nobody has messaged for a while is the cheapest way to see what that
          // machine is doing, and it does not spend anything there.
          h(
            'button',
            { type: 'button', style: S.button, onClick: refetch },
            result && (result.running || result.reason === 'turn-in-progress')
              ? L('再取一次结果', 'Fetch the answer now')
              : L('看最近结果', 'Show the latest answer'),
          ),
          // A turn stuck on an approval never finishes on its own, and the person
          // who notices is here, not there.
          h(
            'button',
            { type: 'button', style: S.button, disabled: item.archived || stopping, onClick: stop },
            stopping ? L('中断中…', 'Stopping…') : L('中断对端回合', 'Stop that turn'),
          ),
          h(
            'button',
            { type: 'button', style: S.button, disabled: item.archived, onClick: archiveThere },
            L('在对端归档', 'Archive there'),
          ),
          open
            ? h(
                'span',
                { style: S.dim },
                L('在这一行按发送：消息传到对端，由对端消耗额度、按对端权限执行。', 'Send: the peer runs it, with its quota and its permissions.'),
              )
            : null,
        ),
        open
          ? h(
              'div',
              { style: S.section },
              h('textarea', {
                style: S.textarea,
                rows: 3,
                value: text,
                placeholder: L('要发给这个会话的话…', 'Message for this session…'),
                onChange: (event) => setText(event.target.value),
                disabled: pending,
              }),
              h(
                'div',
                { style: S.row },
                h(
                  'button',
                  { type: 'button', style: S.button, onClick: send, disabled: pending || !text.trim() },
                  pending ? L('等待对端…', 'Waiting…') : L('发送', 'Send'),
                ),
                pending ? h('span', { style: S.dim }, L('对端在跑，最多等 120 秒', 'peer is running it, up to 120s')) : null,
              ),
              h(Outcome, { value: result }),
            )
          : null,
      )
    }

    function Peers(props) {
      const [busy, setBusy] = useState(null)
      const [creating, setCreating] = useState(null)
      const [created, setCreated] = useState(null)

      const toggle = async (peer) => {
        const next = peer.trust === 'revoked' ? 'explicit' : 'revoked'
        setBusy(peer.name)
        try {
          await api('/trust', { method: 'POST', body: JSON.stringify({ peer: peer.name, trust: next }) })
          if (props.onChanged) props.onChanged()
        } finally {
          setBusy(null)
        }
      }

      // Creating the session over there is the one thing delivery cannot do for
      // itself: a message needs a session to land in, and only that machine can
      // make one.
      const createThere = async (peer) => {
        setCreating(peer.name)
        setCreated(null)
        try {
          const value = await api('/session/remote', { method: 'POST', body: JSON.stringify({ peer: peer.name }) })
          setCreated({ peer: peer.name, ...value })
          if (props.onChanged) props.onChanged()
        } catch (error) {
          setCreated({ peer: peer.name, ok: false, reason: 'network-error', message: String((error && error.message) || error) })
        } finally {
          setCreating(null)
        }
      }

      if (!props.peers.length) {
        return h('p', { style: S.hint }, L('还没有对端。两台都装好后会自动发现并配对。', 'No peers yet. They pair automatically once both sides run.'))
      }
      return h(
        'ul',
        { style: S.list },
        props.peers.map((peer, index) =>
          h(
            'li',
            { key: `${peer.name}-${index}`, style: S.card },
            h(
              'div',
              { style: S.row },
              h('span', { style: S.dot(peer.reachable ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-idle-primary)') }),
              h('span', { style: S.name }, peer.name || peer.url),
              h('span', { style: S.dim }, peer.reachable ? L('在线', 'online') : L('离线', 'offline')),
              peer.trust === 'revoked'
                ? h('span', { style: S.tag }, L('已撤销', 'revoked'))
                : null,
              peer.pairedVia === 'first' || peer.pairedVia === 'code'
                ? h('span', { style: S.tag }, peer.pairedVia === 'code' ? L('配对码', 'paired by code') : L('首个配对', 'first pairing'))
                : null,
              peer.sessions && peer.sessions.count !== undefined
                ? h('span', { style: S.tag }, `${L('通告会话', 'sessions')} ${peer.sessions.count}`)
                : null,
              h('span', { style: S.code }, peer.url),
            ),
            h(
              'div',
              { style: S.row },
              h('span', { style: S.dim }, `${L('上次同步', 'last sync')} ${when(peer.lastSyncAt)}`),
              peer.lastError ? h('span', { style: S.dim }, peer.lastError) : null,
              peer.trust === 'revoked'
                ? null
                : h(
                    'button',
                    {
                      type: 'button',
                      style: S.button,
                      disabled: creating === peer.name || !peer.reachable,
                      onClick: () => createThere(peer),
                    },
                    creating === peer.name
                      ? L('正在对端创建…', 'Creating…')
                      : L('在对端新建会话', 'New session there'),
                  ),
              h(
                'button',
                {
                  type: 'button',
                  style: S.button,
                  disabled: busy === peer.name,
                  onClick: () => toggle(peer),
                },
                busy === peer.name
                  ? L('保存中…', 'Saving…')
                  : peer.trust === 'revoked'
                    ? L('恢复信任', 'Trust again')
                    : L('撤销', 'Revoke'),
              ),
            ),
            created && created.peer === (peer.name || null)
              ? created.ok
                ? h(
                    'p',
                    { style: S.hint },
                    `${L('已在对端创建', 'Created on the peer')}: ${created.sessionId || '?'} · ${L('会话最多 15 秒后出现在下面（对端下次通告时）', 'it shows up below within 15s, on the next handshake')}`,
                  )
                : h('p', { style: S.warn }, `${created.reason || 'failed'}${created.message ? ` · ${created.message}` : ''}`)
              : null,
          ),
        ),
      )
    }

    function Panel() {
      const injected = typeof window === 'undefined' ? null : window.__DSH_PEER_SYNC__
      const [data, setData] = useState(injected)
      const [refreshing, setRefreshing] = useState(!injected)
      const [failure, setFailure] = useState(null)

      // The page carries one snapshot; every write path re-reads it instead of
      // patching local state, so what the panel shows is what the engine has.
      const refresh = React.useCallback(async () => {
        setRefreshing(true)
        try {
          const value = await api('/snapshot')
          if (value && value.ok && value.snapshot) {
            setData(value.snapshot)
            setFailure(null)
          } else {
            setFailure(value && (value.reason || value.message))
          }
        } catch (error) {
          setFailure(String((error && error.message) || error))
        } finally {
          setRefreshing(false)
        }
      }, [])

      // The injected snapshot is an optimisation, not the source of truth: the
      // Desktop shell may not render its HTML through the host's index tap, which
      // is exactly the case that showed an empty panel here. Fetch instead.
      React.useEffect(() => {
        if (!injected) void refresh()
      }, [])

      if (!data) {
        return h(
          'div',
          { style: S.page },
          h(
            'p',
            { style: S.hint },
            refreshing
              ? L('正在从本机读取状态…', 'Reading status from the host…')
              : failure
                ? `${L('读取失败', 'Read failed')}: ${failure}`
                : L(
                    '没拿到状态。点下面重新读取；若仍为空，说明插件的面板接口没注册上（看 sync.log 里有没有 "panel api" 的警告）。',
                    'No status. Read again below; if it stays empty the panel api is not registered (check sync.log for a "panel api" warning).',
                  ),
          ),
          h(
            'button',
            { type: 'button', style: S.button, onClick: refresh, disabled: refreshing },
            refreshing ? L('读取中…', 'Reading…') : L('重新读取', 'Read again'),
          ),
        )
      }

      const peers = Array.isArray(data.peers) ? data.peers : []
      const bundles = data.bundles || {}
      const sessions = data.sessions || { items: [] }
      const units = data.units || { count: 0, ids: [] }

      return h(
        'div',
        { style: S.page },
        h(
          'div',
          { style: S.row },
          h('span', { style: S.name }, L('跨机同步', 'Peer Sync')),
          h('span', { style: S.tag }, data.pairing && data.pairing.mode ? `pairing: ${data.pairing.mode}` : 'pairing: —'),
          h(
            'button',
            { type: 'button', style: S.button, onClick: refresh, disabled: refreshing },
            refreshing ? L('读取中…', 'Reading…') : L('重新读取', 'Refresh'),
          ),
        ),
        h(
          'p',
          { style: S.hint },
          `${L('本机', 'this machine')} ${data.self || '?'} · ${L('监听', 'listen')} ${data.listen || '?'} · ${L('发现', 'discovery')} udp:${(data.pairing && data.pairing.port) || '?'} · ${units.count} ${L('个同步单元', 'units')}`,
        ),

        h(Section, { title: `${L('对端', 'Peers')} (${peers.length})` }, h(Peers, { peers, onChanged: refresh })),

        h(
          Section,
          { title: L('同步内容', 'Synced units') },
          h('p', { style: S.code }, units.ids.length ? units.ids.join('  ·  ') : '—'),
          data.pending && data.pending.length
            ? h('p', { style: S.hint }, `${L('待推送', 'pending')}: ${data.pending.join(', ')}`)
            : null,
        ),

        h(
          Section,
          { title: L('对端缺少的插件', 'Bundles the peer lacks') },
          bundles.toInstall && bundles.toInstall.length
            ? h(
                'ul',
                { style: S.list },
                bundles.toInstall.map((item, index) => h('li', { key: index, style: S.code }, `+ ${item}`)),
              )
            : h('p', { style: S.hint }, L('没有需要补装的。', 'Nothing to install.')),
          bundles.needsManualInstall && bundles.needsManualInstall.length
            ? h(
                'p',
                { style: S.hint },
                L('需要手动安装：', 'Install by hand: ') + bundles.needsManualInstall.join(', '),
              )
            : null,
          bundles.stateDiff && bundles.stateDiff.length
            ? h('p', { style: S.hint }, L('开关状态不同：', 'Enabled state differs: ') + bundles.stateDiff.join('; '))
            : null,
        ),

        h(
          Section,
          {
            title: `${L('对端会话', 'Peer sessions')}${sessions.total ? ` (${sessions.total})` : ''}`,
          },
          sessions.items && sessions.items.length
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                h(
                  'p',
                  { style: S.hint },
                  L(
                    '这些会话跑在对端机器上：在这台机器上点开不会执行任何东西，发给它们的话由对端消耗额度、按对端的权限跑。',
                    'These sessions run on the peer: opening one here executes nothing, and a message sent to one is run by the peer, with its quota and its permissions.',
                  ),
                ),
                h(
                  'ul',
                  { style: S.list },
                  sessions.items
                    .slice(0, 8)
                    .map((item) => h(SessionRow, { key: item.id, item, onChanged: refresh })),
                ),
                sessions.truncated
                  ? h('p', { style: S.hint }, L(`只列出前 ${sessions.items.length} 条。`, `Showing the first ${sessions.items.length}.`))
                  : null,
              )
            : h(
                'p',
                { style: S.hint },
                sessions.peers && sessions.peers.length
                  ? L('对端还没有通告会话（它那侧 share.sessions 关着）。', 'The peer publishes no sessions (its share.sessions is off).')
                  : L('还没有对端。', 'No peer yet.'),
              ),
        ),

        data.dav
          ? h(
              Section,
              { title: L('共享挂载', 'Shared mount') },
              h(
                'div',
                { style: S.row },
                h('span', { style: S.dot(data.dav.mounted ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)') }),
                h('span', { style: S.name }, data.dav.watch),
                h(
                  'span',
                  { style: S.dim },
                  data.dav.mounted
                    ? `${L('可读', 'readable')} · ${data.dav.entries} ${L('项', 'entries')}`
                    : `${L('不可读', 'unreadable')} (${data.dav.error || '?'})`,
                ),
              ),
              data.dav.mounted
                ? null
                : h(
                    'p',
                    { style: S.hint },
                    L(
                      '挂载断了，插件不会替你重挂（重挂要系统凭据框）。在访达里重新连接那个服务器，或用之前那条 osascript 命令。',
                      'The mount is gone; the plugin will not remount it (that needs the OS credential dialog). Reconnect from Finder, or reuse the osascript command.',
                    ),
                  ),
            )
          : null,

        h(
          'p',
          { style: S.hint },
          h('span', { style: S.code }, data.paths && data.paths.log ? data.paths.log : '~/.dsh/peer-sync/sync.log'),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.plugins.tab', () =>
          ctx.slots.register(
            {
              name: 'settings.plugins.tab',
              id: 'peer-sync',
              order: 60,
              label: L('跨机同步', 'Peer Sync'),
            },
            Panel,
          ),
        )
      },
    }
  },
})

