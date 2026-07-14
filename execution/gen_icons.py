#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Generador determinista de iconos para el framework de Sorteos y Rifas.

Produce, desde una sola ilustracion vectorial dibujada con Pillow:
  - Un maestro 1024x1024 (fuente para `tauri icon`).
  - Icono Play Store 512x512.
  - Mipmaps Android (mdpi..xxxhdpi): ic_launcher, ic_launcher_round,
    ic_launcher_foreground (adaptativo, zona segura 66%).

Motivo: cubrir "diferentes pantallas" tanto en escritorio (Windows) como en
Android (todas las densidades + iconos adaptativos API 26+).

Ejecucion:
    python execution/gen_icons.py
Idempotente: sobrescribe las salidas.
"""
from __future__ import annotations

import math
import os
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = os.path.join(ROOT, ".tmp", "icons")
ANDROID_RES = os.path.join(ROOT, "apps", "android", "app", "src", "main", "res")

# Paleta festiva (violeta -> magenta) con acento dorado.
C_TOP = (124, 58, 237)      # #7C3AED violeta
C_BOTTOM = (219, 39, 119)   # #DB2777 magenta/rosa
C_TICKET = (255, 255, 255)
C_STAR = (251, 191, 36)     # #FBBF24 dorado
C_STAR_EDGE = (245, 158, 11)  # #F59E0B

SS = 4  # supersampling para bordes suaves


def _lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def rounded_mask(size: int, radius_ratio: float = 0.235) -> Image.Image:
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    r = int(size * radius_ratio)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=255)
    return m


def gradient_square(size: int) -> Image.Image:
    """Fondo con gradiente vertical suave, diagonal ligero."""
    g = Image.new("RGB", (size, size), C_TOP)
    px = g.load()
    for y in range(size):
        for x in range(size):
            # mezcla diagonal para un look mas dinamico
            t = (y * 0.78 + x * 0.22) / size
            t = max(0.0, min(1.0, t))
            px[x, y] = _lerp(C_TOP, C_BOTTOM, t)
    return g


def star_polygon(cx, cy, r_out, r_in, points=5, rot=-math.pi / 2):
    pts = []
    for i in range(points * 2):
        r = r_out if i % 2 == 0 else r_in
        a = rot + i * math.pi / points
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def draw_emblem(size: int) -> Image.Image:
    """Ticket blanco con perforacion + estrella dorada, sobre transparente.

    El emblema ocupa casi todo el lienzo `size`; el llamador lo escala.
    """
    S = size * SS
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # --- Ticket (rectangulo redondeado, ligeramente rotado) ---
    tw, th = int(S * 0.80), int(S * 0.52)
    tx, ty = (S - tw) // 2, (S - th) // 2
    ticket = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    td = ImageDraw.Draw(ticket)
    rad = int(th * 0.16)
    td.rounded_rectangle([tx, ty, tx + tw, ty + th], radius=rad, fill=C_TICKET)

    # Notches (semicirculos) que "muerden" el ticket arriba y abajo, en la
    # linea de perforacion -> apariencia inconfundible de boleto.
    notch_x = tx + int(tw * 0.34)
    nr = int(th * 0.14)
    td.ellipse([notch_x - nr, ty - nr, notch_x + nr, ty + nr], fill=(0, 0, 0, 0))
    td.ellipse([notch_x - nr, ty + th - nr, notch_x + nr, ty + th + nr], fill=(0, 0, 0, 0))

    # Perforacion punteada vertical entre los notches (agujeros transparentes).
    dash_r = int(th * 0.032)
    y = ty + int(nr * 1.4)
    step = int(dash_r * 3.1)
    while y < ty + th - int(nr * 1.4):
        td.ellipse([notch_x - dash_r, y - dash_r, notch_x + dash_r, y + dash_r], fill=(0, 0, 0, 0))
        y += step

    img = Image.alpha_composite(img, ticket)
    d = ImageDraw.Draw(img)

    # --- Estrella dorada en el cuerpo mayor del ticket ---
    star_cx = tx + int(tw * 0.67)
    star_cy = ty + th // 2
    r_out = int(th * 0.34)
    r_in = int(r_out * 0.42)
    pts = star_polygon(star_cx, star_cy, r_out, r_in)
    d.polygon(pts, fill=C_STAR, outline=C_STAR_EDGE, width=max(2, SS))

    # Downsample con antialias.
    img = img.resize((size, size), Image.LANCZOS)
    return img


def compose_icon(size: int, circular: bool = False, emblem_scale: float = 0.66) -> Image.Image:
    """Fondo + emblema centrado, recortado a rounded-square o circulo."""
    S = size * SS
    bg = gradient_square(S)
    em_px = int(S * emblem_scale)
    em = draw_emblem(em_px)
    canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    canvas.paste(bg.convert("RGBA"), (0, 0))
    off = (S - em_px) // 2
    canvas = Image.alpha_composite(canvas, _pad(em, S, off))

    if circular:
        mask = Image.new("L", (S, S), 0)
        ImageDraw.Draw(mask).ellipse([0, 0, S - 1, S - 1], fill=255)
    else:
        mask = rounded_mask(S)
    canvas.putalpha(_min_alpha(canvas.getchannel("A"), mask))
    canvas = canvas.resize((size, size), Image.LANCZOS)
    return canvas


def foreground(size: int, emblem_scale: float = 0.62) -> Image.Image:
    """Capa frontal del icono adaptativo: solo emblema en zona segura."""
    S = size * SS
    em_px = int(S * emblem_scale)
    em = draw_emblem(em_px)
    canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    off = (S - em_px) // 2
    canvas = Image.alpha_composite(canvas, _pad(em, S, off))
    return canvas.resize((size, size), Image.LANCZOS)


def _pad(im: Image.Image, size: int, off: int) -> Image.Image:
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(im, (off, off), im)
    return out


def _min_alpha(a: Image.Image, b: Image.Image) -> Image.Image:
    from PIL import ImageChops
    return ImageChops.darker(a, b)


def save(im: Image.Image, path: str):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    im.save(path, "PNG")
    print("  ->", os.path.relpath(path, ROOT))


def main():
    os.makedirs(TMP, exist_ok=True)
    print("Maestro y Play Store:")
    master = compose_icon(1024)
    save(master, os.path.join(TMP, "icon-source.png"))
    save(compose_icon(512), os.path.join(TMP, "playstore-512.png"))

    # Densidades Android.
    launcher = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
    adaptive = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}

    print("Mipmaps Android:")
    for dens, px in launcher.items():
        base = os.path.join(ANDROID_RES, f"mipmap-{dens}")
        save(compose_icon(px, circular=False), os.path.join(base, "ic_launcher.png"))
        save(compose_icon(px, circular=True), os.path.join(base, "ic_launcher_round.png"))
    for dens, px in adaptive.items():
        base = os.path.join(ANDROID_RES, f"mipmap-{dens}")
        save(foreground(px), os.path.join(base, "ic_launcher_foreground.png"))

    print("OK: iconos generados.")


if __name__ == "__main__":
    main()
