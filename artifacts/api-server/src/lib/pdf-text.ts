/**
 * Extração do texto de um PDF em JavaScript puro.
 *
 * Por que existe: a leitura de folha de ponto depende de duas ferramentas que
 * não acompanham o sistema:
 *
 * - `pdftotext`/`pdftoppm` (poppler) precisam estar instalados no sistema;
 * - o OCR (`tesseract.js`) precisa do `poppler` para gerar a imagem da página.
 *
 * Na Vercel não há binários de sistema e, no modo portátil, o computador do
 * operador raramente tem o poppler. Sem uma alternativa interna, todo PDF
 * chegava sem competência reconhecida e caía no preenchimento manual.
 *
 * A leitura feita aqui é a *camada de texto* do PDF (o que um editor de texto
 * enxergaria). Ela resolve o caso comum — folha de ponto exportada por um
 * sistema, por Word ou por Excel — sem depender de nada externo. PDF digitalizado
 * (imagem) continua dependendo do OCR; nesse caso o chamador decide.
 */
import {
	decodePDFRawStream,
	PDFArray,
	PDFDict,
	PDFDocument,
	PDFName,
	PDFNumber,
	PDFRawStream,
	PDFRef,
	PDFStream,
	type PDFObject,
} from "pdf-lib";

export type PdfPageText = {
	pageNumber: number;
	text: string;
};

/** Tabela de uma fonte: código -> texto. */
type FontMap = {
	/** Chave do recurso (ex.: "F1") -> fonte. */
	byResource: Map<string, FontTable>;
};

type FontTable = {
	/** Código -> texto, quando a fonte tem /ToUnicode. */
	toUnicode: Map<number, string>;
	/** Quantidade de bytes por código (1 para fonte simples, 2 para Type0). */
	codeLength: number;
};

const MIN_TEXT_LENGTH = 24;

/* ------------------------------------------------------------------ *
 * Leitura dos dicionários do PDF
 * ------------------------------------------------------------------ */

function resolve(context: PDFDocument["context"], object: PDFObject | undefined): PDFObject | undefined {
	if (!object) return undefined;
	if (object instanceof PDFRef) return context.lookup(object);
	return object;
}

/** Bytes do fluxo, já sem os filtros de compressão. */
function decodedStreamBytes(stream: PDFStream): Uint8Array {
	if (stream instanceof PDFRawStream) {
		try {
			return decodePDFRawStream(stream).decode();
		} catch {
			// Filtro desconhecido: segue com os bytes crus.
			return stream.getContents();
		}
	}
	return stream.getContents();
}

/** Os fluxos de conteúdo de uma página, na ordem. */
export function pageContentStreams(
	context: PDFDocument["context"],
	page: ReturnType<PDFDocument["getPages"]>[number],
): Uint8Array[] {
	const contents = page.node.Contents();
	const streams: Uint8Array[] = [];
	const push = (object: PDFObject | undefined) => {
		const resolved = resolve(context, object);
		if (resolved instanceof PDFStream) streams.push(decodedStreamBytes(resolved));
	};
	if (contents instanceof PDFArray) {
		for (const item of contents.asArray()) push(item);
	} else if (contents) {
		push(contents);
	}
	return streams;
}

/* ------------------------------------------------------------------ *
 * Tabelas /ToUnicode
 * ------------------------------------------------------------------ */

function hexToBytes(hex: string): Uint8Array {
	const clean = hex.replace(/[^0-9a-fA-F]/g, "");
	const even = clean.length % 2 === 0 ? clean : `${clean}0`;
	const out = new Uint8Array(even.length / 2);
	for (let index = 0; index < out.length; index += 1) {
		out[index] = Number.parseInt(even.slice(index * 2, index * 2 + 2), 16);
	}
	return out;
}

/** Texto Unicode a partir de uma sequência de unidades UTF-16BE. */
function utf16beToString(hex: string): string {
	const bytes = hexToBytes(hex);
	if (bytes.length % 2 === 1) {
		const padded = new Uint8Array(bytes.length + 1);
		padded.set(bytes);
		return Buffer.from(padded).swap16().toString("utf16le");
	}
	return Buffer.from(bytes).swap16().toString("utf16le");
}

function hexToCode(hex: string): number {
	return Number.parseInt(hex.replace(/[^0-9a-fA-F]/g, "") || "0", 16);
}

/**
 * Lê o CMap de uma fonte e devolve o mapa código -> texto.
 *
 * São usados os blocos `codespacerange` (tamanho do código), `bfchar`
 * (mapeamento direto) e `bfrange` (faixa).
 */
