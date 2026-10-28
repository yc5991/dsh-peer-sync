# dsh-peer-sync

让两台机器上的 dsh（Windows ↔ macOS，网线直连或同一个局域网/Wi-Fi）**自动互相发现、自动配对**，然后保持配置一致，不用再手动 scp / 粘贴 / 填 IP。

同一份代码两边各装一次，两端完全对称：任何一边改了配置，另一边在几秒到 15 秒内跟上。

## 快速开始（两边各一条命令）

在**两台**机器的 dsh 里，各对 agent 说一句：

> 从 https://github.com/yc5991/dsh-peer-sync 安装这个插件，然后重启

agent 会执行 `plugin_manager install_bundle`（GitHub 直装），装完重启 dsh。

之后两台机器会：

1. 每隔几秒在局域网广播一条 UDP beacon（`udp:4401`，含机器 id、HTTP 端口、token 指纹，不含密钥）
2. 收到陌生 beacon → 自动完成配对握手，各自交换自己的 token，写进本机 `config.json`
3. 开始同步，日志里出现 `paired (discovered)` 和 `peer saved`

**不需要**填 IP、端口、token——除非你的网络阻止广播（见下面的排查）。

## 自动发现与配对

| 配置 | 默认 | 说明 |
|---|---|---|
| `pairing.enabled` | `true` | 关掉就只剩手动配置的对端 |
| `pairing.mode` | `"auto"` | `auto`：首配自动；`code`：必须出示配对码；`off`：只用手写 peers |
| `pairing.code` | `""` | `code` 模式下的配对码；也用于"已有一个对端后"再加新机器 |
| `pairing.port` | `4401` | UDP 广播端口，两台要一致 |
| `pairing.announceMs` | `10000` | 广播间隔 |
| `pairing.trustFirstOnly` | `true` | 只有"还没有任何对端"时才自动接受；之后必须给配对码 |

安全边界（重要）：

- `auto` 模式下的首次配对**没有任何密钥**，同网段的任何人都能完成握手并拿到你的 token，进而读到你的 API key。**在公共 Wi-Fi / 宿舍网请把 `mode` 改成 `"code"`**，两台设同一个码（例如 `"code": "482913"`）。
- 已经配置过的地址例外：如果对端地址本来就在你的 `peers` 里，它来握手会被接受（这是为了"Mac 装完不用改配置"这个场景）。
- 配对只是交换 token，**不会**因此共享凭据：真正的同步内容仍由 `sync.*` 开关决定，凭据要 `sync.credentials: true` 才走。

> 直连网线（点对点，中间没有别人的设备）用默认 `auto` 是合适的；同一个家里 Wi-Fi 想更稳妥就换 `code`。

## 同步什么

| 单元 | 来源 | 落地方式 |
|---|---|---|
| `patch` | `~/.dsh/profiles/<profile>/cordis.patch.yml` | 原子写文件，HMR 约 2 秒内热重组，**不重启进程** |
| `cred:<NAME>` | `~/.dsh/.credentials.yaml` 的 `refs` | 走 `ctx.credentials.set()`，只改 refs，**绝不动 records** |
| `preset:<相对路径>` | `~/.dsh/.agent-presets/**` | 原子写文件 |

明确**不同步**：`sessions/`、`storages/`、`node_modules/`、`.credentials.yaml` 的 `records`（里面有 `browser-session`、`deepseek-account-platform/device` 这类机器绑定的 token，拷过去会让两边登录态互相污染）。

## 插件集（L2）

插件集不走"版本协商"，而是**握手时互相通告 + 各自补齐**：每次 `GET /v1/hello` 会带上本机 `pluginManager.listBundles()` 的可移植描述，对端只做三件事：

1. 自己缺、且规格可移植（registry 版本、git、tarball）→ 按规格装；
2. 自己缺、但规格是 `link:`/`file:`/绝对路径 → 记进 `needsManualInstall`，**不会去装**（那种路径在另一台机器上不存在）；
3. 已装的开启状态和对端不同 → 只报告，**不擅自开关**。

永不删除、永不卸载。默认只**探测**：把差异写到 `~/.dsh/peer-sync/bundles.wanted.json` 并记日志；要真正安装才把配置改成 `"bundlesMode": "install"`（它会在这台机器上跑 pnpm，可能还需要 build 授权）。

```json
{ "sync": { "bundles": true }, "bundlesMode": "detect" }
```

## 工作区（L3）

同一个项目在两台机器上应该是**同一个侧边栏条目 + 同一份内容**。做法：

- **身份**：项目只按名字识别，目录各自本地解析为 `<projectsRoot>/<name>`（默认 `~/DSH/Projects`）。两台机器的绝对路径不同，但单元 id 是 `proj:<name>:<相对路径>`，所以内容能对上。
- **可见性**：插件启动时创建目录并调用 `ctx.workspaceRegistry.create(dir, name)` 注册工作区——两边侧边栏出现同名项目，各自指向自己的本地副本。
- **内容**：逐文件同步。文本按 UTF-8 传，二进制自动转 base64（`encoding` 随清单走），单文件上限 1 MB。
- **不传**：`node_modules`、`.git`、`dist`、`build`、`out`、`target`、`.next`、`.venv`、`venv`、`__pycache__`、`.idea`、`.vscode`，以及本项目里 `.dshignore` 列出的路径（一行一条，支持 `dir/`、`name`、`prefix*`）。
- **接收侧也校验忽略规则**：对端还没拿到 `.dshignore` 时，本机自己的规则仍然挡得住它推过来的文件。

