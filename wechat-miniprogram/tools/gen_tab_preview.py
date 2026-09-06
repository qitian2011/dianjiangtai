# -*- coding: utf-8 -*-
"""生成 tabBar 图标两态/两底色预览对照图（验收用）。
运行：python gen_tab_preview.py -> 输出 tab_preview.png（覆盖旧图）
"""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, '..', 'assets', 'tab')
OUT = os.path.join(ROOT, 'tab_preview.png')

NAMES = [('roll', '点名'), ('page', '传呼'), ('roster', '名单'), ('tt', '课表'), ('set', '设置')]
SCALE = 4                      # 图标放大倍数用于目检
PAD = 18
CELL_W, CELL_H = 81 * SCALE + 8, 81 * SCALE + 8
HEAD = 46                      # 顶部标题区
GAP = 26                       # 两组间隔

# 模拟 tabBar 底色
LIGHT_BG = '#F2F4FA'; LIGHT_BAR = '#FFFFFF'
DARK_BG = '#12151D';  DARK_BAR = '#1E222D'

def font(sz):
    for fp in (r'C:\Windows\Fonts\msyh.ttc', r'C:\Windows\Fonts\msyhbd.ttc', r'C:\Windows\Fonts\simhei.ttf'):
        if os.path.exists(fp):
            try: return ImageFont.truetype(fp, sz)
            except Exception: pass
    return ImageFont.load_default()

def cell(img, icon, selected, dark):
    """在画布 img 上贴一个图标格子，模拟 tabBar 选中态配色。"""
    d = ImageDraw.Draw(img)
    bar = DARK_BAR if dark else LIGHT_BAR
    d.rectangle((PAD, PAD, CELL_W - PAD + 2 * PAD - 2, CELL_H - PAD), fill=bar)   # 简化：底色画在整幅背景上
    return d

def compose():
    # 画布宽度 = 标题 + 两行格子
    row_w = PAD + (CELL_W) * 5
    W = max(row_w + PAD, 620)
    H = HEAD + (CELL_H) * 2 + GAP + 30
    img = Image.new('RGB', (W, H), LIGHT_BG)
    d = ImageDraw.Draw(img)
    f_title = font(24)
    f_name = font(17)
    d.text((PAD, 10), 'tabBar 图标预览（上：浅色/灰·蓝  下：深色/灰·亮蓝）', font=f_title, fill='#17326B')

    # —— 行1：浅色底 ——
    y0 = HEAD
    for i, (key, cn) in enumerate(NAMES):
        x = PAD + i * CELL_W
        # 模拟浅色 tab 条
        d.rounded_rectangle((x, y0, x + CELL_W - 6, y0 + CELL_H - 6), radius=14, fill=LIGHT_BAR)
        ic = Image.open(os.path.join(SRC, key + '.png')).convert('RGBA')
        ic = ic.resize((81 * SCALE, 81 * SCALE), Image.LANCZOS)
        img.paste(ic, (x + 3, y0 + 3), ic)
        # 模拟"点名 未选中/选中"（第2个 tab 当选中）
        sel = (i == 1)
        col = '#2E8BE0' if sel else '#8A93A8'
        txt = cn
        tw = d.textlength(txt, font=f_name)
        d.text((x + (CELL_W - 6 - tw) / 2, y0 + CELL_H - 24), txt, font=f_name, fill=col)
        # 选中蓝点提示
        if sel:
            d.ellipse((x + CELL_W / 2 - 3, y0 + CELL_H - 42, x + CELL_W / 2 + 3, y0 + CELL_H - 36), fill='#2E8BE0')

    # —— 行2：深色底 ——
    # 重画底色为深色（简单起见整幅下半铺深色）
    y1 = HEAD + CELL_H + GAP
    d.rectangle((0, y1 - GAP // 2, W, H), fill=DARK_BG)
    for i, (key, cn) in enumerate(NAMES):
        x = PAD + i * CELL_W
        d.rounded_rectangle((x, y1, x + CELL_W - 6, y1 + CELL_H - 6), radius=14, fill=DARK_BAR)
        ic = Image.open(os.path.join(SRC, key + '-active.png')).convert('RGBA')
        ic = ic.resize((81 * SCALE, 81 * SCALE), Image.LANCZOS)
        img.paste(ic, (x + 3, y1 + 3), ic)
        sel = (i == 4)
        col = '#6BB6F5' if sel else '#8A93A8'
        txt = cn
        tw = d.textlength(txt, font=f_name)
        d.text((x + (CELL_W - 6 - tw) / 2, y1 + CELL_H - 24), txt, font=f_name, fill=col)
        if sel:
            d.ellipse((x + CELL_W / 2 - 3, y1 + CELL_H - 42, x + CELL_W / 2 + 3, y1 + CELL_H - 36), fill='#6BB6F5')

    img.save(OUT)
    print('saved ->', os.path.abspath(OUT), img.size)

if __name__ == '__main__':
    compose()
