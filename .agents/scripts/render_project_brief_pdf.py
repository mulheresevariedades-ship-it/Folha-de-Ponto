from pathlib import Path
import sys

import fitz


pdf_path = Path(sys.argv[1])
output_dir = Path(sys.argv[2])
output_dir.mkdir(parents=True, exist_ok=True)

with fitz.open(pdf_path) as document:
    print(f"Pages: {document.page_count}")
    for index, page in enumerate(document):
        image = page.get_pixmap(matrix=fitz.Matrix(1.8, 1.8), alpha=False)
        output_path = output_dir / f"project-brief-page-{index + 1}.png"
        image.save(output_path)
        print(f"{output_path} ({image.width}x{image.height})")
