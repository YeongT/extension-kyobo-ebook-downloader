#!/usr/bin/env python3
"""
Kyobo eBook PDF Merger
Usage: python merge_pdf.py [session_folder_or_zip] [--quality 85] [--size a4|b5|a5|original]

Merges captured page images into a single PDF with no memory limits.
Works with session export (metadata.json + pages/) or plain image ZIP.
Includes TOC bookmarks from metadata.json if available.

Requires: pip install Pillow
"""
import sys
import os
import json
import zipfile
import tempfile
import shutil
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    print("Pillow 라이브러리가 필요합니다.")
    print("설치: pip install Pillow")
    sys.exit(1)

SIZE_PRESETS = {
    'a4': (210, 297),
    'b5': (182, 257),
    'a5': (148, 210),
    'original': None,
}

MM_TO_PT = 72 / 25.4


def find_source(path):
    """Detect source type and extract if ZIP."""
    tmp_dir = None
    if zipfile.is_zipfile(path):
        tmp_dir = tempfile.mkdtemp()
        with zipfile.ZipFile(path, 'r') as z:
            z.extractall(tmp_dir)
        path = tmp_dir
    elif not os.path.isdir(path):
        # Try current directory
        if os.path.exists('metadata.json'):
            path = '.'
        else:
            print(f"에러: '{path}'를 찾을 수 없습니다.")
            sys.exit(1)
    return path, tmp_dir


def load_metadata(base_path):
    """Load metadata.json if available."""
    meta_path = os.path.join(base_path, 'metadata.json')
    if os.path.exists(meta_path):
        with open(meta_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    return None


def get_images(base_path):
    """Find all page images sorted by number."""
    images = []
    # Check pages/ subfolder first (session export)
    pages_dir = os.path.join(base_path, 'pages')
    if os.path.isdir(pages_dir):
        search_dir = pages_dir
    # Check images/ subfolder (ZIP export)
    elif os.path.isdir(os.path.join(base_path, 'images')):
        search_dir = os.path.join(base_path, 'images')
    else:
        search_dir = base_path

    for f in sorted(os.listdir(search_dir)):
        if f.lower().endswith(('.png', '.jpg', '.jpeg')):
            images.append(os.path.join(search_dir, f))
    return images


def merge_to_pdf(images, output, metadata=None, quality=85, size='original'):
    """Merge images into a single PDF with optional TOC bookmarks."""
    target = SIZE_PRESETS.get(size)
    pdf_pages = []
    total = len(images)

    for i, img_path in enumerate(images):
        pct = int((i + 1) / total * 100)
        print(f"\r  [{pct:3d}%] {i+1}/{total} {os.path.basename(img_path)}", end='', flush=True)

        img = Image.open(img_path)
        if img.mode == 'RGBA':
            bg = Image.new('RGB', img.size, (255, 255, 255))
            bg.paste(img, mask=img.split()[3])
            img = bg
        elif img.mode != 'RGB':
            img = img.convert('RGB')

        if target:
            tw_pt = target[0] * MM_TO_PT
            th_pt = target[1] * MM_TO_PT
            img_w, img_h = img.size
            scale = min(tw_pt / img_w, th_pt / img_h)
            new_w = int(img_w * scale)
            new_h = int(img_h * scale)
            img = img.resize((new_w, new_h), Image.LANCZOS)

        pdf_pages.append(img)

    print()
    print(f"  PDF 저장 중: {output}")

    if not pdf_pages:
        print("  이미지를 찾을 수 없습니다.")
        return

    pdf_pages[0].save(
        output, 'PDF', save_all=True,
        append_images=pdf_pages[1:],
        quality=quality, optimize=True
    )

    file_size = os.path.getsize(output) / 1024 / 1024
    print(f"  완료! {len(pdf_pages)}페이지, {file_size:.1f}MB")

    # Add TOC bookmarks if metadata has TOC
    if metadata and metadata.get('toc'):
        try:
            add_bookmarks(output, metadata['toc'], len(pdf_pages))
        except Exception as e:
            print(f"  목차 추가 실패 (PDF는 정상): {e}")


def add_bookmarks(pdf_path, toc, total_pages):
    """Add bookmarks to existing PDF using PyPDF if available."""
    try:
        from pypdf import PdfReader, PdfWriter
    except ImportError:
        try:
            from PyPDF2 import PdfReader, PdfWriter
        except ImportError:
            print("  목차 추가를 위해 pypdf 설치 권장: pip install pypdf")
            return

    reader = PdfReader(pdf_path)
    writer = PdfWriter()
    for page in reader.pages:
        writer.add_page(page)

    # Build bookmark tree
    parents = {}
    for entry in toc:
        depth = entry.get('depth', 1)
        page_num = entry.get('page', 1) - 1  # 0-indexed
        if page_num >= total_pages:
            continue
        title = entry.get('title', f'Page {page_num + 1}')
        parent = parents.get(depth - 1) if depth > 1 else None
        try:
            bookmark = writer.add_outline_item(title, page_num, parent=parent)
            parents[depth] = bookmark
            # Clear deeper levels
            for d in range(depth + 1, 11):
                parents.pop(d, None)
        except Exception:
            pass

    tmp_out = pdf_path + '.tmp'
    with open(tmp_out, 'wb') as f:
        writer.write(f)
    os.replace(tmp_out, pdf_path)
    print(f"  목차 {len(toc)}항목 추가됨")


def main():
    if len(sys.argv) < 2:
        # Try current directory
        if os.path.exists('metadata.json') or os.path.exists('pages'):
            source = '.'
        else:
            print(__doc__)
            sys.exit(0)
    else:
        source = sys.argv[1]

    quality = 85
    size = 'original'
    output = None

    for i, arg in enumerate(sys.argv):
        if arg == '--quality' and i + 1 < len(sys.argv):
            quality = int(sys.argv[i + 1])
        if arg == '--size' and i + 1 < len(sys.argv):
            size = sys.argv[i + 1]
        if arg == '-o' and i + 1 < len(sys.argv):
            output = sys.argv[i + 1]

    base_path, tmp_dir = find_source(source)
    metadata = load_metadata(base_path)
    images = get_images(base_path)

    if not images:
        print("이미지를 찾을 수 없습니다.")
        sys.exit(1)

    title = (metadata or {}).get('title', Path(source).stem.replace('_session', ''))
    if not output:
        safe = title.replace('/', '_').replace('\\', '_')[:100]
        output = safe + '.pdf'

    print(f"Kyobo eBook PDF Merger")
    print(f"  제목: {title}")
    print(f"  이미지: {len(images)}페이지")
    print(f"  품질: {quality}, 크기: {size}")
    if metadata and metadata.get('toc'):
        print(f"  목차: {len(metadata['toc'])}항목")
    print()

    merge_to_pdf(images, output, metadata, quality, size)

    if tmp_dir:
        shutil.rmtree(tmp_dir, ignore_errors=True)


if __name__ == '__main__':
    main()