function parseToUnicode(content: string): { toUnicode: Map<number, string>; codeLength: number } {
	const toUnicode = new Map<number, string>();
	let codeLength = 0;

	const spaceRange = content.match(/begincodespacerange([\s\S]*?)endcodespacerange/);
	if (spaceRange) {
		const pairs = spaceRange[1].match(/<([0-9a-fA-F]*)>\s*<([0-9a-fA-F]*)>/g) ?? [];
		if (pairs.length) {
			const first = pairs[0]?.match(/<([0-9a-fA-F]*)>/);
			if (first?.[1]) codeLength = Math.max(1, Math.floor(first[1].length / 2));
		}
	}

	const charBlock = content.match(/beginbfchar([\s\S]*?)endbfchar/);
	if (charBlock) {
		const pairs = charBlock[1].match(/<([0-9a-fA-F]*)>\s*<([0-9a-fA-F]*)>/g) ?? [];
		for (const pair of pairs) {
			const match = pair.match(/<([0-9a-fA-F]*)>\s*<([0-9a-fA-F]*)>/);
			if (!match) continue;
			toUnicode.set(hexToCode(match[1]), utf16beToString(match[2]));
		}
	}

	const rangeBlock = content.match(/beginbfrange([\s\S]*?)endbfrange/);
	if (rangeBlock) {
		const lines = rangeBlock[1]
			.split(/[\r\n]+/)
			.map((line) => line.trim())
			.filter((line) => line.startsWith("<"));
		for (const line of lines) {
			const range = line.match(/^<([0-9a-fA-F]*)>\s*<([0-9a-fA-F]*)>\s*(.*)$/);
			if (!range) continue;
			const low = hexToCode(range[1]);
			const high = hexToCode(range[2]);
			const rest = range[3].trim();
			if (rest.startsWith("[")) {
				const items = rest.match(/<([0-9a-fA-F]*)>/g) ?? [];
				items.forEach((item, offset) => {
					const hex = item.replace(/[<>]/g, "");
					toUnicode.set(low + offset, utf16beToString(hex));
				});
				continue;
			}
			const target = rest.match(/<([0-9a-fA-F]*)>/);
			if (!target) continue;
			const base = utf16beToString(target[1]);
			if (!base) continue;
			const start = base.codePointAt(0) ?? 0;
			for (let code = low; code <= high && code - low < 65536; code += 1) {
				toUnicode.set(code, String.fromCodePoint(start + (code - low)));
			}
		}
	}

	return { toUnicode, codeLength };
}

