window.__ModuleLoader__.load({
  id: 'dsh-peer-sync',
  factory(require) {
    const React = require('react')
    const h = React.createElement

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

    function Peers(props) {
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
              { style: S.dim },
              `${L('上次同步', 'last sync')} ${when(peer.lastSyncAt)}`,
              peer.lastError ? ` · ${peer.lastError}` : '',
            ),
          ),
        ),
      )
    }

    function Panel() {
      const data = typeof window === 'undefined' ? null : window.__DSH_PEER_SYNC__

      if (!data) {
        return h(
          'div',
          { style: S.page },
          h(
            'p',
            { style: S.hint },
            L(
              'Host 侧没有注入状态：插件可能刚刚重载，刷新一次页面即可；若仍为空，检查插件是否启用。',
              'No status injected by the host. Reload the page; if it stays empty, check that the plugin is enabled.',
            ),
          ),
          h('button', { type: 'button', style: S.button, onClick: () => location.reload() }, L('刷新', 'Refresh')),
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
          h('button', { type: 'button', style: S.button, onClick: () => location.reload() }, L('刷新', 'Refresh')),
        ),
        h(
          'p',
          { style: S.hint },
          `${L('本机', 'this machine')} ${data.self || '?'} · ${L('监听', 'listen')} ${data.listen || '?'} · ${L('发现', 'discovery')} udp:${(data.pairing && data.pairing.port) || '?'} · ${units.count} ${L('个同步单元', 'units')}`,
        ),

        h(Section, { title: `${L('对端', 'Peers')} (${peers.length})` }, h(Peers, { peers })),

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
                  sessions.items.slice(0, 8).map((item) =>
                    h(
                      'li',
                      { key: item.id, style: S.card },
                      h(
                        'div',
                        { style: S.row },
                        h(Where, { item }),
                        h('span', { style: S.name }, item.title || L('(无标题)', '(untitled)')),
                        item.mirrored
                          ? h('span', { style: S.tag }, L('已镜像', 'mirrored'))
                          : null,
                        item.archived ? h('span', { style: S.tag }, L('已归档', 'archived')) : null,
                      ),
                      h('div', { style: S.row }, h('span', { style: S.dim }, `${when(item.updatedAt)} · ${size(item.size)}`)),
                      h('span', { style: S.code }, item.cwd || ''),
                    ),
                  ),
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
