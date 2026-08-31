#!/usr/bin/env python3
"""
K-Music 모바일(PWA) 아이콘 빌드.

  k-music.svg           -> 일반 아이콘(purpose "any"). 지금 배포중인 PNG를 그대로 재현하는
                           벡터 원본이다. 2026-08-25 아이콘 통일 작업의 벡터 마스터가 어디에도
                           저장돼있지 않아서, 배포중인 icon-512.png를 픽셀 실측해서 복원했다
                           (평균 오차 1.55/255, 육안 동일 확인).
  k-music-maskable.svg  -> 안드로이드 홈화면용(purpose "maskable"). 배경이 꽉 차고 파형+K배지가
                           안전영역(중심 반지름 40%) 안에 들어간다.

실행:  /opt/homebrew/bin/python3 build_icons.py          # public/ 에 바로 씀
       /opt/homebrew/bin/python3 build_icons.py --check  # 쓰지 않고 검증만

※ cairosvg가 필요해서 시스템 파이썬(/usr/bin/python3)이 아니라 홈브루 파이썬을 써야 한다
   (시스템 파이썬에는 libcairo가 없다).
"""
import argparse
import io
import math
import os
import sys

import cairosvg
from PIL import Image

SRC = os.path.dirname(os.path.abspath(__file__))
PUB = os.path.join(SRC, "..", "public")

# (svg, 출력 파일명, 크기)  — 일반 아이콘 3종은 이미 배포중인 파일과 동일해서 다시 쓰지 않는다.
MASKABLE = [
    ("k-music-maskable.svg", "icon-192-maskable.png", 192),
    ("k-music-maskable.svg", "icon-512-maskable.png", 512),
]


def render(svg, size, ss=4):
    """svg를 size px로 렌더. ss배 슈퍼샘플링 후 축소해서 가장자리를 매끄럽게 만든다."""
    big = size * ss
    png = cairosvg.svg2png(url=os.path.join(SRC, svg),
                           output_width=big, output_height=big)
    im = Image.open(io.BytesIO(png)).convert("RGBA")
    return im.resize((size, size), Image.LANCZOS) if ss != 1 else im


def check(im, name):
    """maskable 규격 두 가지를 기계로 확인한다."""
    w, h = im.size
    px = im.load()
    step = max(1, w // 180)
    holes = min(px[x, y][3] for x in range(0, w, step) for y in range(0, h, step))
    ok_bleed = holes == 255

    # 안전영역: 한 변의 80% 지름 원(중심에서 반지름 40%). 그 바깥은 잘릴 수 있다.
    safe = 0.4 * w
    c = (w - 1) / 2
    # 배경만 렌더해서 차이나는 픽셀 = 실제 내용물
    bgsrc = open(os.path.join(SRC, "k-music-maskable.svg")).read()
    cut = bgsrc.index('<g transform="translate(48 48)')
    bg = cairosvg.svg2png(bytestring=(bgsrc[:cut] + "</svg>").encode(),
                          output_width=w, output_height=h)
    bp = Image.open(io.BytesIO(bg)).convert("RGBA").load()
    maxr = 0.0
    for y in range(h):
        for x in range(w):
            if max(abs(px[x, y][i] - bp[x, y][i]) for i in range(3)) > 8:
                maxr = max(maxr, math.hypot(x - c, y - c))
    ok_safe = maxr <= safe
    print("  %-24s full-bleed=%-5s  content r=%.1f / safe %.1f  %s"
          % (name, ok_bleed, maxr, safe, "OK" if (ok_bleed and ok_safe) else "FAIL"))
    return ok_bleed and ok_safe


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="파일을 쓰지 않고 검증만")
    a = ap.parse_args()
    allok = True
    for svg, name, size in MASKABLE:
        im = render(svg, size)
        allok &= check(im, name)
        if not a.check:
            im.save(os.path.join(PUB, name))
            print("  wrote %s (%dx%d)" % (name, size, size))
    if not allok:
        sys.exit("maskable 규격 검증 실패")
    print("all ok")


if __name__ == "__main__":
    main()
