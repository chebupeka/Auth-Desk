"""Готовит кадры руки со штампом, курсор-руку и сопутствующие картинки из img/ для public/assets.

Запуск из корня проекта:  python scripts/prepare-hand-assets.py [--anchor 0.351,0.349] [--base 0.441]
  --anchor  где в исходном кадре центр основания штампа (доли ширины и высоты), по умолчанию 0.351,0.349
  --base    какую долю ширины исходного кадра занимает основание штампа, по умолчанию 0.441
Нужны Python 3, Pillow и numpy. Однотонные (пустые) картинки пропускаются — тогда сайт
показывает обычный штамп без руки, а без основной позы курсора — системный курсор.
"""
import argparse
import json
import pathlib
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / 'img'
OUT = ROOT / 'public' / 'assets'
HAND_OUT = OUT / 'hand'
FRAMES = ['raised', 'pressing', 'rock', 'lift', 'blur']
# без этих кадров анимация не собирается; rock и blur подменяются соседними
REQUIRED = {'raised', 'pressing', 'lift'}
FALLBACK = {'rock': 'pressing', 'blur': 'raised'}
MAX_SIDE = 1100

CURSOR_OUT = OUT / 'cursor'
# Горячая точка каждой позы курсора в исходном кадре (доли ширины и высоты): кончик указательного
# пальца, место, где сошлись пальцы, и кончик ручки. Если перегенерировали картинки — перемерьте
CURSOR_POSES = {
    'pointer': (0.2456, 0.1675),
    'grab': (0.2454, 0.2820),
    'pen': (0.2114, 0.2354),
}
# до какой ширины ужимается исходный кадр: хватает на курсор шириной до 400 CSS-пикселей при плотности 2x
CURSOR_FRAME = 800


def load(name):
    path = SRC / name
    if not path.exists():
        print(f'  нет файла {name}')
        return None
    img = Image.open(path).convert('RGB')
    if len(img.getcolors(8) or range(9)) <= 2:
        print(f'  {name}: картинка однотонная — пропускаю')
        return None
    return img


def cutout(img, lo=10.0, hi=34.0, seed_thresh=16.0, holes=False):
    """Вырезает объект с ровного серого фона: фон — серые пиксели, связанные с краем кадра.
    holes=True — ещё и замкнутые просветы фона внутри объекта (например, между пальцами в щепоти)."""
    rgb = np.asarray(img).astype(np.float32)
    h, w, _ = rgb.shape
    border = np.concatenate([rgb[:6].reshape(-1, 3), rgb[-6:].reshape(-1, 3),
                             rgb[:, :6].reshape(-1, 3), rgb[:, -6:].reshape(-1, 3)])
    bg = np.median(border, axis=0)
    dist = np.sqrt(((rgb - bg) ** 2).sum(-1))

    # .copy(): fromarray отдаёт изображение поверх read-only буфера, и floodfill молча ничего не пишет
    candidate = Image.fromarray(np.where(dist < seed_thresh, 255, 0).astype(np.uint8)).copy()
    seeds = [(x, 0) for x in range(0, w, 16)] + [(x, h - 1) for x in range(0, w, 16)] + \
            [(0, y) for y in range(0, h, 16)] + [(w - 1, y) for y in range(0, h, 16)]
    for x, y in seeds:
        if candidate.getpixel((x, y)) == 255:
            ImageDraw.floodfill(candidate, (x, y), 128, thresh=0)
    background = np.asarray(candidate) == 128
    if holes:
        # просвет — крупное серое пятно, не связанное с краем; мелкие серые блики на коже отсекает размыкание
        enclosed = Image.fromarray((np.asarray(candidate) == 255).astype(np.uint8) * 255)
        enclosed = enclosed.filter(ImageFilter.MinFilter(9)).filter(ImageFilter.MaxFilter(9))
        background |= np.asarray(enclosed) > 0

    near = np.asarray(Image.fromarray(background.astype(np.uint8) * 255).filter(ImageFilter.MaxFilter(7))) > 0
    alpha = np.ones((h, w), np.float32)
    soft = np.clip((dist - lo) / (hi - lo), 0, 1)
    alpha[near] = soft[near]
    alpha[background] = 0
    alpha = np.asarray(Image.fromarray((alpha * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.6))).astype(np.float32) / 255

    a = alpha[..., None]
    fg = np.clip(np.where(a > 0.02, (rgb - (1 - a) * bg) / np.maximum(a, 0.02), rgb), 0, 255)
    return Image.fromarray(np.dstack([fg, alpha * 255]).astype(np.uint8), 'RGBA')


def content_box(rgba, threshold=12):
    return rgba.getchannel('A').point(lambda v: 255 if v > threshold else 0).getbbox()


def save(img, path, **options):
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, 'WEBP', quality=86, method=6, **options)
    print(f'  {path.relative_to(ROOT)}  {img.width}x{img.height}  {path.stat().st_size // 1024} КБ')


