# -*- coding: utf-8 -*-
"""
make-icons.py — 生成暖屿的安卓图标（零外部素材，全部用 Pillow 画）

图意：日出时的暖色海面托着一颗圆。
  背景 = 暖橙渐变（海的暖光）
  主体 = 米白圆环里一颗珊瑚色光球（屿）

产出：
  android/app/src/main/res/mipmap-*/ic_launcher.png          (旧式图标，含圆角方底)
  android/app/src/main/res/mipmap-*/ic_launcher_round.png    (旧式圆形图标)
  android/app/src/main/res/mipmap-*/ic_launcher_foreground.png (自适应图标前景，透明底)
  app/icons/icon-192.png, icon-512.png                        (PWA 用)

用法: python _scripts/make-icons.py
"""
import os
import sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(ROOT, 'android', 'app', 'src', 'main', 'res')
APPICONS = os.path.join(ROOT, 'app', 'icons')

# 暖屿配色
C_DEEP = (232, 93, 61)      # #E85D3D
C_MAIN = (255, 122, 89)     # #FF7A59
C_LIGHT = (255, 176, 138)   # #FFB08A
C_CREAM = (255, 246, 238)   # #FFF6EE
C_GLOW = (255, 211, 190)    # #FFD3BE

DENS = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
FGS = {'mdpi': 108, 'hdpi': 162, 'xhdpi': 216, 'xxhdpi': 324, 'xxxhdpi': 432}

SS = 4  # 超采样倍数，画完再缩，边缘才干净


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def gradient_bg(size):
    """对角暖橙渐变，右下更深一点，像斜射的夕阳"""
    n = size
    y, x = np.mgrid[0:n, 0:n]
    t = (x / max(1, n - 1) * 0.45 + y / max(1, n - 1) * 0.55)
    t = np.clip(t, 0, 1)
    # 三段渐变：亮 → 主 → 深
    t1 = np.clip(t / 0.5, 0, 1)
    t2 = np.clip((t - 0.5) / 0.5, 0, 1)
    arr = np.zeros((n, n, 3), dtype=np.float64)
    for i in range(3):
        left = C_LIGHT[i] + (C_MAIN[i] - C_LIGHT[i]) * t1
        right = C_MAIN[i] + (C_DEEP[i] - C_MAIN[i]) * t2
        arr[:, :, i] = np.where(t < 0.5, left, right)
    img = Image.fromarray(arr.astype(np.uint8), 'RGB').convert('RGBA')

    # 左上角一点柔光
    glow = Image.new('L', (n, n), 0)
    gd = ImageDraw.Draw(glow)
    gd.ellipse([-n * 0.35, -n * 0.5, n * 0.75, n * 0.45], fill=90)
    glow = glow.filter(ImageFilter.GaussianBlur(n * 0.16))
    light = Image.new('RGBA', (n, n), (255, 235, 220, 255))
    img = Image.composite(light, img, glow.point(lambda v: int(v * 0.55)))
    return img


def rounded_mask(size, radius_ratio=0.225):
    m = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(m)
    r = int(size * radius_ratio)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=255)
    return m


def circle_mask(size):
    m = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(m)
    d.ellipse([0, 0, size - 1, size - 1], fill=255)
    return m


def _disc_mask(size, cx, cy, r):
    y, x = np.mgrid[0:size, 0:size]
    hit = ((x - cx) ** 2 + (y - cy) ** 2) <= r * r
    return Image.fromarray((hit * 255).astype(np.uint8), 'L')


def _radial(size, cx, cy, r0, c_in, c_out, power=1.0):
    """纯 numpy 径向渐变：边缘由 mask 裁，不用模糊，所以不会有灰边"""
    y, x = np.mgrid[0:size, 0:size]
    d = np.sqrt((x - cx) ** 2 + (y - cy) ** 2) / max(1e-6, r0)
    d = np.clip(d, 0, 1) ** power
    arr = np.zeros((size, size, 3), dtype=np.float64)
    for i in range(3):
        arr[:, :, i] = c_in[i] + (c_out[i] - c_in[i]) * d
    return Image.fromarray(arr.round().astype(np.uint8), 'RGB').convert('RGBA')


