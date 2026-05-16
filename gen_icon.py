from PIL import Image, ImageDraw
import struct
import io
import os

def draw_clipmate_icon(size):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    p = max(1, size // 10)
    radius = max(3, size // 7)
    draw.rounded_rectangle([p, p, size - p, size - p], radius=radius, fill=(99, 102, 241, 255))
    bx0, by0, bx1, by1 = size*0.22, size*0.28, size*0.78, size*0.82
    br = max(1, int(size * 0.05))
    draw.rounded_rectangle([bx0, by0, bx1, by1], radius=br, fill=(255, 255, 255, 245))
    cx0, cx1, cy0, cy1 = size*0.38, size*0.62, size*0.18, size*0.32
    draw.rounded_rectangle([cx0, cy0, cx1, cy1], radius=max(1, int(size*0.04)), fill=(200, 205, 250, 255))
    lc = (140, 145, 220, 210)
    lx0, lx1 = size * 0.30, size * 0.70
    for i in range(3):
        ly = size * (0.38 + i * 0.13)
        lw = max(1, int(size * 0.04))
        draw.rounded_rectangle([lx0, ly, lx1 if i < 2 else size * 0.55, ly + lw],
                                radius=max(1, lw // 2), fill=lc)
    return img


def image_to_png_bytes(img):
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    return buf.getvalue()


def build_ico(sizes):
    """手动构建多尺寸 ICO 文件"""
    images_png = []
    for s in sizes:
        img = draw_clipmate_icon(s)
        png_data = image_to_png_bytes(img)
        images_png.append((s, png_data))

    n = len(images_png)
    # ICO header: 6 bytes
    header = struct.pack('<HHH', 0, 1, n)
    # directory entries: 16 bytes each
    # image data starts after header + n*16
    data_offset = 6 + n * 16
    entries = b''
    images_data = b''
    for (s, png_data) in images_png:
        w = 0 if s == 256 else s   # 0 means 256 in ICO spec
        h = 0 if s == 256 else s
        size_bytes = len(png_data)
        entries += struct.pack('<BBBBHHII',
            w, h, 0, 0,   # width, height, color_count, reserved
            1, 32,         # planes, bit_count
            size_bytes,
            data_offset
        )
        images_data += png_data
        data_offset += size_bytes

    return header + entries + images_data


def create_icons():
    sizes = [16, 32, 48, 64, 128, 256]

    # ICO
    ico_path = r'C:\Users\Administrator\WorkBuddy\Claw\clipboard-manager\assets\icon.ico'
    ico_data = build_ico(sizes)
    with open(ico_path, 'wb') as f:
        f.write(ico_data)
    print(f"ICO 已生成: {ico_path}  ({os.path.getsize(ico_path)//1024} KB)")

    # 验证
    with Image.open(ico_path) as chk:
        print(f"  验证通过，PIL 读取格式: {chk.format}")

    # 托盘 PNG (32x32)
    png_path = r'C:\Users\Administrator\WorkBuddy\Claw\clipboard-manager\assets\tray-icon.png'
    tray = Image.new('RGBA', (32, 32), (0, 0, 0, 0))
    td = ImageDraw.Draw(tray)
    td.rounded_rectangle([2, 2, 30, 30], radius=5, fill=(99, 102, 241, 220))
    td.rounded_rectangle([11, 1, 21, 7], radius=2, fill=(180, 185, 240, 255))
    for i in range(3):
        ly = 11 + i * 6
        td.rounded_rectangle([7, ly, 25 if i < 2 else 18, ly + 2], radius=1, fill=(255, 255, 255, 210))
    tray.save(png_path)
    print(f"托盘图标已生成: {png_path}")


create_icons()