```json
{
  "sync": { "projects": true },
  "projectsRoot": "~/DSH/Projects",
  "projects": ["demo"]
}
```

冲突仍然按"修改时间新的胜出"，落败版本写成 `<文件名>.conflict-<机器>-<时间>`；**这些副本不会再被同步出去**（否则会自己复制自己）。

## 会话：通告 / 提供服务 / 镜像（三件事，不是一个开关）

会话日志是 harness 自己的容器格式（`session.v4.jsonl.zstd`，Node 的 zstd 解码器会拒绝它），所以这里**只搬运、不解析、不导入**。三件事分开：

| 开关 | 作用 | 这台机器的角色 |
| --- | --- | --- |
| `share.sessions: true` | 握手时通告本机会话清单（id、标题、目录、大小、是否归档），并允许对端按 id 拉原始日志 | 提供方 |
| `sync.sessions: true` | 主动把对端通告的会话日志镜像到 `~/.dsh/peer-sync/peers/<peer>/sessions/` | 消费方 |
| 两个都关 | `/v1/remote/prompt` 仍可用，前提是你自己知道会话 id | — |

```json
{ "share": { "sessions": true }, "sync": { "sessions": false }, "sessionsLimit": 10 }
```

`/v1/session?id=` 与通告**共用同一条判断**：只要这台机器在通告会话，就同时允许按 id 拉取。以前这里只认 `sync.sessions`，结果是"通告了 10 条、一条也拉不到"——对端镜像静默失败，日志里只有一条被 catch 住的警告。

标题优先取 `ctx.sessionQuery.readTitleSnapshots(ids)`（只读服务，返回 GUI 里显示的那个折叠标题）；服务不可用时回退读 `~/.dsh/storages/session_projcache/sessions/<id>.json` 的 `record.rows.title.val`。这两处以前都不对——服务没用上、旧路径的目录结构和单文件结构都不匹配——所以通告里的标题曾经全是空串，对端列表等于没有可读信息。

镜像的行为：

- 已镜像且大小+时间没变就不再重复拉；单次最多拉 8 个会话，单会话上限 16 MB
- 生成两份索引：`index.md`（给人看，带时间/标题/目录/大小/文件链接）和 `index.json`（给程序看）
- 镜像只是**只读副本**，不是把会话搬到另一台去执行；在哪台执行由远程投递决定

设置面板列出的是"对端通告 ∪ 本机已镜像"，每条标 `远程 · <对端名>`、是否已镜像、是否归档。镜像关着也能看到清单——这正是以前面板显示"还没有镜像到对端会话"、而对面其实通告了 10 条的原因。列表默认只显示**未归档**的（十个槽位里一半是折叠会话时，列表就没用了），另有「有镜像」和「全部」两个过滤，每个都带条数。对端卡片上还会显示它的 `build`——"对面跑的是哪一版"曾经每次都要问一轮。

通告本身会落盘到 `~/.dsh/peer-sync/peers/<peer>/advert.json`（每次握手覆盖）。这不是缓存优化，是必要的：面板的读路径原本只认 `status.json`，而那个文件只在 15 秒的 tick 里写，于是**重载后到下一次握手之前面板是空的**。启动时 `hydrateAdverts()` 把这份文件读回内存，坏文件/空文件/缺目录都只是"还没有通告"，不会阻断启动。

## 远程投递（在对面跑，消耗对面的额度）

会话不复制，但消息可以投过去。投递就是真的在那台机器的进程里开一个回合：它用那台的模型、那台的目录、那台的权限去执行工具，消耗那台的额度。发起方只收到回话，不参与执行。

```json
{ "remotePrompts": "allow" }
```

`off`（默认）/ `ask`（当前等同 `off`，启动时记一条警告）/ `allow`。本机拒收时返回 `403` 和 `reason: "remote-prompts-disabled"`。

```powershell
curl.exe -X POST http://10.77.0.2:4399/v1/remote/prompt `
  -H "x-peer-token: <对端 token>" -H "content-type: application/json" `
  -d '{\"sessionId\":\"session-...\",\"text\":\"只回复这一行：OK\",\"wait\":true,\"waitSeconds\":90}'
```

```json
{ "ok": true, "requestId": "mvq6b1de-ewhyb80h", "accepted": true,
  "replied": true, "reply": "CROSS-MACHINE-OK",
  "queued": false, "started": true, "busyBefore": false,
  "blocked": null, "reason": "replied", "waitedMs": 4900 }
```

`wait: false` 只回 `accepted` 就返回。`requestId` 是幂等键，同一个请求重发不会插两条消息。

等待没拿到回话时，四种情况分开报——因为调用方该做的事完全不同：

| 返回 | 含义 | 该做什么 |
| --- | --- | --- |
| `reason: "replied"` | 拿到回话 | 结束 |
| `queued: true`、`reason: "agent-busy"` | 对面本来就有没结束的回合（`busyBefore: true`），你这条排队 | 等，或稍后重投 |
| `blocked: "awaiting-owner-approval"` | 回合卡在**拥有方审批**上，`approval` 带 `id`/`tool`/`reason` | **等多久都没用**，得那台机器上的人点一下 |
| `reason: "turn-in-progress"` | 回合在跑，预算内没答完 | 加大 `waitSeconds` 再等 |
| `reason: "turn-ended-without-reply"` | 回合已经结束，但没产出任何文字（被中断，或只调用了工具） | 不用再等；看日志或重新投一条 |

