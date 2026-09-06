# -*- coding: utf-8 -*-
"""生成点将台小程序 tabBar 图标（5 个 × 灰/选中蓝两态 = 10 张 PNG, 81x81）。
风格：统一圆角几何「线性+填充」混合，4x 超采样抗锯齿，标准 8-bit RGBA（无冗余 chunk）。
造型语义：
  点名 roll  = 骰子（随机抽取）
  传呼 page = 寻呼令牌（BP 机：机身 + 天线 + 屏幕条 + 按键）
  名单 roster = 清单卡片 + 三行
  课表 tt    = 日历页 + 2x2 网格
  设置 set   = 12 齿齿轮（外齿 + 轮盘 + 中心通孔）
运行：python gen_tab_icons.py  -> 输出到 ../assets/tab/
"""
import math
import os
from PIL import Image, ImageDraw

SIZE = 81
SS = 4                 # 超采样倍率
C = SIZE * SS // 2     # 中心（162）
GRAY = (138, 147, 168, 255)    # 未选中 #8A93A8
BLUE = (46, 139, 224, 255)     # 选中   #2E8BE0（白底/深底均清晰）
TRANS = (0, 0, 0, 0)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'tab')


def canvas():
    img = Image.new('RGBA', (SIZE * SS, SIZE * SS), TRANS)
    return img, ImageDraw.Draw(img)


def save(img, name):
    img = img.resize((SIZE, SIZE), Image.LANCZOS)
    os.makedirs(OUT, exist_ok=True)
    # 标准 PNG：RGBA 8bit，去除冗余元数据，保证各端渲染一致
    img.save(os.path.join(OUT, name), optimize=True)
    print('saved', name)


def dice(d, col):                 # 点名：圆角方框 + 三点（随机感）
    d.rounded_rectangle((C - 60, C - 60, C + 60, C + 60), radius=34, outline=col, width=13)
    for dx, dy in ((-22, -22), (0, 0), (22, 22)):
        d.ellipse((C + dx - 11, C + dy - 11, C + dx + 11, C + dy + 11), fill=col)


def pager(d, col):                # 传呼：寻呼令牌（BP 机）——机身 + 天线 + 屏幕条 + 按键
    # 天线：竖杆 + 顶球
    d.line((C, C - 34, C, C - 54), fill=col, width=10)
    d.ellipse((C - 10, C - 64, C + 10, C - 44), fill=col)
    # 机身（竖长圆角牌）
    d.rounded_rectangle((C - 52, C - 34, C + 52, C + 60), radius=20, outline=col, width=13)
    # 屏幕横条（顶部信息区）
    d.rounded_rectangle((C - 31, C - 20, C + 31, C - 6), radius=9, fill=col)
    # 按键（底部呼叫钮）
    d.ellipse((C - 9, C + 30, C + 9, C + 48), fill=col)


def roster(d, col):               # 名单：清单卡片 + 三行
    d.rounded_rectangle((C - 66, C - 54, C + 66, C + 54), radius=18, outline=col, width=13)
    for i, y in enumerate((-26, 0, 26)):
        w = 86 if i == 0 else 66
        d.rounded_rectangle((C - 42, C + y - 8, C - 42 + w, C + y + 8), radius=8, fill=col)


def timetable(d, col):            # 课表：日历页 + 2x2 网格
    d.rounded_rectangle((C - 64, C - 58, C + 64, C + 58), radius=16, outline=col, width=13)
    d.rounded_rectangle((C - 64, C - 58, C + 64, C - 22), radius=16, fill=col)  # 顶部月历头
    d.line((C - 36, C + 2, C + 36, C + 2), fill=col, width=10)
    d.line((C - 36, C + 26, C + 36, C + 26), fill=col, width=10)
    d.line((C, C - 10, C, C + 50), fill=col, width=10)


def gear(d, col):                 # 设置：12 齿齿轮（外齿梯形 + 轮盘 + 中心通孔）
    RIN, ROUT, TEETH = 44, 62, 12          # 齿根半径 / 齿顶半径 / 齿数
    HALF = math.radians(6.5)               # 单齿半角（留齿隙）
    step = 2 * math.pi / TEETH
    for i in range(TEETH):
        a0 = i * step
        a1, a2 = a0 - HALF, a0 + HALF
        pts = []
        for (r, a) in ((RIN, a1), (RIN, a2), (ROUT, a2), (ROUT, a1)):
            pts.append((C + r * math.cos(a), C + r * math.sin(a)))
        d.polygon(pts, fill=col)
    # 轮盘（盖住齿根，形成连续圆轮）
    d.ellipse((C - RIN, C - RIN, C + RIN, C + RIN), fill=col)
    # 中心通孔（覆盖写入透明像素 -> 镂空）
    d.ellipse((C - 16, C - 16, C + 16, C + 16), fill=TRANS)


def build(fn, name):
    for suffix, col in (('', GRAY), ('-active', BLUE)):
        img, d = canvas()
        fn(d, col)
        save(img, name + suffix + '.png')


def main():
    build(dice, 'roll')
    build(pager, 'page')
    build(roster, 'roster')
    build(timetable, 'tt')
    build(gear, 'set')
    print('done ->', os.path.abspath(OUT))


if __name__ == '__main__':
    main()