/** As fontes declaradas nos recursos da página. */
function pageFonts(
	context: PDFDocument["context"],
	page: ReturnType<PDFDocument["getPages"]>[number],
): FontMap {
	const byResource = new Map<string, FontTable>();
	// `lookupMaybe` resolve a referência indireta (/Resources 5 0 R), comum em
	// PDFs gerados por sistemas de folha.
	const resources = page.node.lookupMaybe(PDFName.of("Resources"), PDFDict);
	const fontDict = resources?.lookupMaybe(PDFName.of("Font"), PDFDict);
	if (!fontDict) return { byResource };

	for (const [name, object] of fontDict.entries()) {
		const font = resolve(context, object);
		if (!(font instanceof PDFDict)) continue;
		const table: FontTable = { toUnicode: new Map(), codeLength: 1 };
		const toUnicodeObject = resolve(context, font.lookupMaybe(PDFName.of("ToUnicode"), PDFStream));
		if (toUnicodeObject instanceof PDFStream) {
			const content = Buffer.from(decodedStreamBytes(toUnicodeObject)).toString("latin1");
			const parsed = parseToUnicode(content);
			table.toUnicode = parsed.toUnicode;
			table.codeLength = parsed.codeLength || 1;
		}
		const subtype = font.lookupMaybe(PDFName.of("Subtype"), PDFName);
		if (subtype?.asString() === "Type0" && table.toUnicode.size === 0) {
			// Fonte composta sem /ToUnicode: os códigos são índices de glifo e
			// não há como convertê-los em texto.
			table.codeLength = 2;
		}
		byResource.set(name.asString().replace(/^\//, ""), table);
	}
	return { byResource };
}

/* ------------------------------------------------------------------ *
 * Tokenizador do fluxo de conteúdo
 * ------------------------------------------------------------------ */

export type Token =
	| { kind: "string"; bytes: Uint8Array }
	| { kind: "name"; value: string }
	| { kind: "number"; value: number }
	| { kind: "array"; items: Token[] }
	| { kind: "operator"; value: string }
	| { kind: "other" };

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

function isRegular(character: number): boolean {
	return !WHITESPACE.has(character) && !DELIMITERS.has(character);
}

/** Converte a sequência de escape de uma string literal do PDF. */
function readLiteralString(source: Uint8Array, start: number): { bytes: Uint8Array; end: number } {
	const out: number[] = [];
	let index = start + 1;
	let depth = 1;
	while (index < source.length) {
		const character = source[index];
		if (character === 0x5c) {
			const next = source[index + 1];
			index += 2;
			if (next === 0x6e) out.push(0x0a);
			else if (next === 0x72) out.push(0x0d);
			else if (next === 0x74) out.push(0x09);
			else if (next === 0x62) out.push(0x08);
			else if (next === 0x66) out.push(0x0c);
			else if (next === 0x0a) continue;
			else if (next === 0x0d) {
				if (source[index] === 0x0a) index += 1;
				continue;
			} else if (next >= 0x30 && next <= 0x37) {
				let octal = String.fromCharCode(next);
				while (octal.length < 3 && source[index] >= 0x30 && source[index] <= 0x37) {
					octal += String.fromCharCode(source[index]);
					index += 1;
				}
				out.push(Number.parseInt(octal, 8) & 0xff);
			} else if (next !== undefined) {
				out.push(next);
			}
			continue;
		}
		if (character === 0x28) depth += 1;
		if (character === 0x29) {
			depth -= 1;
			if (depth === 0) {
				index += 1;
				break;
			}
		}
		out.push(character);
		index += 1;
	}
	return { bytes: Uint8Array.from(out), end: index };
}

/**
 * Separa o fluxo de conteúdo em operandos e operadores.
 *
 * Exportado porque a extração da imagem da página (usada pelo OCR) precisa
 * dos mesmos tokens para descobrir quais imagens são desenhadas e onde.
 */
export function tokenizeContentStream(source: Uint8Array): Token[] {
	const tokens: Token[] = [];
	let index = 0;
	while (index < source.length) {
		const character = source[index];
		if (WHITESPACE.has(character)) {
			index += 1;
			continue;
		}
		if (character === 0x28) {
			const literal = readLiteralString(source, index);
			tokens.push({ kind: "string", bytes: literal.bytes });
			index = literal.end;
			continue;
		}
		if (character === 0x3c && source[index + 1] !== 0x3c) {
			const close = source.indexOf(0x3e, index);
			const end = close === -1 ? source.length : close;
			tokens.push({ kind: "string", bytes: hexToBytes(Buffer.from(source.subarray(index + 1, end)).toString("latin1")) });
			index = end + 1;
			continue;
		}
		if (character === 0x2f) {
			let end = index + 1;
			while (end < source.length && isRegular(source[end])) end += 1;
			tokens.push({ kind: "name", value: Buffer.from(source.subarray(index + 1, end)).toString("latin1") });
			index = end;
			continue;
		}
		if (character === 0x5b) {
			// Vetor: os itens são lidos recursivamente.
			const items: Token[] = [];
			let depth = 1;
			index += 1;
			while (index < source.length && depth > 0) {
				const inner = source[index];
				if (WHITESPACE.has(inner)) {
					index += 1;
					continue;
				}
				if (inner === 0x5b) {
					depth += 1;
					index += 1;
					continue;
				}
				if (inner === 0x5d) {
					depth -= 1;
					index += 1;
					continue;
				}
				if (inner === 0x28) {
					const literal = readLiteralString(source, index);
					items.push({ kind: "string", bytes: literal.bytes });
					index = literal.end;
					continue;
				}
				if (inner === 0x3c && source[index + 1] !== 0x3c) {
					const close = source.indexOf(0x3e, index);
					const end = close === -1 ? source.length : close;
					items.push({ kind: "string", bytes: hexToBytes(Buffer.from(source.subarray(index + 1, end)).toString("latin1")) });
					index = end + 1;
					continue;
				}
				if (inner === 0x2f) {
					let end = index + 1;
					while (end < source.length && isRegular(source[end])) end += 1;
					items.push({ kind: "name", value: Buffer.from(source.subarray(index + 1, end)).toString("latin1") });
					index = end;
					continue;
				}
				if (isRegular(inner)) {
					let end = index;
					while (end < source.length && isRegular(source[end])) end += 1;
					const word = Buffer.from(source.subarray(index, end)).toString("latin1");
					if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
						items.push({ kind: "number", value: Number(word) });
					} else {
						items.push({ kind: "operator", value: word });
					}
					index = end;
					continue;
				}
				index += 1;
			}
			tokens.push({ kind: "array", items });
			continue;
		}
		if (isRegular(character)) {
			let end = index;
			while (end < source.length && isRegular(source[end])) end += 1;
			const word = Buffer.from(source.subarray(index, end)).toString("latin1");
			if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
				tokens.push({ kind: "number", value: Number(word) });
			} else {
				tokens.push({ kind: "operator", value: word });
			}
			index = end;
			continue;
		}
		index += 1;
	}
	return tokens;
}