def prepare_hand(anchor, base_share):
    print('Кадры руки:')
    sources = {name: load(f'hand-stamp-{name}.png') for name in FRAMES}
    missing = REQUIRED - {name for name, img in sources.items() if img is not None}
    if missing:
        print(f'  не хватает кадров: {", ".join(sorted(missing))} — анимацию руки не собираю')
        for stale in [HAND_OUT / 'hand.json']:
            stale.unlink(missing_ok=True)
        return False

    sizes = {img.size for img in sources.values() if img is not None}
    if len(sizes) != 1:
        print(f'  у кадров разный размер {sizes} — их нельзя совместить, анимацию руки не собираю')
        return False
    width, height = sizes.pop()

    cut = {name: cutout(img) for name, img in sources.items() if img is not None}
    # общая рамка для всех кадров, иначе рука будет дёргаться при смене кадра
    boxes = [content_box(img) for img in cut.values()]
    x0 = max(0, min(b[0] for b in boxes) - 8)
    y0 = max(0, min(b[1] for b in boxes) - 8)
    x1 = min(width, max(b[2] for b in boxes) + 8)
    y1 = min(height, max(b[3] for b in boxes) + 8)
    scale = min(1.0, MAX_SIDE / max(x1 - x0, y1 - y0))
    out_size = (round((x1 - x0) * scale), round((y1 - y0) * scale))

    files = {}
    for name in FRAMES:
        source = name if name in cut else FALLBACK[name]
        if source not in cut:
            source = 'raised'
        frame = cut[source].crop((x0, y0, x1, y1)).resize(out_size, Image.LANCZOS)
        save(frame, HAND_OUT / f'{source}.webp')
        files[name] = f'{source}.webp'

    meta = {
        'size': list(out_size),
        'anchor': [round((anchor[0] * width - x0) / (x1 - x0), 4), round((anchor[1] * height - y0) / (y1 - y0), 4)],
        'baseShare': round(base_share * width / (x1 - x0), 4),
        'frames': files,
    }
    (HAND_OUT / 'hand.json').write_text(json.dumps(meta, indent=2), encoding='utf-8')
    print(f'  public/assets/hand/hand.json  якорь {meta["anchor"]}, основание {meta["baseShare"]} ширины кадра')
    return True


def prepare_cursor():
    print('Курсор-рука:')
    poses = {}
    for name, (hot_x, hot_y) in CURSOR_POSES.items():
        img = load(f'hand-cursor-{name}.png')
        if img is None:
            continue
        width, height = img.size
        rgba = cutout(img, holes=True)
        box = content_box(rgba)
        if not box:
            print(f'  hand-cursor-{name}.png: руки не нашлось — пропускаю')
            continue
        x0, y0 = max(0, box[0] - 8), max(0, box[1] - 8)
        x1, y1 = min(width, box[2] + 8), min(height, box[3] + 8)
        scale = CURSOR_FRAME / width
        frame = rgba.crop((x0, y0, x1, y1)).resize((round((x1 - x0) * scale), round((y1 - y0) * scale)), Image.LANCZOS)
        save(frame, CURSOR_OUT / f'{name}.webp')
        # всё в долях ширины исходного кадра: так на сайте размер курсора задаётся одной переменной
        poses[name] = {
            'file': f'{name}.webp',
            'hotspot': [round(hot_x, 4), round(hot_y * height / width, 4)],
            'box': [round(x0 / width, 4), round(y0 / width, 4), round((x1 - x0) / width, 4), round((y1 - y0) / width, 4)],
        }

    if 'pointer' not in poses:
        print('  нет основной позы (pointer) — на сайте останется системный курсор')
        (CURSOR_OUT / 'cursor.json').unlink(missing_ok=True)
        return False
    for name in CURSOR_POSES:
        poses.setdefault(name, poses['pointer'])
    (CURSOR_OUT / 'cursor.json').write_text(json.dumps({'poses': poses}, indent=2), encoding='utf-8')
    print('  public/assets/cursor/cursor.json')
    return True


def prepare_imprint():
    print('Оттиск штампа:')
    img = load('stamp-imprint-frame.png')
    if img is None:
        return False
    rgb = np.asarray(img).astype(np.float32)
    # красная краска на белом: насыщенность краски видна по зелёному каналу
    ink = np.clip((rgb[..., 0] - rgb[..., 1] - 12) / 120, 0, 1)
    rgba = np.dstack([np.full(ink.shape, 179), np.full(ink.shape, 38), np.full(ink.shape, 30), ink * 255]).astype(np.uint8)
    out = Image.fromarray(rgba, 'RGBA')
    box = content_box(out, threshold=20)
    if not box:
        print('  краски не нашлось — пропускаю')
        return False
    out = out.crop(box)
    out.thumbnail((900, 900), Image.LANCZOS)
    save(out, OUT / 'stamp-imprint.webp')
    return True


def prepare_decor():
    print('Предметы для стола:')
    done = []
    for source, target, width in [('stamp-on-desk.png', 'stamp-on-desk.webp', 420), ('ink-pad.png', 'ink-pad.webp', 420)]:
        img = load(source)
        if img is None:
            continue
        rgba = cutout(img)
        box = content_box(rgba)
        if not box:
            print(f'  {source}: объект не найден — пропускаю')
            continue
        rgba = rgba.crop(box)
        rgba.thumbnail((width, width), Image.LANCZOS)
        save(rgba, OUT / target)
        done.append(target)
    return done


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--anchor', default='0.351,0.349')
    parser.add_argument('--base', type=float, default=0.441)
    args = parser.parse_args()
    anchor = [float(v) for v in args.anchor.split(',')]

    hand = prepare_hand(anchor, args.base)
    cursor = prepare_cursor()
    imprint = prepare_imprint()
    decor = prepare_decor()
    manifest = {'hand': hand, 'cursor': cursor, 'imprint': imprint, 'decor': decor}
    (OUT / 'extras.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    print(f'Готово: {json.dumps(manifest, ensure_ascii=False)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
