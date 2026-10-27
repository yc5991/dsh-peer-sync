"""Render the two-machine architecture of dsh-peer-sync as a PNG.

Kept as a script rather than a hand-drawn file so the picture can be re-rendered
when a box changes: the layout constants are the only thing that has to be
adjusted, and every string below is a fact taken from the code, not a wish.
"""

from PIL import Image, ImageDraw, ImageFont

W, H = 1760, 1240
BG = "#F6F7F9"
INK = "#1D2230"
MUTED = "#5B6472"
LINE = "#D5DAE2"
WHITE = "#FFFFFF"

WIN_FILL, WIN_LINE = "#EDF3FF", "#7FA6E6"
MAC_FILL, MAC_LINE = "#EFFAF2", "#6FBF8B"
LINK_FILL, LINK_LINE = "#FFF6E3", "#DCAF52"
DONE, PARTIAL, TODO = "#1F9D55", "#C77700", "#8B93A1"

FONT = "C:/Windows/Fonts/msyh.ttc"
FONT_B = "C:/Windows/Fonts/msyhbd.ttc"


def font(size, bold=False):
    return ImageFont.truetype(FONT_B if bold else FONT, size)


img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)


def text(x, y, s, size=15, color=INK, bold=False, anchor="la"):
    d.text((x, y), s, font=font(size, bold), fill=color, anchor=anchor)


def box(x, y, w, h, fill=WHITE, line=LINE, radius=10, width=2):
    d.rounded_rectangle([x, y, x + w, y + h], radius=radius, fill=fill, outline=line, width=width)


def dot(x, y, color, r=6):
    d.ellipse([x - r, y - r, x + r, y + r], fill=color)


