/**
 * Leitura do texto de uma página de PDF, na ordem de confiança.
 *
 * A ordem é deliberada e está documentada no README:
 *
 * 1. `pdftotext` (poppler), quando está instalado no computador do operador:
 *    preserva o layout e é a melhor leitura disponível;
 * 2. a leitura interna da camada de texto, feita em JavaScript puro, que
 *    funciona na Vercel e no modo portátil (sem binários de sistema);
 * 3. o OCR, para a página digitalizada (imagem). A imagem vem do próprio
 *    arquivo (`pdf-raster.ts`), sem depender do `poppler`, e o texto é lido
 *    pelo `tesseract.js`. Se a página não tiver uma imagem aproveitável, o
 *    `pdftoppm` entra como segunda tentativa;
 * 4. conferência manual: só acontece quando nenhuma estratégia de leitura
 *    funcionou de verdade.
 *
 * O módulo não inventa dado: quando o OCR lê com confiança baixa, o resultado
 * vem marcado como `lowConfidence` e o chamador manda a página para revisão.
 */
import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { hasUsableText } from "./pdf-text";
import { extractPageRaster, type PageRaster, type PageRasterResult } from "./pdf-raster";
import { OCR_MIN_CONFIDENCE, OcrError, type OcrEngine, type OcrFailureReason } from "./ocr";

const execFile = promisify(execFileCallback);

/** De onde veio o texto lido. */
export type PageTextSource = "conteudo-pdf" | "ocr-conteudo-pdf";

/** Estratégia usada para produzir a imagem do OCR. */
export type OcrStrategy = "imagem-js" | "poppler" | null;

export type PageTextResult = {
	text: string;
	source: PageTextSource;
	/** O texto veio do OCR. */
	ocrApplied: boolean;
	/** Confiança do OCR (0 quando não houve OCR). */
	ocrConfidence: number;
	/** Nenhuma estratégia de OCR funcionou: a página vai para revisão manual. */
	ocrUnavailable: boolean;
	/** Por que o OCR não funcionou (quando ele falhou). */
	ocrUnavailableReason: OcrFailureReason | null;
	/** Detalhe técnico da falha (ex.: `filtro /JBIG2Decode`). */
	ocrUnavailableDetail: string | null;
	/** O OCR leu, mas com confiança baixa: os campos não são confiáveis. */
	lowConfidence: boolean;
	ocrStrategy: OcrStrategy;
};

export type PageTextTools = {
	/** Texto da página pelo `pdftotext` (poppler). */
	readWithPdftotext(pdfPath: string, pageNumber: number): Promise<string | null>;
	/** PNG da página pelo `pdftoppm` (poppler). */
	renderWithPdftoppm(pdfPath: string, pageNumber: number): Promise<Buffer | null>;
	/** Imagem da página extraída do próprio arquivo (JavaScript puro + PDFium). */
	extractRaster(fileBuffer: Buffer, pageNumber: number): Promise<PageRaster | null>;
	/** Variante detalhada; quando ausente, usa `extractRaster`. */
	extractRasterDetailed?(fileBuffer: Buffer, pageNumber: number): Promise<PageRasterResult>;
	/** Motor de OCR. */
	ocr: OcrEngine | null;
};

/** Executa o `pdftotext` do poppler (quando está instalado). */
async function readWithPdftotext(pdfPath: string, pageNumber: number): Promise<string | null> {
	try {
		const result = await execFile("pdftotext", ["-f", String(pageNumber), "-l", String(pageNumber), "-layout", pdfPath, "-"], {
			maxBuffer: 2 * 1024 * 1024,
		});
		return result.stdout;
	} catch {
		return null;
	}
}