等待循环只看**最新的、有文字的** assistant 消息：只带 `tool/call` 的消息不是答案，继续等。这一点曾经写错过——把"看见 `assistant/message`"当成答完，于是每个用工具的回合都在第一次轮询就误报"还在跑"。

另外，回合一旦 `turn/end`，两次轮询内就提前返回 `turn-ended-without-reply`，不会把预算耗在"已经不会有答案"的回合上。这里**只认投递之后才开始的回合**：窗口里通常还留着上一个回合的 `turn/end`，把它当成"我们这条结束了"会在投递后 2 秒就谎报——对端会话随后明明给出了回答。实测：一条 `sleep 45` 的任务在第 7 秒被中断，调用方 **8.5 秒**就拿到这个 reason，而不是等满 120 秒。

审批这一档不是猜出来的：`approval/asked` 之后没有配对的 `approval/decided`（`approval/policy`、`approval/cancelled` 会一次性清空）就是挂着。连续两次轮询都挂着就提前返回，不把预算耗在等一个人上。实测对面卡过 8 小时 19 分，审批框一直没人点——远程这侧原本只能看到"没回话"，看不出是这个原因。

`started` 只表示"在这个观察窗口里看见了 `turn/start`"。窗口会从回合中间开始（`maxMessages` 是建议值，实际一次给几十条），所以**有 `reply` 就一定是跑过回合**，`started: false` 不代表没跑——判断用 `replied`，不要用 `started`。

面板里发消息走的是同一个端点，只是绕了一层同源接口（GUI 服务器 → 本机引擎 → 对端），所以回话的字段完全一样，`blocked` / `queued` 也照样显示。等待上限固定 120 秒，期间按钮显示"等待对端…"。

五个写接口都认同一个约定：**带 `peer` 走对端，不带就走本机**（`prompt` / `result` / `cancel` / `session/archive` / `session/unarchive`）。`prompt` 曾经没有这层对称——不带 `peer` 时会静默挑唯一对端，于是"往本机会话投一句"根本没法表达。

投递到**已归档**的会话时，响应会带 `archivedTarget: true` 和一句提示：消息还是会被执行，但那条会话在主机的侧边栏里是隐藏的，**拥有者可能根本注意不到**。（我自己踩过：误把一个活跃会话归档，然后继续往里发消息，对面一直"没回应"——其实是没人看见。）

### 在对端新建会话

投递需要有一个会话可以投进去，而对端只有人点开过的会话才存在。`/v1/remote/session` 补上这一步：

```powershell
curl.exe -X POST http://10.77.0.2:4399/v1/remote/session `
  -H "x-peer-token: <对端 token>" -H "content-type: application/json" `
  -d '{"request":{}}'
# -> {"ok":true,"sessionId":"session-…","created":{}}
```

`request` 支持 `cwd` 与 `agentPreset`，留空就用那台机器的默认目录、默认 preset。入站和投递用同一个开关（`remotePrompts: "allow"`）：两者都意味着"另一台可以动我的会话"，而新建会话是更侵入的那一半。面板上的「在对端新建会话」按钮就是这个调用；新会话要等对端下一次握手（≤15 秒）才会出现在列表里。

会话标题不需要等它自己想：`title` 不是 `create` 契约的一部分，所以建完会紧接着用 `sessionController.rename` 补一个，默认是 `来自 <对端名> 的会话`。这样在对面侧边栏里它不是一个空白条目。标题投影需要几秒才会传到 `readTitleSnapshots`，实测约 10 秒。

对端若是低于 0.6.0 的版本，会回 `reason: "not-found"` —— 那个版本还没有这条路由。

### 中断对端的回合（`/v1/remote/cancel`）

一个卡在审批上的回合不会自己结束，而"发现它卡住了"的人在这台机器上。`POST /v1/remote/cancel` 补上出口：

```powershell
curl.exe -X POST http://10.77.0.2:4399/v1/remote/cancel `
  -H "x-peer-token: <对端 token>" -H "content-type: application/json" `
  -d '{"sessionId":"session-…"}'
# -> {"ok":true,"sessionId":"session-…","shape":"object","value":{"accepted":true}}
```

实机验证过的效果：一个挂着 `approval/asked` 的回合被撤销后，事件序列出现 `approval/decided` → `tool/result` → `step/end` → `turn/end`，会话随即可以归档（`the session is active (turn)` 那条拒绝消失）。面板上每个对端会话都有「中断对端回合」。

入站同样受 `remotePrompts: "allow"` 管；`reason` 会写进日志，方便事后分辨是谁按的停止。低于 0.7.0 的对端回 `reason: "not-found"`。

归档也有对端版本：`POST /v1/remote/session/archive {"sessionId"}`，面板上用「在对端归档」。为什么是归档而不是删除——宿主侧的删除会被 Desktop shell 按内存回写状态，留下悬挂记录；归档是它自己提供的、可逆的那个动作。回合还在跑的会话会被拒（`the session is active (turn)`），先中断再归档。

### 预算到了，答案还在：`GET /v1/remote/result`

`waitSeconds` 只是**等待预算**，不是取消。回合超过预算时 `remotePrompt` 回 `turn-in-progress` 并走开，答案随后才出现在那台机器上。要给调用方一条回来的路：

```powershell
curl.exe -H "x-peer-token: <对端 token>" `
  "http://10.77.0.2:4399/v1/remote/result?sessionId=session-…"
