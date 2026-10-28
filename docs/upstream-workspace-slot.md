# 上游需求的草稿：工作区行需要一个插槽

这份文件是给 DSH 的插槽目录提一条需求的草稿，不是这个插件的一部分。起因见 `docs/architecture.md` 的「对面的项目怎么出现在这台」：项目能出现在侧边栏了，但**没法在项目行上做标记**。

## 想要什么

在侧边栏的工作区行（截图里 `demo`、`orange`、`ds · mac-lan` 这些行）上提供一个可注入的空位，形态参照已有的会话行插槽：

```ts
// 建议的声明
{
  type: 'slot',
  name: 'sidebar.workspace.row.trailing',
  kind: 'list',
  scope: 'root',
  purpose: '工作区行右侧（标题之后、"..."菜单之前）的装饰位，用于标注该项目的来源/状态。',
  registration: [{ name: 'id', type: 'string', required: true }, { name: 'order', type: 'number' }]
}
```

props 里需要能定位到这一行，最少的集合是：

```ts
{ workspaceId: string, path: string, title: string }
```

## 为什么需要

两台机器各有一批项目；通过挂载，另一台的项目也能出现在本机侧边栏。此时**"这个项目在哪台机器上"**是这一行最重要的属性之一——它决定了点进去之后，回合是在本机跑还是在对端跑，以及文件读写走的是本地盘还是网络。

已有插槽里没有能落在这个位置的：

| 已有插槽 | 为什么不合适 |
| --- | --- |
| `sidebar.workspaces` | 整块替换，会盖掉搜索/分组/对话框，代价远超一个标记 |
| `sidebar.session.row.leading` / `.hover` | 只在**会话行**上，不是工作区行 |
| `sidebar.workspaces.directoryFlow` | 浏览区下方的洞，不逐行 |
| `sidebar.workspaces.session.menu.item` | 会话的右键菜单项，不是行内装饰 |

## 现在的替代方案与其代价

1. **标题后缀**：把工作区标题写成 `ds · mac-lan`。可行，但只能在文字里，而且一旦改名就得重建工作区（注册表没有 rename）。
2. **会话行标记**：在会话行前导格画一个 12px 图形（本插件已实现）。但它表达的是"这个会话的文件在哪"，不是"这个项目在哪"，而且工作区折叠时完全看不见。
3. **字符标记**：实测在 `msyhbd.ttc` 里 `☁`、`▣`、`◐`、`▶` 都渲染成方框（`◆ ● ★ ◇ ※ →` 正常），`🍎`/`💻` 更是方块。所以"用一个 emoji 当标记"在字体不确定的环境里不可靠，需要图形能力（SVG）或保证的字形。

## 一个最小实现建议

只加 `sidebar.workspace.row.trailing` 一个 list 槽即可；不需要 keys、不需要 modal，props 只要 `workspaceId`/`path`/`title`。渲染器在标题之后、菜单按钮之前留 16px 即可。

## 本插件的用法（如果有了这个槽）

```js
ctx.slots.register({ name: 'sidebar.workspace.row.trailing', id: 'peer-sync-place', order: 50 },
  ({ workspaceId }) => {
    const place = places[workspaceId]              // 'peer' | 'local'，宿主算好随快照下发
    return place ? h(PlaceIcon, { peer: place === 'peer' }) : null
  })
```

即：拿到 `workspaceId` 之后查表并画图，其余逻辑与现在的会话行标记完全一致（`sessionPlaces` 已经按工作区身份算好，见 `docs/architecture.md`）。
