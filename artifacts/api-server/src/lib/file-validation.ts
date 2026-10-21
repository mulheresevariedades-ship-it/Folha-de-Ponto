import path from "node:path";

export type SpreadsheetKind = "xlsx" | "xls";

export const spreadsheetExtensions = [".xlsx", ".xls"] as const;

/**
 * Validates the real content of an Excel upload instead of trusting the file
 * extension. CSV, PDF, TXT and renamed files are rejected with a clear message.
 */
export function spreadsheetKind(buffer: Buffer): SpreadsheetKind | null {
	if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && [0x03, 0x05, 0x07].includes(buffer[2])) {
		return "xlsx";
	}
	const ole = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
	if (buffer.length >= ole.length && ole.every((byte, index) => buffer[index] === byte)) {
		return "xls";
	}
	return null;
}

export function hasSpreadsheetExtension(filename: string): boolean {
	return spreadsheetExtensions.includes(path.extname(filename).toLowerCase() as (typeof spreadsheetExtensions)[number]);
}

/**
 * Carga horária chega frequente como "20h", "20 h" ou "40 HORAS" em planilhas
 * reais de RH. Extrai o número inicial em vez de rejeitar a linha inteira;
 * devolve NaN quando não há número inequívoco no começo do texto.
 */
export function parseWorkloadHours(raw: string): number {
	const match = raw.trim().match(/^\d+(?:[.,]\d+)?/);
	return match ? Number(match[0].replace(",", ".")) : Number.NaN;
}

export function assertSpreadsheetUpload(file: { originalname: string; buffer: Buffer } | undefined): {
	originalname: string;
	buffer: Buffer;
} {
	if (!file) {
		throw new Error("Selecione uma planilha .xlsx ou .xls.");
	}
	if (!hasSpreadsheetExtension(file.originalname)) {
		throw new Error("Formato não aceito. Envie apenas planilhas .xlsx ou .xls. CSV, PDF e TXT não são permitidos.");
	}
	if (!spreadsheetKind(file.buffer)) {
		throw new Error(
			"O conteúdo do arquivo não corresponde a uma planilha Excel válida. Reexporte o arquivo como .xlsx ou .xls.",
		);
	}
	return file;
}

/**
 * Assinatura de um PDF: o cabeçalho `%PDF-`.
 *
 * A extensão `.pdf` não é confiável — um arquivo renomeado passa no teste de
 * extensão e quebra na leitura. O mesmo cuidado já vale para planilhas.
 */
export function isPdfBuffer(buffer: Buffer): boolean {
	return buffer.length >= 5 && buffer.subarray(0, 5).toString("latin1") === "%PDF-";
}

/**
 * Valida um PDF enviado: a extensão precisa ser `.pdf` e o conteúdo precisa
 * ter a assinatura de um PDF de verdade.
 *
 * @throws Error com a mensagem adequada ao usuário quando o arquivo não é um
 * PDF válido.
 */
export function assertPdfUpload(file: { originalname: string; buffer: Buffer } | undefined): {
	originalname: string;
	buffer: Buffer;
} {
	if (!file) {
		throw new Error("Envie pelo menos um PDF.");
	}
	if (path.extname(file.originalname).toLowerCase() !== ".pdf") {
		throw new Error("Formato não aceito. Envie apenas arquivos .pdf.");
	}
	if (!isPdfBuffer(file.buffer)) {
		throw new Error("O conteúdo do arquivo não corresponde a um PDF válido.");
	}
	return file;
}
