import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { extractPdfPageTexts, extractPdfText, hasUsableText } from "./pdf-text";
import { competencyFromContent, matriculaFromContent, nameFromContent } from "./timesheet-files";

/**
 * Monta um PDF cru, com fonte Type0 e tabela /ToUnicode, para testar a leitura
 * de fontes compostas (é o formato que Word, Excel e sistemas de folha usam).
 */
function buildType0Pdf(text: string): Buffer {
	const codes: number[] = [];
	const bfchar: string[] = [];
	const bfrange: string[] = [];
	const half = Math.ceil(text.length / 2);
	for (let index = 0; index < text.length; index += 1) {
		const code = 0x0020 + index * 2;
		codes.push(code);
		const target = text.charCodeAt(index).toString(16).padStart(4, "0");
		if (index % 2 === 0) {
			bfchar.push(`<${code.toString(16).padStart(4, "0")}> <${target}>`);
		} else {
			bfrange.push(`<${code.toString(16).padStart(4, "0")}> <${code.toString(16).padStart(4, "0")}> <${target}>`);
		}
	}
	const cmap = [
		"/CIDInit /ProcSet findresource begin",
		"12 dict begin",
		"begincmap",
		"/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
		"/CMapName /Adobe-Identity-UCS def",
		"/CMapType 2 def",
		"1 begincodespacerange",
		"<0000> <FFFF>",
		"endcodespacerange",
		`${bfchar.length} beginbfchar`,
		...bfchar,
		"endbfchar",
		`${bfrange.length} beginbfrange`,
		...bfrange,
		"endbfrange",
		"endcmap",
		"CMapName currentdict /CMap defineresource pop",
		"end",
		"end",
	].join("\n");

	const hex = codes.map((code) => code.toString(16).padStart(4, "0")).join("");
	const content = `BT /F1 14 Tf 72 760 Td <${hex}> Tj ET`;
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type0 /BaseFont /Teste /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>",
		`<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
		"<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Teste /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> >>",
		`<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`,
	];

	let body = "%PDF-1.7\n";
	const offsets: number[] = [];
	for (const [index, object] of objects.entries()) {
		offsets.push(Buffer.byteLength(body, "latin1"));
		body += `${index + 1} 0 obj\n${object}\nendobj\n`;
	}
	const xrefOffset = Buffer.byteLength(body, "latin1");
	body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
	body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
	return Buffer.from(body, "latin1");
}

describe("extractPdfPageTexts", () => {
	it("lê o texto de um PDF com fonte simples", async () => {
		const document = await PDFDocument.create();
		const page = document.addPage([595, 842]);
		const font = await document.embedFont(StandardFonts.Helvetica);
		page.drawText("Nome do Servidor: Maria Silva Santos", { x: 60, y: 760, size: 12, font });
		page.drawText("Competencia: 01/2027", { x: 60, y: 730, size: 12, font });
		const buffer = Buffer.from(await document.save());

		const pages = await extractPdfPageTexts(buffer);
		assert.equal(pages.length, 1);
		assert.match(pages[0].text, /Maria Silva Santos/);
		assert.match(pages[0].text, /01\/2027/);
	});

	it("lê o texto de um PDF com fonte Type0 e tabela /ToUnicode", async () => {
		const buffer = buildType0Pdf("Competencia 01/2027");
		const pages = await extractPdfPageTexts(buffer);
		assert.equal(pages.length, 1);
		assert.equal(pages[0].text.replace(/\s+/g, " ").trim(), "Competencia 01/2027");
	});

	it("devolve texto vazio para PDF sem camada de texto", async () => {
		const document = await PDFDocument.create();
		document.addPage([595, 842]);
		const buffer = Buffer.from(await document.save());
		const pages = await extractPdfPageTexts(buffer);
		assert.equal(pages.length, 1);
		assert.equal(pages[0].text.trim(), "");
	});

	it("separa as páginas do arquivo", async () => {
		const document = await PDFDocument.create();
		const font = await document.embedFont(StandardFonts.Helvetica);
		for (const label of ["Pagina um", "Pagina dois"]) {
			const page = document.addPage([595, 842]);
			page.drawText(label, { x: 60, y: 760, size: 12, font });
		}
		const buffer = Buffer.from(await document.save());
		const pages = await extractPdfPageTexts(buffer);
		assert.equal(pages.length, 2);
		assert.match(pages[0].text, /Pagina um/);
		assert.match(pages[1].text, /Pagina dois/);
	});
});

describe("hasUsableText", () => {
	it("ignora textos curtos demais", () => {
		assert.equal(hasUsableText("ok"), false);
		assert.equal(hasUsableText("a".repeat(40)), true);
	});
});

describe("leitura do PDF somada ao reconhecimento da folha", () => {
	it("reconhece competência, nome e matrícula a partir do texto extraído", async () => {
		const document = await PDFDocument.create();
		const page = document.addPage([595, 842]);
		const font = await document.embedFont(StandardFonts.Helvetica);
		page.drawText("Nome do Servidor: Maria Silva Santos", { x: 60, y: 760, size: 12, font });
		page.drawText("Matricula: 1234567", { x: 60, y: 740, size: 12, font });
		page.drawText("Competencia: 01/2027", { x: 60, y: 720, size: 12, font });
		const buffer = Buffer.from(await document.save());

		const text = await extractPdfText(buffer);
		assert.equal(competencyFromContent(text), "2027-01");
		assert.equal(matriculaFromContent(text), "1234567");
		assert.equal(nameFromContent(text), "Maria Silva Santos");
	});
});
