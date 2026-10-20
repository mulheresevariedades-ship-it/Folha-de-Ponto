import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertSpreadsheetUpload, hasSpreadsheetExtension, spreadsheetKind } from "./file-validation";

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
