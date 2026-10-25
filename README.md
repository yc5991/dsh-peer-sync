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

## 会话可见（只读镜像）

会话日志是 harness 自己的容器格式（`session.v4.jsonl.zstd`，Node 的 zstd 解码器会拒绝它），所以这里**只搬运、不解析、不导入**：

- 握手时附带本机最近 `sessionsLimit` 个会话的元数据：id、标题（取自 projection cache，尽力而为）、目录、更新时间、大小
- 对端按需拉原始日志，镜像到 `~/.dsh/peer-sync/peers/<peer>/sessions/<id>/`
- 同时生成两份索引：`index.md`（给人看，带时间/标题/目录/大小/文件链接）和 `index.json`（给程序看）
- 已镜像且大小+时间没变就不再重复拉；单次最多拉 8 个会话，单会话上限 16 MB

```json
{ "sync": { "sessions": true }, "sessionsLimit": 10 }
```

在另一台机器上"看"会话内容，仍然是打开那台机器上的 dsh；这个镜像解决的是"我知道对面有哪些会话、什么时候跑的、原始记录在这里"。

## 版本与冲突

`cordis.patch.yml` **按条目合并**，不是整文件覆盖：

- 每个 `- id: xxx` 是一个槽位；`- insert:` 块按被插入条目的 `config.id` 拆成 `insert:<id>` 槽位（agent preset 没有顶层 id，必须这样建键，否则会被静默丢掉）。
- 合并是三方比较（用 `state.json` 里 `patchBase` 记的上次一致快照）：只有对端改过的槽位采纳对端，只有本机改过的保留本机，两边都改才按文件修改时间新的胜出。
- 胜出的那一版会写回本机，然后推给对端 —— 所以**两边最终是并集**，不是谁覆盖谁。
- 同一槽位两边都改时，落败的那个条目单独存成 `cordis.patch.yml.conflict-<对端>-<时间>`，只含冲突条目，不会覆盖整个文件。
- patch 的"版本"是**条目集合的哈希**，不是字节哈希：两边的注释、格式、条目顺序不同也不算差异，否则会一直互相重发。
- 代价：合并后文件按 `id` 排序（`insert:` 块排在最后），手工写的条目顺序会被规范化一次，注释保留。

其它单元（presets、credentials、projects）仍是整单元比较，冲突时留 `.conflict-*` 副本。

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
  "peers": [{ "id": "对端节点 id", "name": "mac", "url": "http://10.77.0.2:4400", "token": "对端的 token" }],
  "autoPush": true,
  "autoPull": true,
  "pullIntervalMs": 15000,
  "timeoutMs": 4000,
  "pairing": { "enabled": true, "mode": "auto", "port": 4401, "code": "", "announceMs": 10000, "trustFirstOnly": true },
  "sync": { "patch": true, "credentials": true, "presets": true, "bundles": true, "projects": true, "sessions": true },
  "bundlesMode": "detect"
}
```

`peers` 由配对自动填写；手写也支持（那样就不依赖发现）。注意每台机器的 `token` 是**自己**的，`peers[].token` 存的是**对端**的——配对时自动交换，手写时把对方的 token 填进去即可。

因为 `cordis.patch.yml` 本身是被同步的对象，插件的 Loader 行**故意不带 config** —— 身份、监听地址、密钥只存在这个本地文件里，不会被对端覆盖。

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

## 怎么确认在工作

```powershell
# 本机视角
Get-Content ~/.dsh/peer-sync/status.json -Encoding utf8

# 从另一端问候（返回 units 清单说明通了）
curl.exe -H "x-peer-token: <token>" http://10.77.0.1:4400/v1/hello
```

日志：`~/.dsh/peer-sync/sync.log`（UTF-8，PowerShell 读取请加 `-Encoding utf8`）。
无 token 的请求一律 401。

## 已知局限

- 插件集只做"补齐"，不做"移除"；`link:`/本地路径的包只能在目标机手动装（`dsh-peer-sync` 自己就属于这类）。
- 删除不同步：一边删掉一个 preset 或项目文件，另一边不会跟着删（没有墓碑记录）。
- `cordis.patch.yml` 是整文件合并，不是按 entry 合并。两条 entry 分别在两台机器上改、且时间戳几乎相同时，会以整文件为单位二选一（落败版本有副本）。
- 只同步 profile patch，不同步 `$DSH_HOME/cordis.patch.yml`（home 层 patch）。
- 项目同步是"逐文件镜像"而不是真合并：两边同时改同一个代码文件时不会做三方合并，只会留副本。代码项目将来更合适的做法是 git（见下）。
- 超过 1 MB 的项目文件会被跳过（只记状态，不报错）。
- 每次 `/v1/hello` 都会重扫项目目录，项目很大时会有点开销。

## 后续

- 代码类项目的合并交给 git：`git bundle` 经现有通道交换，或用 `syncMode: 'git'` 让插件只做 commit/fetch/merge，而不是字节级镜像。
- 会话可见性：`sessions/` 是每机 JSONL 且含本机绝对路径，要共享需要一层只读镜像。

## 目录

```
index.js            Host 插件入口（ctx.effect 管理生命周期）
lib/paths.js        DSH_HOME / profile / patch / 凭据 / preset 路径
lib/config.js       本地配置的读写与归一化
lib/units.js        同步单元的枚举、哈希、清单 + 可移植 spec 判断
lib/apply.js        单元落地（patch 写文件 / cred 走服务 / preset 写文件）+ 插件集补齐
lib/http.js         对端 HTTP 传输（token 鉴权）
lib/sync.js         同步引擎：观察、拉取、推送、冲突判定、插件集通告
test/peer.mjs       独立双节点验证脚本（假 credentials + 假 pluginManager）
```
