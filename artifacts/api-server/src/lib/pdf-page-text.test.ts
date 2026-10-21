import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PageRaster } from "./pdf-raster";
import { readPageText, type PageTextTools } from "./pdf-page-text";

const rasterFake: PageRaster = {
	bytes: Buffer.from("imagem-falsa"),
	format: "png",
	width: 1654,
	height: 2339,
	dpi: 200,
};

const textoFolha = "FOLHA DE PONTO\nCompetencia: 01/2027\nServidor: Maria Silva Santos\nMatricula: 12345";

/** Ferramentas desligadas: reproduz um computador sem poppler e sem OCR. */
function semFerramentas(): PageTextTools {
	return {
		readWithPdftotext: async () => null,
		renderWithPdftoppm: async () => null,
		extractRaster: async () => null,
		ocr: null,
	};
}

async function lerPagina(tools: Partial<PageTextTools>, embeddedText = "") {
	return readPageText({
		pdfPath: "folha.pdf",
		pageNumber: 1,
		fileBuffer: Buffer.from("pdf"),
		embeddedText,
		tools: { ...semFerramentas(), ...tools },
	});
}

describe("readPageText", () => {
	it("usa o pdftotext quando o poppler está instalado", async () => {
		let ocrChamado = false;
		const result = await lerPagina({
			readWithPdftotext: async () => textoFolha,
			ocr: {
				recognize: async () => {
					ocrChamado = true;
					return { text: "", confidence: 0 };
				},
			},
		});
		assert.equal(result.source, "conteudo-pdf");
		assert.equal(result.ocrApplied, false);
		assert.equal(result.ocrUnavailable, false);
		assert.equal(result.text, textoFolha);
		assert.equal(ocrChamado, false, "com texto legível o OCR não deve ser chamado");
	});

	it("usa a camada de texto lida em JavaScript puro quando não há pdftotext", async () => {
		const result = await lerPagina({}, textoFolha);
		assert.equal(result.source, "conteudo-pdf");
		assert.equal(result.ocrApplied, false);
		assert.equal(result.text, textoFolha);
	});

	it("faz OCR da imagem extraída do próprio arquivo, sem depender do poppler", async () => {
		let popplerChamado = false;
		const recebidas: Buffer[] = [];
		const result = await lerPagina({
			extractRaster: async () => rasterFake,
			renderWithPdftoppm: async () => {
				popplerChamado = true;
				return Buffer.from("png");
			},
			ocr: {
				recognize: async (image: Buffer) => {
					recebidas.push(image);
					return { text: textoFolha, confidence: 92 };
				},
			},
		});
		assert.equal(result.source, "ocr-conteudo-pdf");
		assert.equal(result.ocrApplied, true);
		assert.equal(result.ocrUnavailable, false);
		assert.equal(result.lowConfidence, false);
		assert.equal(result.ocrConfidence, 92);
		assert.equal(result.ocrStrategy, "imagem-js");
		assert.equal(popplerChamado, false, "com a imagem do próprio arquivo o poppler é desnecessário");
		assert.equal(recebidas.length, 1);
		assert.ok(recebidas[0].equals(rasterFake.bytes), "o OCR recebe os bytes da imagem");
	});

	it("usa o poppler quando a página não tem imagem aproveitável", async () => {
		const result = await lerPagina({
			extractRaster: async () => null,
			renderWithPdftoppm: async () => Buffer.from("png"),
			ocr: { recognize: async () => ({ text: textoFolha, confidence: 80 }) },
		});
		assert.equal(result.source, "ocr-conteudo-pdf");
		assert.equal(result.ocrApplied, true);
		assert.equal(result.ocrStrategy, "poppler");
	});

	it("avisa quando o OCR lê com confiança baixa", async () => {
		const result = await lerPagina({
			extractRaster: async () => rasterFake,
			ocr: { recognize: async () => ({ text: "FOLHA DE PONTO\nCompetencia: 0l/20Z7", confidence: 35 }) },
		});
		assert.equal(result.ocrApplied, true);
		assert.equal(result.lowConfidence, true, "confiança baixa precisa ser sinalizada");
		assert.equal(result.ocrConfidence, 35);
	});

	it("tenta a próxima estratégia quando a primeira falha", async () => {
		let chamadas = 0;
		const result = await lerPagina({
			extractRaster: async () => rasterFake,
			renderWithPdftoppm: async () => Buffer.from("png"),
			ocr: {
				recognize: async () => {
					chamadas += 1;
					if (chamadas === 1) throw new Error("falhou a imagem extraída");
					return { text: textoFolha, confidence: 88 };
				},
			},
		});
		assert.equal(chamadas, 2);
		assert.equal(result.ocrApplied, true);
		assert.equal(result.ocrStrategy, "poppler");
	});

	it("marca OCR indisponível quando não existe nenhuma estratégia", async () => {
		const result = await lerPagina({});
		assert.equal(result.ocrUnavailable, true);
		assert.equal(result.ocrApplied, false);
		assert.equal(result.text, "");
	});

	it("marca OCR indisponível quando o motor de OCR falha em todas as estratégias", async () => {
		const result = await lerPagina({
			extractRaster: async () => rasterFake,
			renderWithPdftoppm: async () => Buffer.from("png"),
			ocr: {
				recognize: async () => {
					throw new Error("modelo de idioma indisponível");
				},
			},
		});
		assert.equal(result.ocrUnavailable, true);
		assert.equal(result.ocrApplied, false);
	});
});
