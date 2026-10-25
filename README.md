# dsh-peer-sync

在两台用**网线直连**的机器之间（这里是 Windows `10.77.0.1` ↔ macOS `10.77.0.2`）保持 dsh 的配置一致，不用再手动 scp/粘贴。

同一份代码在两边各装一次，两端是对称的：任何一边改了配置，另一边在几秒到 15 秒内自动跟上。

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
  "token": "两台机器必须一致的共享密钥",
  "listen": { "host": "10.77.0.1", "port": 4400 },
  "peers": [{ "name": "mac", "url": "http://10.77.0.2:4400" }],
  "autoPush": true,
  "autoPull": true,
  "pullIntervalMs": 15000,
  "timeoutMs": 4000,
  "sync": { "patch": true, "credentials": true, "presets": true, "bundles": true },
  "bundlesMode": "detect"
}
```

因为 `cordis.patch.yml` 本身是被同步的对象，插件的 Loader 行**故意不带 config** —— 身份、监听地址、密钥只存在这个本地文件里，不会被对端覆盖。

## 安装

Windows（已完成）：

```powershell
# 1. 包已经在 profile 里了：dsh.profile.bundles 含 dsh-peer-sync，依赖是 link: 指向本目录
# 2. 配置已经写在 ~/.dsh/peer-sync/config.json
# 3. 重启一次 dsh，让单实例干净地绑定端口
```

macOS：

```bash
# 1. 把本目录拷到 Mac（不要拷 node_modules、不要拷 test/）
scp -r dsh-peer-sync mac:~/dsh-peer-sync

# 2. 装依赖（只用到 yaml）
cd ~/dsh-peer-sync && pnpm install

# 3. 写本机配置：self=mac，listen 10.77.0.2:4400，peers 指向 win
mkdir -p ~/.dsh/peer-sync

# 4. 让 Mac 上的 dsh 装这个包（agent 里执行）：
#    plugin_manager  action=install_bundle  target=/Users/<你>/dsh-peer-sync

# 5. 重启 dsh
```

两台机器的 `token` 必须相同。

## 防火墙（只放行网线那一侧，一次即可）

Windows（管理员 PowerShell）：

```powershell
New-NetFirewallRule -DisplayName "dsh-peer-sync" -Direction Inbound -Protocol TCP `
  -LocalAddress 10.77.0.1 -LocalPort 4400 -Action Allow -Profile Private
```

macOS 如果开了"应用防火墙"，首次绑定端口时允许 dsh（或 `node`）接收入站连接。

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