def orb_layer(canvas, cx, cy, radius):
    """在 canvas 上画一颗暖屿圆：珊瑚光晕 + 米白环 + 立体光球"""
    S = canvas.size[0]
    R = radius

    # ① 外层珊瑚光晕（低透明度的径向衰减，靠 alpha 而不是模糊）
    y, x = np.mgrid[0:S, 0:S]
    dist = np.sqrt((x - cx) ** 2 + (y - cy) ** 2)
    halo = np.clip(1.0 - (dist - R * 0.92) / (R * 0.55), 0, 1) ** 2.0
    halo_img = Image.new('RGBA', (S, S), C_MAIN + (0,))
    halo_img.putalpha(Image.fromarray((halo * 66).astype(np.uint8), 'L'))
    solid = Image.new('RGBA', (S, S), C_MAIN + (255,))
    canvas.alpha_composite(Image.composite(solid, halo_img, halo_img.getchannel('A')))

    # ② 米白圆环（外圈那层壳）
    ring_r = R
    shell = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    shell.paste(Image.new('RGBA', (S, S), C_CREAM + (255,)), (0, 0), _disc_mask(S, cx, cy, ring_r))
    canvas.alpha_composite(shell)

    # ③ 立体光球：光源在左上，所以渐变中心往左上偏
    ball_r = R * 0.755
    hx, hy = cx - ball_r * 0.30, cy - ball_r * 0.34
    ball = _radial(S, hx, hy, ball_r * 1.28, (255, 226, 210), C_DEEP, power=1.0)
    ball.putalpha(_disc_mask(S, cx, cy, ball_r))
    canvas.alpha_composite(ball)

    # ④ 左上高光：只靠 alpha 衰减，不加硬边遮罩，否则会像一个贴上去的小圆
    sx, sy = cx - ball_r * 0.34, cy - ball_r * 0.40
    yy, xx = np.mgrid[0:S, 0:S]
    sd = np.sqrt((xx - sx) ** 2 + (yy - sy) ** 2) / (ball_r * 0.62)
    sa = np.clip(1.0 - sd, 0, 1) ** 2.1
    # 只在球面范围内，且越靠边越弱
    inside = np.clip(1.0 - ((xx - cx) ** 2 + (yy - cy) ** 2) / (ball_r ** 2), 0, 1) ** 0.5
    spec = Image.new('RGBA', (S, S), (255, 255, 255, 0))
    spec.putalpha(Image.fromarray((sa * inside * 150).astype(np.uint8), 'L'))
    canvas.alpha_composite(spec)

    return canvas


def make_legacy(size, round_icon=False):
    """旧式图标：暖橙底 + 圆，整体裁成圆角方/圆形"""
    S = size * SS
    bg = gradient_bg(S)
    bg = orb_layer(bg, S / 2, S / 2, S * 0.315)
    mask = circle_mask(S) if round_icon else rounded_mask(S)
    out = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    out.paste(bg, (0, 0), mask)
    return out.resize((size, size), Image.LANCZOS)


def make_foreground(size):
    """自适应图标前景：透明底，圆画在 62% 安全区内"""
    S = size * SS
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    img = orb_layer(img, S / 2, S / 2, S * 0.320)
    return img.resize((size, size), Image.LANCZOS)


def save(img, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, 'PNG', optimize=True)
    print('  %-58s %6d B' % (os.path.relpath(path, ROOT), os.path.getsize(path)))


def main():
    print('暖屿图标生成中…')
    for d, px in DENS.items():
        folder = os.path.join(RES, 'mipmap-' + d)
        save(make_legacy(px, False), os.path.join(folder, 'ic_launcher.png'))
        save(make_legacy(px, True), os.path.join(folder, 'ic_launcher_round.png'))
    for d, px in FGS.items():
        folder = os.path.join(RES, 'mipmap-' + d)
        save(make_foreground(px), os.path.join(folder, 'ic_launcher_foreground.png'))

    save(make_legacy(192, False), os.path.join(APPICONS, 'icon-192.png'))
    save(make_legacy(512, False), os.path.join(APPICONS, 'icon-512.png'))
    print('完成。')


if __name__ == '__main__':
    main()
