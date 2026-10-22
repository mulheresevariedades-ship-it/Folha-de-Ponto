import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { extractPageRaster } from "./pdf-raster";
import { readPageText } from "./pdf-page-text";
import { extractPdfPageTexts } from "./pdf-text";
import { ocrDiagnostics, recognizeImage, terminateOcr } from "./ocr";
import { competencyFromContent, matriculaFromContent, nameFromContent } from "./timesheet-files";

/**
 * Teste do OCR de verdade (tesseract.js/WASM), sobre um PDF digitalizado.
 *
 * O modelo de idioma é baixado da internet na primeira execução (cerca de
 * 4 MB). Sem internet o teste é ignorado com aviso — o restante da suíte
 * continua válido. Para desligá-lo de propósito: `PONTO_OCR_TEST=0`.
 */

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const ignorar = process.env.PONTO_OCR_TEST === "0";

async function pdfDigitalizado(paginasDeTexto = 0): Promise<Buffer> {
	const bytes = await readFile(path.join(fixtures, "folha-digitalizada.png"));
	const document = await PDFDocument.create();
	for (let index = 0; index < paginasDeTexto; index += 1) {
		const page = document.addPage([595.28, 841.89]);
		const font = await document.embedFont(StandardFonts.Helvetica);
		page.drawText(`FOLHA DE PONTO - Competencia: 02/2027 - Servidor: Joao Souza`, {
			x: 60,
			y: 780,
			size: 14,
			font,
		});
	}
	const image = await document.embedPng(bytes);
	const scanned = document.addPage([595.28, 841.89]);
	scanned.drawImage(image, { x: 0, y: 0, width: 595.28, height: 841.89 });
	return Buffer.from(await document.save());
}

/** Roda o OCR real; devolve `null` quando o modelo de idioma não está disponível. */
async function ocrDisponivel(): Promise<boolean> {
	try {
		await recognizeImage(Buffer.from(PNG_MINIMO));
		return true;
	} catch {
		return false;
	}
}

// PNG 1x1 válido: serve só para checar se o motor de OCR sobe.
const PNG_MINIMO = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

describe("OCR de PDF digitalizado", { skip: ignorar ? "desligado por PONTO_OCR_TEST=0" : false }, () => {
	after(async () => {
		await terminateOcr();
	});

	it("lê a competência de uma folha digitalizada", async (t) => {
		if (!(await ocrDisponivel())) {
			t.skip("modelo de idioma indisponível (sem internet?)");
			return;
		}
		const pdf = await pdfDigitalizado();
		const raster = await extractPageRaster(pdf, 1);
		assert.ok(raster, "a imagem da página digitalizada deve ser extraída");
		const outcome = await recognizeImage(raster.bytes);
		assert.ok(outcome.confidence >= 60, `confiança do OCR baixa demais: ${outcome.confidence}`);
		assert.equal(competencyFromContent(outcome.text), "2027-01");
	});

	it("lê o nome e a matrícula de uma folha digitalizada", async (t) => {
		if (!(await ocrDisponivel())) {
			t.skip("modelo de idioma indisponível (sem internet?)");
			return;
		}
		const pdf = await pdfDigitalizado();
		const raster = await extractPageRaster(pdf, 1);
		assert.ok(raster);
		const outcome = await recognizeImage(raster.bytes);
		assert.equal(nameFromContent(outcome.text), "Maria Silva Santos");
		assert.equal(matriculaFromContent(outcome.text), "12345");
	});

	it("estoura o tempo limite sem travar a requisição", async () => {
		const anterior = process.env.PONTO_OCR_TIMEOUT_MS;
		process.env.PONTO_OCR_TIMEOUT_MS = "1";
		try {
			const bytes = await readFile(path.join(fixtures, "folha-digitalizada.png"));
			const inicio = Date.now();
			await assert.rejects(() => recognizeImage(bytes), /Tempo limite do OCR/);
			assert.ok(Date.now() - inicio < 30000, "o tempo limite precisa ser respeitado");
		} finally {
			if (anterior === undefined) delete process.env.PONTO_OCR_TIMEOUT_MS;
			else process.env.PONTO_OCR_TIMEOUT_MS = anterior;
			await terminateOcr();
		}
	});

	it("relata a situação do OCR para o diagnóstico", () => {
		const diagnostico = ocrDiagnostics();
		assert.equal(diagnostico.motorDisponivel, true, "o motor do OCR acompanha o pacote");
		assert.ok(diagnostico.modeloLocal.idiomas.length > 0, "há pelo menos um idioma configurado");
		assert.ok(Array.isArray(diagnostico.cache.arquivos));
	});

	it("lê um PDF misto: página de texto pela camada de texto e página digitalizada pelo OCR", async (t) => {
		if (!(await ocrDisponivel())) {
			t.skip("modelo de idioma indisponível (sem internet?)");
			return;
		}
		const pdf = await pdfDigitalizado(1);
		const camadas = await extractPdfPageTexts(pdf);

		// Página 1: texto normal, lido pela camada de texto do PDF.
		const primeira = await readPageText({
			pdfPath: "folha.pdf",
			pageNumber: 1,
			fileBuffer: pdf,
			embeddedText: camadas[0]?.text ?? "",
			tools: {
				readWithPdftotext: async () => null,
				extractRaster: extractPageRaster,
				ocr: { recognize: recognizeImage },
			},
		});
		assert.equal(primeira.source, "conteudo-pdf");
		assert.equal(primeira.ocrApplied, false);

		// Página 2: digitalizada, lida pelo OCR.
		const segunda = await readPageText({
			pdfPath: "folha.pdf",
			pageNumber: 2,
			fileBuffer: pdf,
			embeddedText: camadas[1]?.text ?? "",
			tools: {
				readWithPdftotext: async () => null,
				extractRaster: extractPageRaster,
				ocr: { recognize: recognizeImage },
			},
		});
		assert.equal(segunda.source, "ocr-conteudo-pdf");
		assert.equal(segunda.ocrApplied, true);
		assert.equal(segunda.ocrUnavailable, false);
		assert.equal(competencyFromContent(segunda.text), "2027-01");
	});
});