/** Gera o PNG da página com o `pdftoppm` do poppler (quando está instalado). */
async function renderWithPdftoppm(pdfPath: string, pageNumber: number): Promise<Buffer | null> {
	const imagePrefix = path.join(os.tmpdir(), `ponto-page-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	try {
		await execFile("pdftoppm", [
			"-f",
			String(pageNumber),
			"-l",
			String(pageNumber),
			"-png",
			"-r",
			"180",
			"-singlefile",
			pdfPath,
			imagePrefix,
		]);
		return await fs.readFile(`${imagePrefix}.png`);
	} catch {
		return null;
	} finally {
		await fs.rm(`${imagePrefix}.png`, { force: true }).catch(() => undefined);
	}
}

const defaultTools: PageTextTools = {
	readWithPdftotext,
	renderWithPdftoppm,
	extractRaster: extractPageRaster,
	ocr: null,
};

/**
 * Lê o texto de uma página.
 *
 * `tools` permite trocar (ou desligar) cada estratégia — é o que os testes
 * usam para garantir o comportamento sem `pdftotext`, sem `poppler` e sem
 * OCR.
 */
export async function readPageText(options: {
	pdfPath: string;
	pageNumber: number;
	fileBuffer: Buffer;
	embeddedText: string;
	tools?: Partial<PageTextTools>;
}): Promise<PageTextResult> {
	const tools: PageTextTools = { ...defaultTools, ...options.tools };

	const fromPdftotext = await tools.readWithPdftotext(options.pdfPath, options.pageNumber);
	if (fromPdftotext && hasUsableText(fromPdftotext)) {
		return {
			text: fromPdftotext,
			source: "conteudo-pdf",
			ocrApplied: false,
			ocrConfidence: 0,
			ocrUnavailable: false,
			ocrUnavailableReason: null,
			ocrUnavailableDetail: null,
			lowConfidence: false,
			ocrStrategy: null,
		};
	}

	if (hasUsableText(options.embeddedText)) {
		return {
			text: options.embeddedText,
			source: "conteudo-pdf",
			ocrApplied: false,
			ocrConfidence: 0,
			ocrUnavailable: false,
			ocrUnavailableReason: null,
			ocrUnavailableDetail: null,
			lowConfidence: false,
			ocrStrategy: null,
		};
	}

	if (!tools.ocr) {
		return {
			text: "",
			source: "conteudo-pdf",
			ocrApplied: false,
			ocrConfidence: 0,
			ocrUnavailable: true,
			ocrUnavailableReason: "motor-indisponivel",
			ocrUnavailableDetail: null,
			lowConfidence: false,
			ocrStrategy: null,
		};
	}

	// Página sem texto: ela precisa de OCR. Primeiro a imagem extraída do
	// próprio arquivo (funciona na Vercel e no modo portátil); se a página não
	// tiver uma imagem aproveitável — ou se a leitura dessa imagem falhar —
	// entra o `pdftoppm` do poppler.
	let ocrReason: OcrFailureReason | null = null;
	let ocrDetail: string | null = null;
	for (const strategy of ["imagem-js", "poppler"] as const) {
		let bytes: Buffer | null = null;
		if (strategy === "imagem-js") {
			if (tools.extractRasterDetailed) {
				const detailed = await tools.extractRasterDetailed(options.fileBuffer, options.pageNumber);
				bytes = detailed.raster?.bytes ?? null;
				if (!bytes && detailed.reason === "formato-imagem-nao-suportado") {
					ocrReason = "formato-imagem-nao-suportado";
					ocrDetail = detailed.filters.length
						? `filtro ${detailed.filters.join(", ")}`
						: "imagem sem filtro reconhecido";
				} else if (!bytes && detailed.reason && detailed.reason !== "sem-imagem") {
					ocrDetail = detailed.reason;
				}
			} else {
				const raster = await tools.extractRaster(options.fileBuffer, options.pageNumber);
				bytes = raster?.bytes ?? null;
			}
		} else {
			bytes = await tools.renderWithPdftoppm(options.pdfPath, options.pageNumber);
		}
		if (!bytes) continue;
		try {
			const outcome = await tools.ocr.recognize(bytes);
			const text = outcome.text ?? "";
			if (!text.trim()) continue;
			return {
				text,
				source: "ocr-conteudo-pdf",
				ocrApplied: true,
				ocrConfidence: Math.max(0, Math.min(100, Math.round(outcome.confidence))),
				ocrUnavailable: false,
				ocrUnavailableReason: null,
				ocrUnavailableDetail: null,
				lowConfidence: outcome.confidence < OCR_MIN_CONFIDENCE,
				ocrStrategy: strategy,
			};
		} catch (error) {
			// Falhou esta estratégia: tenta a próxima (e guarda o motivo).
			ocrReason = error instanceof OcrError ? error.reason : "leitura-falhou";
			ocrDetail = error instanceof Error ? error.message : null;
		}
	}

	return {
		text: "",
		source: "conteudo-pdf",
		ocrApplied: false,
		ocrConfidence: 0,
		ocrUnavailable: true,
		ocrUnavailableReason: ocrReason ?? "leitura-falhou",
		ocrUnavailableDetail: ocrDetail,
		lowConfidence: false,
		ocrStrategy: null,
	};
}