# -> {"ok":true,"replied":true,"reply":"…","running":false,"lastSeq":19}
```

它只读窗口、不投递：`running: true` 表示回合还在跑（过一会再来），`replied: true` 表示拿到答案，`blocked` 与投递接口同义。此外还有 `lastText`——**这个会话最后说过的一句话**（不限本回合），用来回答"那边到底干完没有、说了什么"，比只看本回合的 `reply` 有用。面板在预算到了之后会**自动再取三次**（每 4 秒一次），仍没拿到才把「再取一次结果」按钮交给你。

实测：预算 1 秒 → `turn-in-progress`（1.2 秒返回）→ 3 秒后 `running:true` → 8 秒后 `replied:true` + 正文，会话随后归档。

## 对面项目出现在本机侧边栏（`remoteWorkspaces`）

同一个文件夹在两台机器上路径不同：Mac 上是 `/Volumes/DATA/ds`，Windows 上如果挂载了那个共享就是 `Z:\ds`。插件可以按"路径翻译"把对面的项目注册成本机工作区——**不复制任何文件**，工作区直接指向挂载点，改动就是改对面的文件。

```json
{
  "remoteWorkspaces": {
    "register": true,
    "mounts": [{ "remote": "/Volumes/DATA", "local": "Z:\\" }]
  }
}
```

规则：

- 候选目录来自对端**会话通告里的 `cwd`**（已在跑的会话告诉你它们在哪个项目里），所以对面得开着 `share.sessions`
- 只注册**现在真能 stat 到**的目录：挂载断了就不会留下一个点开是空的条目
- 标题是 `<目录名> · <对端名>`（例：`ds · mac-lan`），本机自己的项目**不动**
- `mounts` 只做整段路径前缀匹配，`/Volumes/DATA2` 不会被 `/Volumes/DATA` 吞掉

实测：`Z:` 就是她那台的 `/Volumes/DATA`，配置后日志出现

```
remote workspace registered: Z:\ds as "ds · mac-lan"
```

侧边栏随即多出这一项，点开就是她那台的项目目录。

### 会话行前面的 🍎 / 💻

工作区行没有可注入的插槽，但**会话行**有：`sidebar.session.row.leading`（标题前那个 16px 格）。插件在那里放一个字符：

- 🍎 这个会话的文件在**对端**（路径落在 `mounts[].local` 之下）
- 💻 文件在**本机**

判定在宿主侧完成，随快照下发为 `sessionPlaces: { [sessionId]: 'local' | 'peer' }`。插槽传给组件的 props 只有 `sessionId` 和几个 hooks（探针实测：`renderFactorySlot, sessionId, useXxx…`），所以客户端只查表，不猜、也不逐行发请求。

判定**先看工作区身份，再看 cwd**。这里踩过三个坑，都进了测试：

1. `create()` 会把 `Z:\ds` **规范化**成 `\\10.77.0.2\DATA\ds` 存储，同一目录因此有两种路径形态；
2. `create()` 对**已存在**的路径**不返回 id**，要用 `resolveByPath` 补；
3. 解码出来的 UNC 会**少一个前导斜杠**（`\\host\share` → `/host/share`），所以所有路径比较先过 `slashKey`（反斜杠归一、折叠重复斜杠、去尾斜杠）。

只看第 1 条，就会把"在对面工作区里正常创建的会话"标成本机 💻 —— 这是实际发生过的错误，而且只有盯着侧边栏看才发现。

设置面板里也有一节「来自对端的项目」，列出注册了哪些、各挂几个会话、路径当前是否可达（挂载断了会变红）。

觉得列表太吵的话，把 `client.js` 里 `peer ? '🍎' : '💻'` 的 `local` 分支改成 `null`，就只标对端。

## 版本与冲突

`cordis.patch.yml` **按条目合并**，不是整文件覆盖：

- 每个 `- id: xxx` 是一个槽位；`- insert:` 块按被插入条目的 `config.id` 拆成 `insert:<id>` 槽位（agent preset 没有顶层 id，必须这样建键，否则会被静默丢掉）。
- 合并是三方比较（用 `state.json` 里 `patchBase` 记的上次一致快照）：只有对端改过的槽位采纳对端，只有本机改过的保留本机，两边都改才按文件修改时间新的胜出。
- 胜出的那一版会写回本机，然后推给对端 —— 所以**两边最终是并集**，不是谁覆盖谁。
- 同一槽位两边都改时，落败的那个条目单独存成 `cordis.patch.yml.conflict-<对端>-<时间>`，只含冲突条目，不会覆盖整个文件。
- patch 的"版本"是**条目集合的哈希**，不是字节哈希：两边的注释、格式、条目顺序不同也不算差异，否则会一直互相重发。
- 代价：合并后文件按 `id` 排序（`insert:` 块排在最后），手工写的条目顺序会被规范化一次，注释保留。

其它单元（presets、credentials、projects）仍是整单元比较，冲突时留 `.conflict-*` 副本。

### 让某个条目只在本机生效（`syncDeny`）

`permission` 这类条目天然该由每台机器自己决定，两边共用一个值往往不是你想要的：

```json
{ "syncDeny": ["permission"] }
```

- 接受 `permission`、`id:permission`、`insert:chat` 三种写法
- 被 deny 的条目**既不发出也不收进**，本机照旧生效
- 列表是**并集**：任意一边写了 `permission`，两边都当它只在本机（两边必须对同一份"可交换视图"算哈希，否则永远对不上）
- 被排除的条目不计入 patch 的内容哈希，所以各机可以独立编辑而不触发同步

每个单元有内容哈希，两端各记一份"上次达成一致的哈希"（`state.json` 的 `bases`）。

- 只有一边变 → 直接快进。
- 两边都变 → 按文件修改时间新的胜出；修改时间相同则按哈希字典序定胜负。**两端用同一条规则独立计算，结论必然一致**，不会来回覆盖。
- 落败的那份不会被丢掉：会在对应文件旁边留一个 `<文件名>.conflict-<机器名>-<时间>`。

## 配置（每台机器自己一份，不参与同步）

`~/.dsh/peer-sync/config.json`

```json
{
  "version": 1,
  "enabled": true,
  "self": "win",
  "token": "本机自己的密钥（首次运行自动生成，配对时与对端交换）",
  "listen": { "host": "10.77.0.1", "port": 4400 },
  "peers": [{ "id": "对端节点 id", "name": "mac", "url": "http://10.77.0.2:4400", "token": "它发给我的密钥", "inbound": "我发给它的密钥", "trust": "explicit", "pairedVia": "first" }],
  "autoPush": true,
  "autoPull": true,
  "pullIntervalMs": 15000,
  "timeoutMs": 4000,
  "pairing": { "enabled": true, "mode": "auto", "port": 4401, "code": "", "announceMs": 10000, "trustFirstOnly": true },
  "sync": { "patch": true, "credentials": true, "presets": true, "bundles": true, "projects": true, "sessions": true },
  "share": { "sessions": true },
  "dav": { "enabled": false, "root": "", "watchMount": "/Volumes/dav" },
  "remotePrompts": "allow",
  "bundlesMode": "detect"
}
```

`share.sessions` 和 `sync.sessions` 都认：前者控制"握手时通告本机会话清单"，后者是"把对端会话日志镜像到本地"。只想要远程投递、不想镜像日志时，开 `share.sessions` + `sync.sessions: false` 就够。

`peers[].trust` 只有两个值：`explicit`（缺省，包括所有旧配置——是用户自己配过或配对过的）和 `revoked`。配对来源记在 `pairedVia`（`first` / `code`），纯为排查用。

### 每对一个密钥，才能真的撤销

旧协议只有一枚共享 token：谁知道它，谁就能进来，而且**所有人看起来都一样**。在这个前提下"撤销"是做不到的——你分不清来的是谁。

所以配对时**各发一枚专用密钥**：我说"你可以用 `inbound` 这串来访问我"，你说"你可以用 `token` 这串来访问我"。于是：

| 凭据 | 能否识别是谁 | 撤销是否生效 |
| --- | --- | --- |
| `peers[].inbound`（配对时发的专用密钥） | 能 | 生效：`403 peer-revoked`，连 WebDAV 挂载一起拒 |
| `token`（本机自己的共享 token） | 不能（兼容旧版与手写配置） | 不生效——这正是需要轮换 token 的原因 |

配对响应只在对方**没有**出示自己的 `grant`（也就是旧版）时才回送共享 token，新版对之间不再交换它。

迁移（两台都升到 0.4.0 之后，做一次）：

1. 两边都把 `peers` 清空（`"peers": []`），重载插件，让自动发现重新配对一次
2. 若想连旧共享 token 一起作废，再改本机 `token`（会断开旧挂载，需重新挂载并重新配对）

撤销一台机器：把它的 `trust` 改成 `"revoked"`，重载。之后的入站请求返回 403，出站也不再联系它。

`peers` 由配对自动填写；手写也支持（那样就不依赖发现）。注意每台机器的 `token` 是**自己**的，`peers[].token` 存的是**对端**的——配对时自动交换，手写时把对方的 token 填进去即可。

因为 `cordis.patch.yml` 本身是被同步的对象，插件的 Loader 行**故意不带 config** —— 身份、监听地址、密钥只存在这个本地文件里，不会被对端覆盖。

## 项目共享：WebDAV 挂载（不复制、不建账号）

插件可以在自己已有的 HTTP 通道上再暴露一个 WebDAV 端点，把本机的工作区目录共享出去。**没有 SMB、没有系统账号、没有额外端口**——认证就是配对时那枚 token（HTTP Basic，用户名随意，密码填 token）。

```json
{ "dav": { "enabled": true, "root": "", "watchMount": "/Volumes/dav" } }
```

`root` 留空 = `projectsRoot`（默认 `~/DSH/Projects`）。`watchMount` 填**这台机器挂载对端共享的那个路径**（只在挂载方有意义），插件每 30 秒列一次目录，断了就在日志里警告一次、并在设置面板里标红：

```
WARN  [peer-sync] mount /Volumes/dav is not readable (ENOENT) — remount it from the app; the plugin will not remount
```

不自动重挂是有意的：重挂要过系统凭据框，从插件里驱动它正是把 NetAuthAgent 队列搞死的方式（我们踩过）。恢复用 Finder 重连，或之前那条 `osascript … as user name … with password …`。

读 `status.json` 要注意 `dav.at` 的含义：它只在 `writeStatus()` 被调用时推进，而那由 15 秒的 tick 驱动、探测自身又限流 30 秒。**两次采样之间 `at` 落后几十秒是正常的，不代表探测死了**；只有整个 `dav` 字段为 `null` 才说明 `watchMount` 没生效（配置为空，或没被读到）。

改完重载插件，日志里会出现：

```
dav: serving C:\Users\user\DSH\Projects at /dav
```

**macOS 挂载**（两种都行，密码填**这台机器持有的那串密钥**——重新配对后就是 `peers` 里对端的 `inbound`，旧配置则是共享 token；存在 Keychain 里以后不用再输）：

- Finder → 前往 → 连接服务器 → `http://peer@10.77.0.1:4400/dav`
- 或命令行：`mount_webdav -v http://peer@10.77.0.1:4400/dav ~/DSH/Remote/win`