/* ------------------------------------------------------------------ *
 * Texto
 * ------------------------------------------------------------------ */

/** Converte os bytes de uma string PDF no texto correspondente à fonte. */
function decodeBytes(bytes: Uint8Array, font: FontTable | undefined): string {
	if (!font) {
		// Sem informação de fonte: Latin-1 preserva os caracteres ASCII, que é
		// o que interessa para mês, matrícula e nome.
		return Buffer.from(bytes).toString("latin1");
	}
	if (font.toUnicode.size === 0) {
		return Buffer.from(bytes).toString("latin1");
	}
	let out = "";
	let index = 0;
	const width = font.codeLength;
	while (index < bytes.length) {
		let code = 0;
		if (width === 2) {
			if (index + 1 >= bytes.length) break;
			code = (bytes[index] << 8) | bytes[index + 1];
			index += 2;
		} else {
			code = bytes[index];
			index += 1;
		}
		out += font.toUnicode.get(code) ?? "";
	}
	return out;
}

/**
 * Ajustes negativos grandes dentro de um array `TJ` representam um espaço
 * entre palavras. O valor é dado em milésimos de espaço de texto: um
 * espacejamento de palavra costuma ficar acima de 150, enquanto o kerning entre
 * letras fica abaixo disso.
 */
const WORD_GAP = 150;

function textFromTokens(tokens: Token[], fonts: FontMap): string {
	let out = "";
	let currentFont: FontTable | undefined;
	const operands: Token[] = [];

	const flush = (token: Token | undefined) => {
		if (!token) return;
		if (token.kind === "string") {
			out += decodeBytes(token.bytes, currentFont);
			return;
		}
		if (token.kind === "array") {
			for (const item of token.items) {
				if (item.kind === "string") {
					out += decodeBytes(item.bytes, currentFont);
				} else if (item.kind === "number" && item.value <= -WORD_GAP) {
					out += " ";
				}
			}
		}
	};

	for (const token of tokens) {
		if (token.kind === "operator") {
			switch (token.value) {
				case "Tf": {
					const name = [...operands].reverse().find((item) => item.kind === "name");
					currentFont = name && name.kind === "name" ? fonts.byResource.get(name.value) : undefined;
					break;
				}
				case "Tj":
				case "TJ":
				case "'":
				case '"':
					flush([...operands].reverse().find((item) => item.kind === "string" || item.kind === "array"));
					if (token.value === "'" || token.value === '"') out += "\n";
					break;
				case "Td":
				case "TD":
				case "T*":
				case "Tm":
					out += "\n";
					break;
				default:
					break;
			}
			operands.length = 0;
			continue;
		}
		operands.push(token);
	}
	return out;
}

/** Texto de uma página: a concatenação dos seus fluxos de conteúdo. */
function pageText(context: PDFDocument["context"], page: ReturnType<PDFDocument["getPages"]>[number]): string {
	const fonts = pageFonts(context, page);
	const parts: string[] = [];
	for (const stream of pageContentStreams(context, page)) {
		try {
			parts.push(textFromTokens(tokenizeContentStream(stream), fonts));
		} catch {
			// Página ilegível: as demais páginas do arquivo continuam válidas.
		}
	}
	return parts.join("\n");
}

/**
 * Texto de todas as páginas do PDF.
 *
 * Devolve uma entrada por página; páginas sem camada de texto vêm com string
 * vazia (o chamador pode então recorrer ao OCR).
 */
export async function extractPdfPageTexts(buffer: Buffer): Promise<PdfPageText[]> {
	const document = await PDFDocument.load(buffer, {
		ignoreEncryption: true,
		updateMetadata: false,
		throwOnInvalidObject: false,
	});
	const context = document.context;
	return document.getPages().map((page, index) => ({
		pageNumber: index + 1,
		text: pageText(context, page),
	}));
}

/** Texto bruto do PDF inteiro, com as páginas separadas por quebra de linha. */
export async function extractPdfText(buffer: Buffer): Promise<string> {
	const pages = await extractPdfPageTexts(buffer);
	return pages
		.map((page) => page.text)
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** O PDF tem camada de texto aproveitável? */
export function hasUsableText(text: string): boolean {
	return text.replace(/\s+/g, " ").trim().length >= MIN_TEXT_LENGTH;
}