def arrow(x1, y1, x2, y2, color="#7A8494", width=2, head=9):
    d.line([x1, y1, x2, y2], fill=color, width=width)
    if x2 == x1:
        d.polygon([(x2, y2), (x2 - head // 2, y2 - head), (x2 + head // 2, y2 - head)], fill=color)
    else:
        d.polygon([(x2, y2), (x2 - head, y2 - head // 2), (x2 - head, y2 + head // 2)], fill=color)


text(56, 40, "dsh-peer-sync 0.5.0", 32, INK, bold=True)
text(56, 84, "两台 DSH 通过直连网线互通：配置同步、会话可见、远程投递、项目挂载", 17, MUTED)
text(W - 56, 46, "0.5.0 · 2026-10-27", 15, MUTED, anchor="ra")

# ---------------------------------------------------------------- two engines
COL_W = 640
BOX_H = 66
GAP = 11
TOP = 176

BOXES = [
    ("index.js", "生命周期：ctx.effect 启停、面板快照注入"),
    ("discovery.js", "UDP:4401 广播通告 + 发现对端"),
    ("http.js", "路由与认证：/v1/* 头令牌、/dav Basic"),
    ("sync.js", "同步引擎：15s tick、三方合并、投递与会话"),
    ("sessions.js", "会话通告与标题（sessionQuery + 投影文件）"),
    ("webdav.js", "把共享目录暴露成 WebDAV"),
    ("client.js", "设置面板：对端、插件集、会话（远程/镜像）"),
]


def column(x, title, sub, fill, line, port):
    box(x, TOP - 70, COL_W, 56, fill=fill, line=line, radius=12)
    text(x + 16, TOP - 62, title, 18, INK, bold=True)
    text(x + COL_W - 16, TOP - 57, port, 14, MUTED, anchor="ra")
    text(x + 16, TOP - 34, sub, 12, MUTED)
    for i, (name, desc) in enumerate(BOXES):
        y = TOP + i * (BOX_H + GAP)
        box(x, y, COL_W, BOX_H, fill=WHITE, line=LINE)
        text(x + 14, y + 10, name, 15, INK, bold=True)
        text(x + 14, y + 34, desc, 13, MUTED)
        dot(x + COL_W - 16, y + 33, DONE if i not in (4, 6) else PARTIAL)


column(56, "Windows 实例", "C:\\Users\\user\\Documents\\…\\dsh-peer-sync", WIN_FILL, WIN_LINE, "10.77.0.1:4400")
column(W - 56 - COL_W, "macOS 实例", "~/.dsh/profiles/desktop/node_modules/dsh-peer-sync", MAC_FILL, MAC_LINE, "10.77.0.2:4399")

# ------------------------------------------------------------------ the link
LX = 56 + COL_W + 40
LW = W - 56 - COL_W - 40 - LX
box(LX, TOP - 70, LW, 70 + len(BOXES) * (BOX_H + GAP) - GAP, fill=LINK_FILL, line=LINK_LINE, radius=12)
text(LX + 16, TOP - 60, "直连链路（无 SMB、无账号）", 16, INK, bold=True)

FLOWS = [
    ("UDP :4401", "广播发现，令牌指纹互认", "双向"),
    ("POST /v1/pair", "各发一枚专用密钥（0.4.0）", "→"),
    ("GET /v1/hello", "单元清单 + 通告 + build", "双向"),
    ("POST /v1/remote/prompt", "投递到对端会话，对端额度执行", "→"),
    ("GET /v1/session", "按 id 取会话日志（只读）", "←"),
    ("WebDAV /dav", "挂载共享目录，实时读写", "双向"),
]

fy = TOP + 6
for name, desc, direction in FLOWS:
    text(LX + 18, fy, name, 14, INK, bold=True)
    text(LX + LW - 18, fy + 1, direction, 13, MUTED, anchor="ra")
    text(LX + 18, fy + 22, desc, 12, MUTED)
    fy += 66

# connect the link to both engines
for yy in (TOP + 20, TOP + 150, TOP + 290, TOP + 430):
    arrow(56 + COL_W + 6, yy, LX - 6, yy, color="#9AA4B4")
    arrow(LX + LW + 6, yy, W - 56 - COL_W - 6, yy, color="#9AA4B4")

# --------------------------------------------------------------- auth strip
AY = TOP + len(BOXES) * (BOX_H + GAP) + 34
box(56, AY, W - 112, 96, fill=WHITE, line=LINE, radius=12)
text(72, AY + 12, "信任模型", 16, INK, bold=True)

AUTH = [
    ("共享 token", "旧协议 / WebDAV 挂载", PARTIAL),
    ("每对一枚密钥", "pair 时互发，入站按密钥认人", DONE),
    ("revoked", "入站 403、出站不联系、挂载一并拒", DONE),
]
ax = 200
for name, desc, color in AUTH:
    box(ax, AY + 24, 380, 58, fill="#FBFCFE", line=LINE, radius=10)
    text(ax + 12, AY + 32, name, 14, INK, bold=True)
    text(ax + 12, AY + 54, desc, 11, MUTED)
    dot(ax + 366, AY + 44, color)
    ax += 400

# ------------------------------------------------------------------- ledger
LY = AY + 128
text(56, LY, "验证账本（这台 Windows + 那台 macOS 实测）", 18, INK, bold=True)

ROWS = [
    ("配置同步：patch 按条目三方合并", "实测：12 槽位互不覆盖", DONE),
    ("会话通告与标题", "10/10 与 7/10，跨机可读", DONE),
    ("跨机取会话日志", "/v1/session → 200 + zstd", DONE),
    ("远程投递 → 回话", "CROSS-MACHINE-OK，4.9s", DONE),
    ("面板投递（同源接口）", "PANEL-OK，19.3s", DONE),
    ("v2 双向发密钥", "13:25 重配对成功，两侧对称", DONE),
    ("撤销 → 403 + 停联", "真实对端：403、DAV 拒、lastSync 冻结", DONE),
    ("审批阻塞 blocked", "真机演练：2.4s 返回，带工具名与审批 id", DONE),
    ("DAV 挂载 + 断线探测", "macOS mounted:true, entries:2", DONE),
    ("设置面板渲染", "真机面板已渲染（用户确认）", DONE),
    ("会话生命周期（建/投/中断/归档）", "建→投→NEW-REMOTE-OK；中断→turn/end；归档本机通", DONE),
    ("在对端归档（跨机）", "入站实测；跨机待对端 0.7.0", PARTIAL),
]

col_x = [72, 72 + (W - 144) // 2]
row_h = 40
for i, (name, note, color) in enumerate(ROWS):
    cx = col_x[0] if i < 6 else col_x[1]
    ry = LY + 34 + (i % 6) * row_h
    dot(cx + 8, ry + 12, color, r=6)
    text(cx + 26, ry + 3, name, 14, INK)
    text(cx + 26, ry + 22, note, 11, MUTED)

# ------------------------------------------------------------------- legend
ly = H - 46
for i, (color, label) in enumerate([(DONE, "已实测"), (PARTIAL, "部分验证 / 仅单测"), (TODO, "未做")]):
    x = 72 + i * 220
    dot(x, ly + 8, color, r=6)
    text(x + 16, ly, label, 13, MUTED)
text(W - 56, ly, "docs/architecture.md 含同图的 Mermaid 源码", 12, MUTED, anchor="ra")

img.save("docs/architecture.png")
print("wrote docs/architecture.png", img.size)