挂上之后在 dsh 里把 `~/DSH/Remote/win/demo` 加为工作区即可；读写都是实时的（同一批文件，不是同步）。

Windows 反向挂载 WebDAV **不推荐**：要走 WebClient 服务、还得改注册表 `BasicAuthLevel`，稳定性差。Mac 的项目要给 Windows 看，最省事的是放进同一个共享目录。

已知限制：

- 只实现了 macOS WebDAVFS 需要的方法（OPTIONS/PROPFIND/GET/PUT/DELETE/MKCOL/MOVE/COPY/PROPPATCH/LOCK/UNLOCK）；`LOCK` 会返回合法 token 但**不强制加锁**（单写者场景够用，多写者不要依赖它）
- 不支持 Range 请求和 `If-Match`/`If-None-Match` 条件写
- 走 HTTP 明文 + Basic，token 在网线上可见；只在直连/可信局域网里开
- 性能不如 SMB：大文件、大量小文件会慢；`node_modules`、`.git`、SQLite 库不要放进共享目录

## 安装

**推荐**：两台机器都在 dsh 里让 agent 执行

```
plugin_manager  action=install_bundle  target=https://github.com/yc5991/dsh-peer-sync
```

（也接受 `github:yc5991/dsh-peer-sync`。）装完重启 dsh 一次，然后等待自动发现。

