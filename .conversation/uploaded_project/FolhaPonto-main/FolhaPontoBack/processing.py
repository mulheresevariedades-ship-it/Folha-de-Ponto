"""Processamento real e testável das folhas de ponto.

Os scripts originais do projeto continuam preservados. Esta camada não depende
de ``input()`` e coordena a separação das páginas, OCR opcional e extração dos
campos usados pela API web.
"""

from __future__ import annotations

import io
import os
import shutil
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, NamedTuple


@dataclass
class FieldConfidence:
    """Confidence data for individual extracted fields."""
    value: str | None
    confidence: float
    patterns_tried: list[str] = field(default_factory=list)


@dataclass
class Extraction:
    matricula: str | None
    nome: str | None
    competencia: str | None
    confianca: float
    modo: str
    texto: str = ""
    matricula_confidence: float = 0.0
    nome_confidence: float = 0.0
    competencia_confidence: float = 0.0
    cpf: str | None = None


# ---------------------------------------------------------------------------
# Image preprocessing utilities
# ---------------------------------------------------------------------------

class PreprocessingConfig:
    """Configuration for image preprocessing steps. All optional and configurable."""

    def __init__(
        self,
        grayscale: bool = True,
        contrast_factor: float = 1.5,
        binarize: bool = True,
        binarize_method: str = "otsu",
        noise_reduction: bool = True,
        median_kernel: int = 3,
        deskew: bool = True,
    ):
        self.grayscale = grayscale
        self.contrast_factor = contrast_factor
        self.binarize = binarize
        self.binarize_method = binarize_method  # "otsu" or "adaptive"
        self.noise_reduction = noise_reduction
        self.median_kernel = median_kernel
        self.deskew = deskew


DEFAULT_PREPROCESSING = PreprocessingConfig()


def _preprocess_image(image_bytes: bytes, config: PreprocessingConfig | None = None) -> bytes:
    """Apply optional preprocessing pipeline to an image, returning PNG bytes."""
    config = config or DEFAULT_PREPROCESSING

    try:
        from PIL import Image, ImageEnhance, ImageFilter
        import numpy as np
    except ImportError:
        return image_bytes

    img = Image.open(io.BytesIO(image_bytes))
    img = img.convert("RGB")

    if config.grayscale:
        img = img.convert("L")

    if config.contrast_factor != 1.0:
        enhancer = ImageEnhance.Contrast(img)
        img = enhancer.enhance(config.contrast_factor)

    if config.binarize:
        img_array = np.array(img)
        if config.binarize_method == "adaptive":
            threshold = _adaptive_threshold(img_array)
        else:
            threshold = _otsu_threshold(img_array)
        img = Image.fromarray((img_array > threshold).astype(np.uint8) * 255, mode="L")

    if config.noise_reduction:
        img = img.filter(ImageFilter.MedianFilter(size=config.median_kernel))

    if config.deskew:
        img = _deskew_image(img)

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _otsu_threshold(gray_array) -> int:
    """Compute Otsu's threshold from a grayscale numpy array."""
    import numpy as np
    hist, _ = np.histogram(gray_array.ravel(), bins=256, range=(0, 256))
    total = gray_array.size
    sum_total = np.sum(np.arange(256) * hist)
    sum_bg = 0.0
    weight_bg = 0
    max_variance = 0.0
    threshold = 0
    for i in range(256):
        weight_bg += hist[i]
        if weight_bg == 0:
            continue
        weight_fg = total - weight_bg
        if weight_fg == 0:
            break
        sum_bg += i * hist[i]
        mean_bg = sum_bg / weight_bg
        mean_fg = (sum_total - sum_bg) / weight_fg
        variance = weight_bg * weight_fg * (mean_bg - mean_fg) ** 2
        if variance > max_variance:
            max_variance = variance
            threshold = i
    return threshold


