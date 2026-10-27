"""Render the two decision flows as a PNG: one sync tick, one remote prompt.

Same reasoning as render-architecture.py: the flow is code-derived, so it lives
in a script that can be re-rendered instead of in a drawing nobody can update.
"""

from PIL import Image, ImageDraw, ImageFont

W, H = 1760, 1330
BG = "#F6F7F9"
INK, MUTED, LINE, WHITE = "#1D2230", "#5B6472", "#D5DAE2", "#FFFFFF"
AMBER_FILL, AMBER_LINE = "#FFF6E3", "#DCAF52"
DIAMOND_FILL = "#FBFCFE"
DONE, PARTIAL = "#1F9D55", "#C77700"

FONT = "C:/Windows/Fonts/msyh.ttc"
FONT_B = "C:/Windows/Fonts/msyhbd.ttc"

img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)


def font(size, bold=False):
    return ImageFont.truetype(FONT_B if bold else FONT, size)


def text(x, y, s, size=14, color=INK, bold=False, anchor="la"):
    d.text((x, y), s, font=font(size, bold), fill=color, anchor=anchor)


def box(x, y, w, h, fill=WHITE, line=LINE, radius=10):
    d.rounded_rectangle([x, y, x + w, y + h], radius=radius, fill=fill, outline=line, width=2)


def dot(x, y, color, r=6):
    d.ellipse([x - r, y - r, x + r, y + r], fill=color)


text(56, 36, "跑起来是什么样：两条主流程", 30, INK, bold=True)
text(56, 78, "左边是一次同步 tick，右边是一次远程投递；菱形是真正的判断分支，分支都在代码里", 16, MUTED)
text(W - 56, 44, "dsh-peer-sync 0.5.0 · 2026-10-27", 14, MUTED, anchor="ra")

COL_W = 760
LEFT_X, RIGHT_X = 56, W - 56 - COL_W
TOP = 140


def step(x, w, y, title, desc="", h=56, fill=WHITE, line=LINE, status=DONE):
    box(x, y, w, h, fill=fill, line=line)
    text(x + 14, y + 9, title, 14, INK, bold=True)
    if desc:
        text(x + 14, y + 32, desc, 11, MUTED)
    dot(x + w - 14, y + h - 14, status, r=5)
    return y + h


def gap(y, label="", x=0, w=0, size=11):
    if label:
        text(x + 24, y + 6, label, size, MUTED)
    return y + 34


def diamond(x, w, y, title, desc="", h=84, fill=DIAMOND_FILL, status=None):
    cx, cy = x + w / 2, y + h / 2
    d.polygon([(cx, y), (x + w, cy), (cx, y + h), (x, cy)], fill=fill, outline="#9AA4B4", width=2)
    text(cx, y + 22, title, 13, INK, bold=True, anchor="ma")
    if desc:
        text(cx, y + 44, desc, 10, MUTED, anchor="ma")
    if status:
        dot(x + w - 18, cy, status, r=5)
    return y + h


# ------------------------------------------------------------------ left: tick
text(LEFT_X, TOP - 30, "① 同步 tick（每 15 秒，或本机文件变动后）", 17, INK, bold=True)
x, w = LEFT_X, COL_W
y = TOP
y = step(x, w, y, "dsh 启动 → index.js 的 ctx.effect 调用 start()", "配置只在本地：identity / token / listen 不参与同步")
y = gap(y)
y = step(x, w, y, "loadConfig() + readState()", "state.json 记住上次达成一致的哈希（bases / patchBase）")
y = gap(y)
y = step(x, w, y, "listen() 绑定直连地址，UDP:4401 开始广播", "端口占用时重试 12 次（profile 重载的旧实例还在关）")
y = gap(y)
y = diamond(x, w, y, "收到对端 beacon？", "带令牌指纹与 http 端口，用于互认")
y = gap(y, "否：等下一轮", x, w)
box(x + 20, y, w - 40, 44, fill="#FAFBFC")
text(x + 34, y + 8, "是 → POST /v1/pair 交换凭据", 12, INK, bold=True)
text(x + 34, y + 26, "0.4.0：各发一枚专用密钥；旧对端回落到共享 token", 10, MUTED)
y += 44
y = gap(y)
y = step(x, w, y, "GET /v1/hello：单元清单 + 会话通告 + deny + build", "对端身份先过校验：共享 token 或该对端的 inbound 密钥")
y = gap(y)
y = diamond(x, w, y, "哪些单元变了？", "本机哈希 / 对端哈希 / 上次一致，两两比较")
y = gap(y)
for label, desc in [
    ("只有对端变了 → 直接拉取", "落盘前留 .conflict 副本，绝不整文件覆盖"),
    ("只有本机变了 → 推给对端", "同一份内容不重复推（哈希相同即跳过）"),
    ("两边都变了 → 按 mtime 定胜负", "patch：按条目三方合并；其余单元留副本"),
]:
    box(x + 20, y, w - 40, 46, fill="#FAFBFC")
    text(x + 34, y + 7, label, 12, INK, bold=True)
    text(x + 34, y + 26, desc, 10, MUTED)
    y += 52