**没有 `plugin_manager` 时**：它只在 Creator 模式（或显式放了 `tool-plugin-manager` 的 preset）里挂载，普通会话里没有。两条替代路径：

```bash
# 1) 直接装包（等价于工具做的事），clone 不通时用 codeload
cd ~/.dsh/profiles/<profile>
pnpm add https://codeload.github.com/yc5991/dsh-peer-sync/tar.gz/refs/heads/main
# 再把 "dsh-peer-sync" 追加进 package.json 的 dsh.profile.bundles

# 2) 克隆 + 目录安装（要改代码时用这个）
git clone https://github.com/yc5991/dsh-peer-sync.git
cd dsh-peer-sync && pnpm install   # 再以目录方式安装：target=<绝对路径>
```

固定版本就把 `refs/heads/main` 换成具体 commit：`tar.gz/<40位 sha>`。

**用哪个 pnpm**：桌面版自带的 runtime pnpm（本机是 11.x）和 PATH 里的 pnpm（可能是 10.x）store 版本不同，混用会报 `ERR_PNPM_UNEXPECTED_STORE`。用 app 当初装这个包时那个 pnpm 重装即可；换机器时先把这点确认一遍。

两台机器**不需要**写任何 IP/token；`config.json` 会在首次运行时自动生成（随机 token、`listen: "auto"`、`peers: []`），配对成功后自动补上对端。

`listen.host` 支持 `"auto"`（默认）：优先选与已配对 peer 同网段的网卡，否则选一个私有地址（`10.` / `192.168.` / `172.16-31.`）；填具体 IP 也能固定下来。因为配对用的地址取自 beacon 的**来源地址**，所以对方回连时总是走"真的通"的那条路。

## 防火墙（只放行那一侧接口，一次即可）

Windows（管理员 PowerShell），网线那侧：

```powershell
New-NetFirewallRule -DisplayName "dsh-peer-sync" -Direction Inbound -Protocol TCP `
  -LocalAddress 10.77.0.1 -LocalPort 4400 -Action Allow -Profile Private
# 自动发现用的 UDP 广播端口
New-NetFirewallRule -DisplayName "dsh-peer-sync discovery" -Direction Inbound -Protocol UDP `
  -LocalPort 4401 -Action Allow -Profile Private
```

macOS 如果开了"应用防火墙"，首次绑定端口时允许 dsh（或 `node`）接收入站连接。

## 排错：发现不了对方

1. 两边都在**同一个二层网络**吗？网线直连要同网段（例如 `10.77.0.1` / `10.77.0.2`、掩码 /24）；如果一台是 `169.254.x.x`，说明没拿到地址。
2. 入站放行了吗？Windows 默认拦入站，见上面的两条规则。
3. 广播被挡？把 `pairing.port` 两边改成同一个值（默认 4401），或在 `peers` 里直接写对端 URL 作为兜底——发现失败不影响手动配置的对端。
4. 看日志：`~/.dsh/peer-sync/sync.log`，正常应依次出现 `discovery on udp:4401` → `paired (discovered)` → `peer saved`。
5. **刚重启完的告警不算故障**：两边都实测过，重启后直连网卡的地址要过几秒才就绪，这段时间日志会出现 `peer <name> unreachable (startup)`，对端也会看不到你（`No route to host`）。等 10–20 秒再判断，别在这时改配置。

## 怎么确认在工作

一条命令自检（只在**本机**建一个临时会话、用完归档；对端只读）：

```powershell
node test\smoke.mjs --peer
```

