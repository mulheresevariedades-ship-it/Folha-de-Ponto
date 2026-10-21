import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { extractPageRaster } from "./pdf-raster";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Página A4 com a folha digitalizada desenhada por cima (é o que um scanner gera). */
async function scannedPdf(options: { jpeg?: boolean; textPages?: number } = {}) {
	const file = options.jpeg ? "folha-digitalizada.jpg" : "folha-digitalizada.png";
	const bytes = await readFile(path.join(fixtures, file));
	const document = await PDFDocument.create();
	for (let index = 0; index < (options.textPages ?? 0); index += 1) {
		const textPage = document.addPage([595.28, 841.89]);
		const font = await document.embedFont(StandardFonts.Helvetica);
		textPage.drawText(`Folha de ponto em texto - pagina ${index + 1}`, { x: 60, y: 780, size: 14, font });
	}
	const page = document.addPage([595.28, 841.89]);
	const image = options.jpeg ? await document.embedJpg(bytes) : await document.embedPng(bytes);
	page.drawImage(image, { x: 0, y: 0, width: 595.28, height: 841.89 });
	return Buffer.from(await document.save());
}

/** PDF só com texto (sem imagem): o caso em que o OCR precisa do poppler. */
async function textOnlyPdf() {
	const document = await PDFDocument.create();
	const page = document.addPage([595.28, 841.89]);
	const font = await document.embedFont(StandardFonts.Helvetica);
	page.drawText("FOLHA DE PONTO - Competencia: 01/2027", { x: 60, y: 780, size: 14, font });
	return Buffer.from(await document.save());
}

describe("extractPageRaster", () => {
	it("extrai a imagem de um PDF digitalizado (PNG embutido)", async () => {
		const pdf = await scannedPdf();
		const raster = await extractPageRaster(pdf, 1);
		assert.ok(raster, "a imagem da página digitalizada deve ser extraída");
		assert.equal(raster.format, "png");
		// A imagem do fixture tem 1654x2339 pixels a 200 DPI numa página A4.
		assert.equal(raster.width, 1654);
		assert.equal(raster.height, 2339);
		assert.equal(raster.dpi, 200);
		assert.ok(raster.bytes.subarray(0, 8).equals(PNG_SIGNATURE), "o resultado deve ser um PNG válido");
	});

	it("entrega o JPEG intacto quando a página é uma imagem JPEG", async () => {
		const original = await readFile(path.join(fixtures, "folha-digitalizada.jpg"));
		const pdf = await scannedPdf({ jpeg: true });
		const raster = await extractPageRaster(pdf, 1);
		assert.ok(raster);
		assert.equal(raster.format, "jpeg");
		assert.equal(raster.width, 600);
		assert.equal(raster.height, 848);
		// Sem recompressão: os bytes são exatamente os do arquivo original.
		assert.ok(raster.bytes.equals(original), "o JPEG deve ser entregue sem recomprimir");
	});

	it("devolve null quando a página não tem imagem", async () => {
		const pdf = await textOnlyPdf();
		assert.ok((await extractPageRaster(pdf, 1)) === null, "página só de texto não tem imagem");
	});

	it("lê a página certa em um PDF misto (texto + digitalizada)", async () => {
		const pdf = await scannedPdf({ textPages: 1 });
		assert.ok((await extractPageRaster(pdf, 1)) === null, "a primeira página é só texto");
		const raster = await extractPageRaster(pdf, 2);
		assert.ok(raster, "a segunda página é a digitalizada");
		assert.equal(raster.format, "png");
		assert.equal(raster.width, 1654);
	});

	it("devolve null para uma página que não existe", async () => {
		const pdf = await scannedPdf();
		assert.ok((await extractPageRaster(pdf, 9)) === null);
	});

	it("devolve null para um arquivo que não é PDF", async () => {
		assert.ok((await extractPageRaster(Buffer.from("isto nao e um pdf"), 1)) === null);
	});
});
