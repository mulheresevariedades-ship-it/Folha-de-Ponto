import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	assertPdfUpload,
	assertSpreadsheetUpload,
	hasSpreadsheetExtension,
	parseWorkloadHours,
	spreadsheetKind,
} from "./file-validation";

// Assinatura de arquivo ZIP (.xlsx moderno) e de OLE2 (.xls legado).
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE2_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

describe("spreadsheetKind", () => {
	it("reconhece .xlsx real pela assinatura ZIP", () => {
		assert.equal(spreadsheetKind(Buffer.concat([ZIP_SIGNATURE, Buffer.from("rest")])), "xlsx");
	});

	it("reconhece .xls real pela assinatura OLE2", () => {
		assert.equal(spreadsheetKind(Buffer.concat([OLE2_SIGNATURE, Buffer.from("rest")])), "xls");
	});

	it("rejeita CSV, PDF e texto puro renomeados", () => {
		assert.equal(spreadsheetKind(Buffer.from("coluna1,coluna2\na,b\n")), null);
		assert.equal(spreadsheetKind(Buffer.from("%PDF-1.7")), null);
		assert.equal(spreadsheetKind(Buffer.from("conteudo texto")), null);
		assert.equal(spreadsheetKind(Buffer.alloc(0)), null);
	});
});

describe("hasSpreadsheetExtension", () => {
	it("aceita .xlsx e .xls sem diferenciar maiúsculas", () => {
		assert.equal(hasSpreadsheetExtension("planilha.xlsx"), true);
		assert.equal(hasSpreadsheetExtension("planilha.XLS"), true);
	});

	it("rejeita outros formatos", () => {
		assert.equal(hasSpreadsheetExtension("planilha.csv"), false);
		assert.equal(hasSpreadsheetExtension("documento.pdf"), false);
		assert.equal(hasSpreadsheetExtension("sem_extensao"), false);
	});
});

describe("assertSpreadsheetUpload", () => {
	it("rejeita envio sem arquivo", () => {
		assert.throws(() => assertSpreadsheetUpload(undefined), /Selecione uma planilha/);
	});

	it("rejeita extensão não permitida mesmo com conteúdo válido", () => {
		assert.throws(
			() => assertSpreadsheetUpload({ originalname: "dados.csv", buffer: ZIP_SIGNATURE }),
			/Formato não aceito/,
		);
	});

	it("rejeita arquivo com extensão Excel mas conteúdo de outro tipo", () => {
		assert.throws(
			() => assertSpreadsheetUpload({ originalname: "falso.xlsx", buffer: Buffer.from("nao sou planilha") }),
			/não corresponde a uma planilha Excel/,
		);
	});

	it("devolve o arquivo validado para uso posterior na rota", () => {
		const upload = { originalname: "base.xlsx", buffer: Buffer.concat([ZIP_SIGNATURE, Buffer.from("rest")]) };
		assert.equal(assertSpreadsheetUpload(upload), upload);
	});
});

describe("assertPdfUpload", () => {
	it("rejeita envio sem arquivo", () => {
		assert.throws(() => assertPdfUpload(undefined), /Envie pelo menos um PDF/);
	});

	it("rejeita extensão que não é .pdf mesmo com conteúdo válido", () => {
		assert.throws(
			() => assertPdfUpload({ originalname: "folha.png", buffer: Buffer.from("%PDF-1.7 resto") }),
			/Formato não aceito/,
		);
	});

	it("rejeita arquivo com extensão .pdf mas conteúdo de outro tipo", () => {
		assert.throws(
			() => assertPdfUpload({ originalname: "falso.pdf", buffer: Buffer.from("nao sou pdf") }),
			/não corresponde a um PDF válido/,
		);
	});

	it("devolve o arquivo validado para uso posterior na rota", () => {
		const upload = { originalname: "folha.pdf", buffer: Buffer.from("%PDF-1.7 resto") };
		assert.equal(assertPdfUpload(upload), upload);
	});
});

describe("parseWorkloadHours", () => {
	it("aceita números puros e texto com sufixo de hora, comum em planilhas de RH", () => {
		assert.equal(parseWorkloadHours("40"), 40);
		assert.equal(parseWorkloadHours("20h"), 20);
		assert.equal(parseWorkloadHours("20 h"), 20);
		assert.equal(parseWorkloadHours("40 HORAS"), 40);
		assert.equal(parseWorkloadHours("36,5"), 36.5);
		assert.equal(parseWorkloadHours(" 20h"), 20);
	});

	it("devolve NaN quando o texto não começa com número inequívoco", () => {
		assert.ok(Number.isNaN(parseWorkloadHours("")));
		assert.ok(Number.isNaN(parseWorkloadHours("carga não informada")));
		assert.ok(Number.isNaN(parseWorkloadHours("h20")));
	});
});