```
PASS  local hello                        build 0.9.7 pid 44476
PASS  local publishes bundles            23 bundles
PASS  local publishes sessions           10 sessions
PASS  local status                       11 units
PASS  create session                     session-fab05b86-…
PASS  deliver and answer                 6099ms "SMOKE-OK"
PASS  archive session                    true
PASS  unarchive session                  false
PASS  peer hello                         build 0.9.7 up 12m
PASS  peer advertises sessions           10 sessions
WARN  peer advertises bundles            none: its sync.bundles is off, so the panel has no diff to show

10/10 checks passed, 1 warning(s)
```

`WARN` 不算失败（对面故意关掉某一类通告是合法配置），但它把"没有东西可同步"和"对面什么都没发"分开——这两件事在面板上长得一样，正是让我漏看了一整天的那种。本机自己的通告也一样：`sync.bundles: false` 时这里是 `WARN` 而不是 `FAIL`（这条是第一台机器之外的另一台跑出来才发现的，我原来的判定是硬失败、退出码 1，却和文档里"L2 是按机器选择加入"的说法矛盾）。

`test/` 现在打进了包（`package.json` 的 `files`），所以 tarball 安装出来的目录里也能跑这个自检，不必先 clone。

不带 `--peer` 就只查本机。任何一条 FAIL 都会让退出码非 0，可以挂进脚本。它检查的是"能不能真的投递并拿到回话"——不是端口通不通，那个 `local hello` 已经覆盖了。

下面是手动的等价物：

```powershell
# 本机视角
Get-Content ~/.dsh/peer-sync/status.json -Encoding utf8

# 从另一端问候（返回 units 清单说明通了）
curl.exe -H "x-peer-token: <token>" http://10.77.0.1:4400/v1/hello
```

`/v1/hello` 和 `/v1/status` 都带 `build`（插件 `package.json` 的版本）。两边行为不一致时**先看这个**：一边是新代码、一边是旧代码，表现出来的每个"协议 bug"其实都是版本不一致。

改完插件代码**不必重启 dsh**，但要用对开关。

**可靠做法：切换 bundle 声明。** 把 `~/.dsh/profiles/<name>/package.json` 里 `dsh.profile.bundles` 的 `dsh-peer-sync` 摘掉、等十几秒、再放回去：

```json
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dshmarket", "dsh-pet", "dsh-peer-sync"] } }
```

摘掉时日志出现 `stopped` 且监听端口消失，放回后出现 `ready`，进程和端口都不换，代价约 15 秒停机。两台机器都验过。

**但它只保证插件实例重启，不保证模块重新解析。** 宿主按文件是否变化决定要不要重新 import：改了 `lib/*.js` 再切换，新代码会生效；只改 `package.json` 的版本号就切换，`BUILD` 常量所在的模块仍在缓存里，`build` 会停在旧值（我踩过：代码是 0.8.4、`build` 报 0.8.3）。启动日志里因此多了一行：

```
loaded from file:///…/dsh-peer-sync/lib/sync.js build=0.8.5 pid=44476
```

`build` 永远是唯一判据；`loaded from` 告诉你它到底从哪个文件来的（我遇到过"跑的是新代码、版本号是旧的"，根因就是这行才看清的）。

`build` 现在**按需读** `package.json`（5 秒缓存），而不是在模块加载时读一次。好处是"只改了版本号、模块没重新解析"这种情况不会再骗人；代价是这条改动本身要等一次真正的进程重启才会进到运行中的代码里——`bundle` 切换只保证插件实例重启，模块是否重新解析看宿主，我实测过它**不保证**。

同一个信息现在也在握手响应里，不用登那台机器就能看：

```json
{"ok":true,"build":"0.8.7",
 "diag":{"build":"0.8.7","loadedFrom":"file:///…/lib/sync.js","pid":44476,
         "startedAt":"2026-10-27T15:38:15.849Z","uptimeMs":7879,"node":"v24.21.0"}}
```

`pid` 和 `startedAt` 是判断"这是新实例还是老实例"最快的方式：`build` 变了但 `pid` 没变、`uptimeMs` 很大，就说明模块被重新解析了而进程还活着——这正是"新路由在跑、版本号却是旧的"那次的状态。

对端这份指纹也会被记下来：面板对端卡片上除了 `build 0.8.3`，还会显示 `实例 12 分钟`（`uptimeMs` 换算）。所以"她到底重启了没有"是看一眼的事，不再需要问一轮——`build` 会骗人（缓存模块），`pid` + `uptime` 不会。

**不建议依赖文件 watcher。** 改 `cordis.patch.yml` 或插件源文件有时也会触发重载，但它在 Windows 上连续触发六七次后就再不响应（改什么都没反应、日志不动），而且不是每次重启都恢复。

日志：`~/.dsh/peer-sync/sync.log`（UTF-8，PowerShell 读取请加 `-Encoding utf8`）。
无 token 的请求一律 401。

## 升级另一台机器（对方 agent 不可用时）

共享目录里放了一个脚本（Windows 侧路径 C:\\Users\\<你>\\DSH\\Projects\\upgrade-peer-sync.sh，Mac 侧是挂载点下的 upgrade-peer-sync.sh）：它固定 pin、安装、用 bundle 摘/放触发重载，最后打印 uild 和 loadedFrom。先读一遍再跑：

`powershell
bash /Volumes/dav/upgrade-peer-sync.sh d30617f
`

它只碰 ~/.dsh/profiles/desktop/package.json（先备份）、装包、摘放 bundle，然后用 uild 自证。这一步不依赖对方机器上的 agent——当那边的模型调用在重试、或者它的会话被归档到看不见时，这是唯一还能推进升级的路。

## 已知局限