y = gap(y)
y = step(x, w, y, "写 status.json（面板读它）+ 会话通告缓存", "含对端 reachable、最近同步时间、dav 探测结果")

# --------------------------------------------------------------- right: prompt
text(RIGHT_X, TOP - 30, "② 远程投递（POST /v1/remote/prompt）", 17, INK, bold=True)
x2, w2 = RIGHT_X, COL_W
y2 = TOP
y2 = step(x2, w2, y2, "调用方带上 x-peer-token 请求投递", "body: sessionId / text / wait / waitSeconds", fill=AMBER_FILL, line=AMBER_LINE)
y2 = gap(y2)
y2 = diamond(x2, w2, y2, "凭据能认出是谁？", "共享 token=匿名；专用密钥=知道是哪台")
y2 = gap(y2, "认不出 → 401 unauthorized", x2, w2)
y2 = diamond(x2, w2, y2, "该 peer 是 revoked？", "只有认出身份才问得出这个问题")
y2 = gap(y2, "是 → 403 peer-revoked（连 /dav 一起拒）", x2, w2)
y2 = diamond(x2, w2, y2, "remotePrompts === allow？", "默认 off；同意落在被请求的那台机器上")
y2 = gap(y2, "否 → 403 remote-prompts-disabled", x2, w2)
y2 = step(x2, w2, y2, "follow 探针：拿 cursor，判断对面有没有未结束的回合", "有未配对的 turn/start → busyBefore=true，这条会排队")
y2 = gap(y2)
y2 = step(x2, w2, y2, "controller.prompt(request, signal) → accepted", "requestId 是幂等键，重发不会插两条")
y2 = gap(y2)
y2 = diamond(x2, w2, y2, "每 1.2 秒取一次窗口，看到 assistant/message？", "在最后一个 turn/start 之后配对，不做 seq 猜测")
y2 = gap(y2, "是 → replied:true，reply=文本，结束", x2, w2)
y2 = diamond(x2, w2, y2, "有未配对的 approval/asked？", "连续两次轮询都挂着 → 提前返回，不把预算耗完", status=PARTIAL)
y2 = gap(y2, "是 → blocked=awaiting-owner-approval，远程无法推进", x2, w2)
y2 = diamond(x2, w2, y2, "看到 turn/start 了吗？", "窗口可能从回合中间开始，所以只表示「看见了」")
y2 = gap(y2, "没看见且对面本来就忙 → queued + reason=agent-busy", x2, w2)
box(x2 + 20, y2, w2 - 40, 46, fill="#FAFBFC")
text(x2 + 34, y2 + 7, "其余情况 → reason=turn-in-progress，把 waitSeconds 调大再等", 12, INK, bold=True)
text(x2 + 34, y2 + 26, "调用方该做的动作由 reason 决定，不需要它去猜状态", 10, MUTED)

# ---------------------------------------------------------------------- legend
ly = H - 44
for i, (color, label) in enumerate([(DONE, "该步在真机走过"), (PARTIAL, "仅单测，真机没走过")]):
    xl = 72 + i * 260
    dot(xl, ly + 8, color, r=6)
    text(xl + 16, ly, label, 13, MUTED)
text(W - 56, ly, "圆点 = 该步的验证程度", 12, MUTED, anchor="ra")

img.save("docs/flow.png")
print("wrote docs/flow.png", img.size)