def _adaptive_threshold(gray_array, block_size: int = 15, c: int = 8):
    """Simple adaptive (mean-based) threshold for a grayscale numpy array."""
    import numpy as np
    from PIL import ImageFilter

    img = Image.fromarray(gray_array, mode="L")
    blurred = img.filter(ImageFilter.BoxBlur(block_size // 2))
    blurred_array = np.array(blurred, dtype=np.float64)
    return (blurred_array - c).astype(np.int32)


def _deskew_image(img) -> Any:
    """Attempt to deskew a PIL image using projection profile analysis."""
    import numpy as np
    from PIL import Image

    gray = img.convert("L")
    arr = np.array(gray)
    binary = (arr < 128).astype(np.uint8)

    if binary.sum() < 100:
        return img

    best_angle = 0.0
    best_score = 0
    for angle_10x in range(-30, 31):
        angle = angle_10x / 10.0
        rotated = img.rotate(angle, resample=Image.BILINEAR, expand=False, fillcolor=255)
        rot_arr = np.array(rotated.convert("L"))
        rot_bin = (rot_arr < 128).astype(np.uint8)
        row_sums = rot_bin.sum(axis=1).astype(np.float64)
        score = float((row_sums ** 2).sum())
        if score > best_score:
            best_score = score
            best_angle = angle

    if abs(best_angle) > 0.5:
        img = img.rotate(best_angle, resample=Image.BILINEAR, expand=False, fillcolor=255)
    return img


# ---------------------------------------------------------------------------
# OCR engine
# ---------------------------------------------------------------------------

def _resolve_tesseract_path() -> str | None:
    """Check TESSERACT_CMD env var or common install paths."""
    env_path = os.environ.get("TESSERACT_CMD")
    if env_path and os.path.isfile(env_path):
        return env_path
    common_paths = [
        r"C:\Program Files\Tesseract-OCR\tesseract.exe",
        r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
        "/usr/bin/tesseract",
        "/usr/local/bin/tesseract",
    ]
    for p in common_paths:
        if os.path.isfile(p):
            return p
    return None


def _run_ocr(image_bytes: bytes) -> tuple[str, str]:
    """Executa Tesseract quando disponível, sem inventar um resultado.

    Tries Portuguese first, then English, then no language spec.
    Never fabricates data.
    """
    try:
        import pytesseract  # type: ignore
        from PIL import Image  # type: ignore

        tesseract_path = _resolve_tesseract_path()
        if tesseract_path:
            pytesseract.pytesseract.tesseract_cmd = tesseract_path

        img = Image.open(io.BytesIO(image_bytes))

        text = ""
        for lang_attempt in ["por+eng", "por", "eng", None]:
            try:
                if lang_attempt is None:
                    text = pytesseract.image_to_string(img)
                else:
                    text = pytesseract.image_to_string(img, lang=lang_attempt)
                text = text.strip()
                if text:
                    return text, "ocr-tesseract"
            except Exception:
                continue

        return "", "ocr-indisponivel"
    except (ImportError, OSError, RuntimeError):
        return "", "ocr-indisponivel"


def _run_ocr_with_confidence(image_bytes: bytes) -> tuple[str, str, dict[str, Any]]:
    """Run OCR and also extract per-word confidence data when available."""
    try:
        import pytesseract  # type: ignore
        from PIL import Image  # type: ignore

        tesseract_path = _resolve_tesseract_path()
        if tesseract_path:
            pytesseract.pytesseract.tesseract_cmd = tesseract_path

        img = Image.open(io.BytesIO(image_bytes))

        text = ""
        overall_confidence = 0.0

        for lang_attempt in ["por+eng", "por", "eng", None]:
            try:
                if lang_attempt is None:
                    text = pytesseract.image_to_string(img)
                else:
                    text = pytesseract.image_to_string(img, lang=lang_attempt)
                text = text.strip()

                try:
                    data = pytesseract.image_to_data(
                        img, lang=lang_attempt, output_type=pytesseract.Output.DICT
                    )
                    confs = [c for c in data.get("conf", []) if isinstance(c, (int, float)) and c > 0]
                    if confs:
                        overall_confidence = sum(confs) / len(confs) / 100.0
                except Exception:
                    pass

                if text:
                    return text, "ocr-tesseract", {
                        "overall_confidence": overall_confidence,
                        "lang_used": lang_attempt,
                    }
            except Exception:
                continue

        return "", "ocr-indisponivel", {}
    except (ImportError, OSError, RuntimeError):
        return "", "ocr-indisponivel", {}


# ---------------------------------------------------------------------------
# Field extraction
# ---------------------------------------------------------------------------

def _find(pattern: str, text: str) -> str | None:
    match = re.search(pattern, text, flags=re.IGNORECASE | re.MULTILINE)
    return match.group(1).strip() if match else None


def _find_with_confidence(patterns: list[str], text: str) -> FieldConfidence:
    """Try multiple regex patterns and return best match with confidence."""
    for i, pattern in enumerate(patterns):
        match = re.search(pattern, text, flags=re.IGNORECASE | re.MULTILINE)
        if match:
            value = match.group(1).strip()
            # Earlier patterns are more specific => higher confidence
            confidence = max(0.5, 1.0 - i * 0.1)
            return FieldConfidence(value=value, confidence=confidence, patterns_tried=patterns[:i + 1])
    return FieldConfidence(value=None, confidence=0.0, patterns_tried=patterns)


def _detect_cpf(text: str) -> str | None:
    """Detect CPF number in text (XXX.XXX.XXX-XX or XXXXXXXXXXX)."""
    cpf_patterns = [
        r"CPF\s*:\s*(\d{3}\.?\d{3}\.?\d{3}-?\d{2})",
        r"(\d{3}\.\d{3}\.\d{3}-\d{2})",
        r"(\d{11})",
    ]
    for pattern in cpf_patterns:
        match = re.search(pattern, text)
        if match:
            return match.group(1).strip()
    return None


def extract_fields(text: str) -> Extraction:
    """Extrai matrícula, nome e competência do texto reconhecido."""
    clean_text = text.strip()
    if not clean_text:
        return Extraction(None, None, None, 0.0, "ocr-indisponivel", "")

    matricula_fc = _find_with_confidence([
        r"MATR[IÍ]CULA\s*:\s*([0-9]{5,})",
        r"MATR[IÍ]CULA\s+([0-9]{5,})",
        r"MAT[:\.]?\s*([0-9]{5,})",
        r"MATRICULA\s*[:=]?\s*([0-9]{5,})",
        r"MAT[.\s]*([0-9]{4,6})",
    ], clean_text)

    nome_fc = _find_with_confidence([
        r"NOME\s+DO\s+SERVIDOR\s*:\s*([^\n]+)",
        r"NOME\s*:\s*([^\n]+)",
        r"SERVIDOR\s*:\s*([^\n]+)",
        r"FUNCION[AÁ]RIO\s*:\s*([^\n]+)",
        r"Nome[:\s]+([A-Z][A-Z\s]+)",
    ], clean_text)

    competencia_fc = _find_with_confidence([
        r"(?:REFER[EÊ]NCIA|COMPET[EÊ]NCIA)\s*:\s*([A-ZÇÃÕÊÉ]+[ /-]+20\d{2})",
        r"(?:M[EÊ]S\s+ANO|PER[IÍ]ODO)\s*:\s*([A-ZÇÃÕÊÉ]+[ /-]+20\d{2})",
        r"([A-Z]{3,9})\s*/\s*(20\d{2})",
        r"(\d{2}/\d{4})",
        r"(\d{2}-\d{4})",
    ], clean_text)

    cpf = _detect_cpf(clean_text)

    matricula = matricula_fc.value
    nome = nome_fc.value
    competencia = competencia_fc.value

    found = sum(v is not None for v in (matricula, nome, competencia))
    base_confidence = {0: 0.41, 1: 0.62, 2: 0.78, 3: 0.94}[found]

    return Extraction(
        matricula=matricula,
        nome=nome,
        competencia=competencia,
        confianca=base_confidence,
        modo="ocr-texto",
        texto=clean_text,
        matricula_confidence=matricula_fc.confidence,
        nome_confidence=nome_fc.confidence,
        competencia_confidence=competencia_fc.confidence,
        cpf=cpf,
    )


# ---------------------------------------------------------------------------
# Classification logic
# ---------------------------------------------------------------------------

class ClassificationResult(NamedTuple):
    status: str
    reason: str


def classify_extraction(
    extraction: Extraction,
    employee_db: dict[str, str] | None = None,
) -> ClassificationResult:
    """Classify extraction result based on confidence and data quality.

    Status codes:
        "reconhecida"       - high confidence + matricula found
        "revisao"           - medium confidence
        "baixa_confianca"   - low confidence
        "nao_identificado"  - no matricula found
        "divergencia"       - name mismatch with employee DB
        "ocr_indisponivel"  - OCR was not available
    """
    if extraction.modo == "ocr-indisponivel":
        return ClassificationResult("ocr_indisponivel", "OCR indisponível")

    if extraction.matricula is None:
        return ClassificationResult("nao_identificado", "Matrícula não encontrada")

    if employee_db and extraction.nome:
        normalized_name = extraction.nome.strip().upper()
        stored_name = employee_db.get(extraction.matricula, "").strip().upper()
        if stored_name and stored_name != normalized_name:
            return ClassificationResult(
                "divergencia",
                f"Nome extraído '{extraction.nome}' difere do cadastrado",
            )

    if extraction.confianca >= 0.9:
        return ClassificationResult("reconhecida", "Confiança alta")
    elif extraction.confianca >= 0.7:
        return ClassificationResult("revisao", "Confiança média, revisão recomendada")
    else:
        return ClassificationResult("baixa_confianca", "Confiança baixa")


# ---------------------------------------------------------------------------
# Page-level orchestration
# ---------------------------------------------------------------------------

def _page_extraction(
    text: str,
    image_bytes: bytes | None = None,
    preprocessing_config: PreprocessingConfig | None = None,
) -> Extraction:
    if text.strip():
        return extract_fields(text)
    if image_bytes is None:
        return Extraction(None, None, None, 0.0, "ocr-indisponivel", "")

    preprocessed = _preprocess_image(image_bytes, preprocessing_config)
    ocr_text, mode, ocr_meta = _run_ocr_with_confidence(preprocessed)

    if ocr_text:
        extracted = extract_fields(ocr_text)
        extracted.modo = mode
        if ocr_meta.get("overall_confidence"):
            extracted.confianca = (
                extracted.confianca + ocr_meta["overall_confidence"]
            ) / 2.0
        return extracted
    return Extraction(None, None, None, 0.0, mode, "")


def _extraction_dict(extracted: Extraction) -> dict[str, Any]:
    return {
        "matricula": extracted.matricula,
        "nome": extracted.nome,
        "competencia": extracted.competencia,
        "confidence": extracted.confianca,
        "mode": extracted.modo,
        "text": extracted.texto,
        "matricula_confidence": extracted.matricula_confidence,
        "nome_confidence": extracted.nome_confidence,
        "competencia_confidence": extracted.competencia_confidence,
        "cpf": extracted.cpf,
    }


def process_document(path: Path, pages_dir: Path | None = None) -> dict[str, Any]:
    """Separa cada página e retorna uma extração independente por página."""
    pages_dir = pages_dir or path.parent / f"{path.stem}_pages"
    pages_dir.mkdir(parents=True, exist_ok=True)
    page_results: list[dict[str, Any]] = []

    if path.suffix.lower() == ".pdf":
        try:
            import fitz  # type: ignore
        except ImportError:
            return {
                "pages": 0,
                "page_results": [],
                "extraction": _extraction_dict(Extraction(None, None, None, 0.0, "ocr-indisponivel")),
            }

        document = fitz.open(path)
        try:
            for page_number in range(document.page_count):
                page = document[page_number]
                text = page.get_text("text") or ""
                pixmap = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
                image_bytes = pixmap.tobytes("png")
                extracted = _page_extraction(text, image_bytes)
                individual_path = pages_dir / f"pagina-{page_number + 1:03d}.pdf"
                individual = fitz.open()
                individual.insert_pdf(document, from_page=page_number, to_page=page_number)
                individual.save(individual_path)
                individual.close()
                page_results.append(
                    {
                        "source_page": page_number + 1,
                        "stored_path": individual_path,
                        "extraction": _extraction_dict(extracted),
                    }
                )
        finally:
            document.close()
    else:
        image_bytes = path.read_bytes()
        extracted = _page_extraction("", image_bytes)
        individual_path = pages_dir / f"pagina-001{path.suffix.lower()}"
        shutil.copyfile(path, individual_path)
        page_results.append(
            {
                "source_page": 1,
                "stored_path": individual_path,
                "extraction": _extraction_dict(extracted),
            }
        )

    first_extraction = page_results[0]["extraction"] if page_results else _extraction_dict(
        Extraction(None, None, None, 0.0, "ocr-indisponivel")
    )
    return {
        "pages": len(page_results),
        "page_results": page_results,
        "extraction": first_extraction,
    }