- 插件集只做"补齐"，不做"移除"；`link:`/本地路径的包只能在目标机手动装（`dsh-peer-sync` 自己就属于这类）。
- 插件集同步（L2）只有**发布方**开了 `sync.bundles` 才有内容。发布方没开、或那台的宿主不提供 `pluginManager` 时，接收方拿到的是一份空清单——以前面板会把它显示成"没有需要补装的"，看起来像一切都对齐了。现在会明说"对端没有通告插件集"。实测：一台通告 23 个插件集、另一台通告 0 个时，面板的这句话是唯一能看出问题的线索。
- 插件集的**开关状态**只报告（`stateDiff`），不自动对齐：翻转开关会让对面的插件卸载/加载，那应该由人点，而不是由收到的通告决定。
- 远程对会话能做的：投递、新建、中断、归档/取消归档。**没有**：删除、重跑、改标题。
- 删除不同步：一边删掉一个 preset 或项目文件，另一边不会跟着删（没有墓碑记录）。
- 面板的写接口（`/api/peer-sync/prompt`、`/api/peer-sync/trust`）注册在 GUI 服务器上，不在对端监听器上：对端监听器只认 token，把 token 塞进页面等于给浏览器开后门。这两个接口只接受 loopback 来源，但**没有额外令牌**——同一台机器上的任何进程都能调用，和它能直接读 `config.json` 是同一级别。要跨机投递，用带 token 的 `/v1/remote/prompt`。
- 撤销一台 peer 时，它手里的 WebDAV 挂载也一起被拒（`403`）——前提是那台用的是配对时发给它的专用密钥。用旧共享 token 挂上的要先重新配对（见「每对一个密钥」）。
- `workspacesRemove` 不可靠：`registry.delete()` 会返回成功，但 Desktop shell 随后按内存回写状态、条目又回来了。所以代码会再列一次确认，确认不到就明说"删除未被确认，请手动移除"，不会谎报。
- 会话标题依赖 `sessionQuery` 或 projection cache；两者都读不到时显示 `(无标题)`，不会编一个。
- 只同步 profile patch，不同步 `$DSH_HOME/cordis.patch.yml`（home 层 patch）。
- 项目同步是"逐文件镜像"而不是真合并：两边同时改同一个代码文件时不会做三方合并，只会留副本。代码项目将来更合适的做法是 git（见下）。
- 超过 1 MB 的项目文件会被跳过（只记状态，不报错）。
- 每次 `/v1/hello` 都会重扫项目目录，项目很大时会有点开销。

## 后续

- 代码类项目的合并交给 git：`git bundle` 经现有通道交换，或用 `syncMode: 'git'` 让插件只做 commit/fetch/merge，而不是字节级镜像。
- 插件集开关状态的自动对齐（现在只报告 `stateDiff`，因为它会卸载/加载对面的插件，应该由人点）。
- 远程删除会话：宿主对"删除"的语义不可靠（Desktop shell 会按内存回写），所以只提供可逆的归档。
- 面板里的远程会话按"有回合在跑 / 未镜像"分组：需要发布方在每个会话上提供实时状态，而现在只有点「看最近结果」才知道。

## 目录

```
index.js            Host 插件入口（ctx.effect 管理生命周期、注入面板快照）
client.js           Web 设置面板（对端 / 插件集 / 会话 / 挂载）
lib/paths.js        DSH_HOME / profile / patch / 凭据 / preset / 状态路径
lib/config.js       本地配置的读写与归一化 + 信任判定（trustOf / identifyPeer）
lib/units.js        同步单元的枚举、哈希、清单 + 可移植 spec 判断
lib/patch.js        cordis.patch.yml 的槽位化 + 按条目三方合并
lib/apply.js        单元落地（patch 写文件 / cred 走服务 / preset 写文件）+ 插件集补齐
lib/http.js         对端 HTTP 传输 + /dav，凭据判定与 401/403 都在这里
lib/sync.js         同步引擎：观察、拉取、推送、冲突判定、会话通告、远程投递
lib/sessions.js     会话元数据、日志读取、标题（sessionQuery + 投影文件）
lib/webdav.js       WebDAV 服务端（够 macOS WebDAVFS 挂载用）
lib/discovery.js    UDP 广播发现
lib/atomic.js       原子写
lib/json.js         尽力而为的 JSON 读取
lib/log.js          同步日志（UTF-8，双写到 sync.log）
lib/services.js     软服务查找（ctx.get，不需要 inject）
docs/               架构图 + 流程图 + 同源 Mermaid 源码（architecture.md）
test/approval.mjs   等待循环的每个判断（答案 / 审批 / 回合开闭，取自真实事件序列）
test/gates.mjs      谁能取会话、谁能被投递、谁能被信任、面板行合并
test/advert.mjs     通告缓存的水合（好 / 空 / 坏 / 形状不对 / 不存在）
test/docs.mjs       路由与文档对账（两边都查，防止表格过期）
test/panel.mjs      面板渲染树（替身 React，断言用户读到的文字）
test/smoke.mjs      一键自检：本机走完会话生命周期，对端只读
test/fake-peer.mjs  peer.mjs 用的假对端
test/peer.mjs       独立双节点验证脚本（假 credentials + 假 pluginManager）
```

图在 [`docs/architecture.md`](docs/architecture.md)：`docs/architecture.png` 是两端组件图，`docs/flow.png` 是同步 tick 与远程投递两条主流程，两张都由 `docs/render-*.py` 生成。
