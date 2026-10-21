/**
 * Imagem de uma página de PDF, extraída em JavaScript puro.
 *
 * Por que existe: o OCR precisa de uma imagem e, até aqui, essa imagem era
 * gerada pelo `pdftoppm` (poppler). Na Vercel não há binários de sistema e, no
 * modo portátil, o computador do operador raramente tem o poppler instalado —
 * o que fazia todo PDF digitalizado cair na conferência manual.
 *
 * Um PDF digitalizado é, na prática, uma imagem colocada sobre a página: o
 * arquivo guarda a imagem (JPEG, PNG ou bits crus) e a posição em que ela é
 * desenhada. Este módulo lê essa imagem direto do arquivo, sem depender de
 * binário externo, e a entrega pronta para o OCR:
 *
 * - JPEG (`DCTDecode`): os bytes do fluxo já são um JPEG e vão intactos;
 * - imagem em bits crus (`FlateDecode`): as amostras viram PNG;
 * - máscara de 1 bit (`ImageMask`): vira PNG em tons de cinza.
 *
 * Quando a página não tem imagem (folha vetorial, por exemplo), o módulo
 * devolve `null` e o chamador decide: tenta o `pdftoppm` ou manda para a
 * conferência manual.
 */
import {
	PDFArray,
	PDFBool,
	PDFDict,
	PDFDocument,
	PDFName,
	PDFNumber,
	PDFRawStream,
	PDFRef,
	PDFStream,
	type PDFObject,
} from "pdf-lib";
import { deflateSync, inflateSync } from "node:zlib";
import { pageContentStreams, tokenizeContentStream, type Token } from "./pdf-text";

export type RasterFormat = "png" | "jpeg";

export type PageRaster = {
	/** Bytes da imagem, prontos para o OCR. */
	bytes: Buffer;
	format: RasterFormat;
	width: number;
	height: number;
	/** Resolução efetiva da imagem entregue ao OCR. */
	dpi: number;
};

/** Resolução usada quando não dá para aproveitar a resolução da imagem. */
const DEFAULT_DPI = 150;
/** Faixa útil de resolução para OCR (abaixo disso a leitura perde acerto). */
const MIN_DPI = 100;
const MAX_DPI = 300;
/** Fração da página que a imagem precisa cobrir para ser tratada como digitalização. */
const FULL_PAGE_COVERAGE = 0.8;

/* ------------------------------------------------------------------ *
 * Matrizes
 * ------------------------------------------------------------------ */

type Matrix = { a: number; b: number; c: number; d: number; e: number; f: number };

const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function multiply(m: Matrix, n: Matrix): Matrix {
	return {
		a: m.a * n.a + m.b * n.c,
		b: m.a * n.b + m.b * n.d,
		c: m.c * n.a + m.d * n.c,
		d: m.c * n.b + m.d * n.d,
		e: m.e * n.a + m.f * n.c + n.e,
		f: m.e * n.b + m.f * n.d + n.f,
	};
}

function transform(m: Matrix, x: number, y: number): { x: number; y: number } {
	return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

/* ------------------------------------------------------------------ *
 * Leitura do dicionário
 * ------------------------------------------------------------------ */

function resolve(context: PDFDocument["context"], object: PDFObject | undefined): PDFObject | undefined {
	if (!object) return undefined;
	if (object instanceof PDFRef) return context.lookup(object);
	return object;
}

function numberOf(dict: PDFDict, key: string, fallback: number): number {
	const value = dict.lookupMaybe(PDFName.of(key), PDFNumber);
	return value ? value.asNumber() : fallback;
}

function filterNames(dict: PDFDict): string[] {
	const filter = dict.lookup(PDFName.of("Filter"));
	if (filter instanceof PDFName) return [filter.asString()];
	if (filter instanceof PDFArray) {
		return filter
			.asArray()
			.map((item) => (item instanceof PDFName ? item.asString() : ""))
			.filter((name) => name.length > 0);
	}
	return [];
}

/* ------------------------------------------------------------------ *
 * Espaço de cores
 * ------------------------------------------------------------------ */

type ColorSpaceInfo = {
	kind: "gray" | "rgb" | "cmyk" | "indexed";
	/** Componentes por pixel do espaço base. */
	components: number;
	/** Paleta (bytes) do espaço indexado. */
	palette?: Uint8Array;
};

function componentsFor(count: number): ColorSpaceInfo | null {
	if (count === 1) return { kind: "gray", components: 1 };
	if (count === 3) return { kind: "rgb", components: 3 };
	if (count === 4) return { kind: "cmyk", components: 4 };
	return null;
}

function parseColorSpace(context: PDFDocument["context"], object: PDFObject | undefined): ColorSpaceInfo | null {
	const resolved = resolve(context, object);
	if (resolved instanceof PDFName) {
		switch (resolved.asString()) {
			case "/DeviceGray":
				return { kind: "gray", components: 1 };
			case "/DeviceRGB":
				return { kind: "rgb", components: 3 };
			case "/DeviceCMYK":
				return { kind: "cmyk", components: 4 };
			default:
				return null;
		}
	}
	if (!(resolved instanceof PDFArray)) return null;
	const items = resolved.asArray();
	const family = items[0];
	if (!(family instanceof PDFName)) return null;
	switch (family.asString()) {
		case "/ICCBased": {
			const stream = resolve(context, items[1]);
			if (stream instanceof PDFStream) {
				return componentsFor(numberOf(stream.dict, "N", 0));
			}
			if (items[1] instanceof PDFNumber) return componentsFor(items[1].asNumber());
			return null;
		}
		case "/CalRGB":
			return { kind: "rgb", components: 3 };
		case "/CalGray":
			return { kind: "gray", components: 1 };
		case "/Indexed": {
			const base = parseColorSpace(context, items[1]);
			if (!base) return null;
			const lookup = resolve(context, items[3]);
			if (!(lookup instanceof PDFStream)) return null;
			const bytes = decodeFilters(lookup.getContents(), filterNames(lookup.dict), lookup.dict);
			if (!bytes || bytes.kind !== "raw") return null;
			return { kind: "indexed", components: 1, palette: bytes.bytes };
		}
		default:
			return null;
	}
}

/* ------------------------------------------------------------------ *
 * Filtros de fluxo
 * ------------------------------------------------------------------ */

type DecodedStream = { kind: "raw"; bytes: Uint8Array } | { kind: "jpeg"; bytes: Uint8Array };

function decodeParmsAt(dict: PDFDict, index: number): PDFDict | null {
	const parms = dict.lookup(PDFName.of("DecodeParms"));
	if (parms instanceof PDFDict) return parms;
	if (parms instanceof PDFArray) {
		const item = parms.lookupMaybe(index, PDFDict);
		return item ?? null;
	}
	return null;
}

/** Remove o predetor PNG/TIFF aplicado antes da compressão. */
function undoPredictor(data: Uint8Array, parms: PDFDict | null): Uint8Array {
	if (!parms) return data;
	const predictor = numberOf(parms, "Predictor", 1);
	if (predictor <= 1) return data;
	const colors = numberOf(parms, "Colors", 1);
	const bits = numberOf(parms, "BitsPerComponent", 8);
	const columns = numberOf(parms, "Columns", 1);
	const bytesPerPixel = Math.max(1, Math.ceil((colors * bits) / 8));
	const rowLength = Math.ceil((colors * bits * columns) / 8);

	if (predictor === 2) {
		// Predetor TIFF: soma byte a byte da mesma coluna da linha anterior.
		if (bits !== 8) return data;
		for (let offset = 0; offset + rowLength <= data.length; offset += rowLength) {
			for (let i = bytesPerPixel; i < rowLength; i += 1) {
				data[offset + i] = (data[offset + i] + data[offset + i - bytesPerPixel]) & 0xff;
			}
		}
		return data;
	}

	// Preditores PNG (10 a 15): cada linha começa com o tipo do filtro.
	const rows: Uint8Array[] = [];
	let previous = new Uint8Array(rowLength);
	let position = 0;
	while (position + 1 + rowLength <= data.length) {
		const type = data[position];
		position += 1;
		const row = data.slice(position, position + rowLength);
		position += rowLength;
		switch (type) {
			case 0:
				break;
			case 1:
				for (let i = bytesPerPixel; i < rowLength; i += 1) row[i] = (row[i] + row[i - bytesPerPixel]) & 0xff;
				break;
			case 2:
				for (let i = 0; i < rowLength; i += 1) row[i] = (row[i] + previous[i]) & 0xff;
				break;
			case 3:
				for (let i = 0; i < rowLength; i += 1) {
					const left = i >= bytesPerPixel ? row[i - bytesPerPixel] : 0;
					row[i] = (row[i] + ((left + previous[i]) >> 1)) & 0xff;
				}
				break;
			case 4: {
				for (let i = 0; i < rowLength; i += 1) {
					const left = i >= bytesPerPixel ? row[i - bytesPerPixel] : 0;
					const up = previous[i];
					const upLeft = i >= bytesPerPixel ? previous[i - bytesPerPixel] : 0;
					const p = left + up - upLeft;
					const pa = Math.abs(p - left);
					const pb = Math.abs(p - up);
					const pc = Math.abs(p - upLeft);
					const value = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
					row[i] = (row[i] + value) & 0xff;
				}
				break;
			}
			default:
				return data;
		}
		rows.push(row);
		previous = row;
	}
	const out = new Uint8Array(rows.length * rowLength);
	rows.forEach((row, index) => out.set(row, index * rowLength));
	return out;
}

function asciiHexDecode(data: Uint8Array): Uint8Array {
	const out: number[] = [];
	let value = -1;
	for (const byte of data) {
		if (byte === 0x3e) break;
		const digit = byte >= 0x30 && byte <= 0x39 ? byte - 0x30 : byte >= 0x41 && byte <= 0x46 ? byte - 0x37 : byte >= 0x61 && byte <= 0x66 ? byte - 0x57 : -1;
		if (digit < 0) continue;
		value = value < 0 ? digit : value * 16 + digit;
		if (value >= 0x10) {
			out.push(value & 0xff);
			value = -1;
		}
	}
	if (value >= 0) out.push((value << 4) & 0xff);
	return Uint8Array.from(out);
}

function ascii85Decode(data: Uint8Array): Uint8Array {
	const out: number[] = [];
	let group: number[] = [];
	let index = 0;
	while (index < data.length) {
		const byte = data[index];
		index += 1;
		if (byte === 0x7e) break; // "~>" encerra
		if (byte <= 0x20) continue;
		if (byte === 0x7a && group.length === 0) {
			out.push(0, 0, 0, 0);
			continue;
		}
		group.push(byte - 33);
		if (group.length === 5) {
			let value = 0;
			for (const digit of group) value = value * 85 + digit;
			out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
			group = [];
		}
	}
	if (group.length > 0) {
		const count = group.length;
		while (group.length < 5) group.push(84);
		let value = 0;
		for (const digit of group) value = value * 85 + digit;
		const bytes = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
		for (let i = 0; i < count - 1; i += 1) out.push(bytes[i]);
	}
	return Uint8Array.from(out);
}

function runLengthDecode(data: Uint8Array): Uint8Array {
	const out: number[] = [];
	let index = 0;
	while (index < data.length) {
		const length = data[index];
		index += 1;
		if (length === 128) break;
		if (length < 128) {
			for (let i = 0; i <= length && index < data.length; i += 1) {
				out.push(data[index]);
				index += 1;
			}
			continue;
		}
		const byte = data[index];
		index += 1;
		for (let i = 0; i < 257 - length; i += 1) out.push(byte);
	}
	return Uint8Array.from(out);
}

function lzwDecode(data: Uint8Array, earlyChange: number): Uint8Array {
	const out: number[] = [];
	const dictionary: number[][] = [];
	const reset = () => {
		dictionary.length = 0;
		for (let i = 0; i < 256; i += 1) dictionary.push([i]);
		dictionary.push([], []); // 256 = clear, 257 = EOD
	};
	reset();
	let codeWidth = 9;
	let previous: number[] | null = null;
	let bitBuffer = 0;
	let bitCount = 0;
	for (const byte of data) {
		bitBuffer = (bitBuffer << 8) | byte;
		bitCount += 8;
		while (bitCount >= codeWidth) {
			const code = (bitBuffer >> (bitCount - codeWidth)) & ((1 << codeWidth) - 1);
			bitCount -= codeWidth;
			if (code === 256) {
				reset();
				codeWidth = 9;
				previous = null;
				continue;
			}
			if (code === 257) return Uint8Array.from(out);
			let entry: number[];
			if (code < dictionary.length && dictionary[code].length > 0) entry = dictionary[code];
			else if (previous) entry = [...previous, previous[0]];
			else return Uint8Array.from(out);
			out.push(...entry);
			if (previous) dictionary.push([...previous, entry[0]]);
			previous = entry;
			const limit = dictionary.length + (earlyChange ? 1 : 0);
			if (limit >= 512 && codeWidth === 9) codeWidth = 10;
			else if (limit >= 1024 && codeWidth === 10) codeWidth = 11;
			else if (limit >= 2048 && codeWidth === 11) codeWidth = 12;
		}
	}
	return Uint8Array.from(out);
}

/**
 * Aplica os filtros do fluxo.
 *
 * Devolve `jpeg` quando o último filtro é `DCTDecode` (os bytes restantes já
 * são um JPEG) e `raw` quando sobraram amostras.
 */
function decodeFilters(
	data: Uint8Array,
	filters: string[],
	dict: PDFDict,
): DecodedStream | null {
	let current = data;
	for (let index = 0; index < filters.length; index += 1) {
		const filter = filters[index];
		if (filter === "/DCTDecode") return { kind: "jpeg", bytes: current };
		if (filter === "/JPXDecode" || filter === "/CCITTFaxDecode" || filter === "/JBIG2Decode") return null;
		if (filter === "/FlateDecode") {
			try {
				current = inflateSync(current);
			} catch {
				return null;
			}
			current = undoPredictor(current, decodeParmsAt(dict, index));
			continue;
		}
		if (filter === "/LZWDecode") {
			const parms = decodeParmsAt(dict, index);
			const earlyChange = parms ? numberOf(parms, "EarlyChange", 1) : 1;
			current = lzwDecode(current, earlyChange);
			continue;
		}
		if (filter === "/ASCIIHexDecode") {
			current = asciiHexDecode(current);
			continue;
		}
		if (filter === "/ASCII85Decode") {
			current = ascii85Decode(current);
			continue;
		}
		if (filter === "/RunLengthDecode") {
			current = runLengthDecode(current);
			continue;
		}
		return null;
	}
	return { kind: "raw", bytes: current };
}

/* ------------------------------------------------------------------ *
 * Imagens
 * ------------------------------------------------------------------ */

type ImageAsset = {
	width: number;
	height: number;
	bitsPerComponent: number;
	colorSpace: ColorSpaceInfo | null;
	isMask: boolean;
	inverted: boolean;
	/** Amostras por pixel já expandidas (quando a imagem não é JPEG). */
	samples: Uint8Array | null;
	/** JPEG pronto para uso (quando a imagem é JPEG). */
	jpeg: Buffer | null;
};

function readImageAsset(
	context: PDFDocument["context"],
	stream: PDFRawStream | PDFStream,
): ImageAsset | null {
	const dict = stream.dict;
	const subtype = dict.lookupMaybe(PDFName.of("Subtype"), PDFName);
	if (subtype?.asString() !== "/Image") return null;
	const width = numberOf(dict, "Width", 0);
	const height = numberOf(dict, "Height", 0);
	if (width <= 0 || height <= 0) return null;

	const isMask = dict.lookup(PDFName.of("ImageMask"));
	const maskValue = isMask instanceof PDFBool ? isMask.asBoolean() : false;

	const decodeArray = dict.lookup(PDFName.of("Decode"));
	let inverted = false;
	if (decodeArray instanceof PDFArray) {
		const first = decodeArray.lookupMaybe(0, PDFNumber);
		const second = decodeArray.lookupMaybe(1, PDFNumber);
		if (first && second && first.asNumber() > second.asNumber()) inverted = true;
	}

	const filters = filterNames(dict);
	const decoded = decodeFilters(stream.getContents(), filters, dict);
	if (!decoded) return null;

	const bitsPerComponent = isMask ? 1 : numberOf(dict, "BitsPerComponent", 8);
	const colorSpace = isMask ? { kind: "gray" as const, components: 1 } : parseColorSpace(context, dict.lookup(PDFName.of("ColorSpace")));

	if (decoded.kind === "jpeg") {
		return {
			width,
			height,
			bitsPerComponent,
			colorSpace,
			isMask: maskValue,
			inverted,
			samples: null,
			jpeg: Buffer.from(decoded.bytes),
		};
	}

	const components = colorSpace?.components ?? 1;
	const expected = Math.ceil((width * height * components * bitsPerComponent) / 8);
	if (decoded.bytes.length < expected) return null;

	return {
		width,
		height,
		bitsPerComponent,
		colorSpace,
		isMask: maskValue,
		inverted,
		samples: decoded.bytes,
		jpeg: null,
	};
}

/* ------------------------------------------------------------------ *
 * Pixels
 * ------------------------------------------------------------------ */

type DecodedPixels = {
	width: number;
	height: number;
	channels: 1 | 3;
	data: Uint8Array;
};

/** Expande as amostras para um valor por componente e por pixel. */
function expandSamples(
	samples: Uint8Array,
	width: number,
	height: number,
	bits: number,
	components: number,
): Uint8Array | null {
	const total = width * height * components;
	const out = new Uint8Array(total);
	if (bits === 8) {
		if (samples.length < total) return null;
		out.set(samples.subarray(0, total));
		return out;
	}
	if (bits === 16) {
		if (samples.length < total * 2) return null;
		for (let index = 0; index < total; index += 1) out[index] = samples[index * 2];
		return out;
	}
	if (bits !== 1 && bits !== 2 && bits !== 4) return null;
	const rowBytes = Math.ceil((width * components * bits) / 8);
	const max = (1 << bits) - 1;
	let index = 0;
	for (let row = 0; row < height; row += 1) {
		let bitPosition = 0;
		for (let pixel = 0; pixel < width * components; pixel += 1) {
			const byteIndex = row * rowBytes + (bitPosition >> 3);
			if (byteIndex >= samples.length) return null;
			const shift = 8 - bits - (bitPosition & 7);
			out[index] = (samples[byteIndex] >> shift) & max;
			index += 1;
			bitPosition += bits;
		}
	}
	return out;
}

/** Converte as amostras expandidas em pixels RGB (ou cinza, quando monocromático). */
function pixelsFromSamples(asset: ImageAsset, expanded: Uint8Array): DecodedPixels | null {
	const { width, height } = asset;
	const space = asset.colorSpace;
	if (!space) return null;

	if (asset.isMask) {
		// Máscara de 1 bit: 0 = pintado (tinta), 1 = não pintado (papel).
		const data = new Uint8Array(width * height);
		for (let index = 0; index < width * height; index += 1) {
			const painted = asset.inverted ? expanded[index] === 1 : expanded[index] === 0;
			data[index] = painted ? 0 : 255;
		}
		return { width, height, channels: 1, data };
	}

	const rgb = new Uint8Array(width * height * 3);
	const components = space.components;
	for (let index = 0; index < width * height; index += 1) {
		const base = index * components;
		let r = 0;
		let g = 0;
		let b = 0;
		if (space.kind === "indexed") {
			const palette = space.palette ?? new Uint8Array(0);
			const offset = expanded[index] * components;
			if (space.components === 1) {
				r = palette[offset] ?? 0;
				g = r;
				b = r;
			} else {
				r = palette[offset] ?? 0;
				g = palette[offset + 1] ?? 0;
				b = palette[offset + 2] ?? 0;
			}
		} else if (components === 1) {
			r = expanded[base];
			g = r;
			b = r;
		} else if (components === 3) {
			r = expanded[base];
			g = expanded[base + 1];
			b = expanded[base + 2];
		} else {
			const c = expanded[base];
			const m = expanded[base + 1];
			const y = expanded[base + 2];
			const k = expanded[base + 3];
			r = 255 - Math.min(255, c + k);
			g = 255 - Math.min(255, m + k);
			b = 255 - Math.min(255, y + k);
		}
		if (asset.inverted) {
			r = 255 - r;
			g = 255 - g;
			b = 255 - b;
		}
		rgb[index * 3] = r;
		rgb[index * 3 + 1] = g;
		rgb[index * 3 + 2] = b;
	}

	// Folha de ponto é quase sempre monocromática: guardar em cinza reduz o PNG pela metade.
	let monochrome = true;
	for (let index = 0; index < rgb.length; index += 3) {
		if (rgb[index] !== rgb[index + 1] || rgb[index] !== rgb[index + 2]) {
			monochrome = false;
			break;
		}
	}
	if (!monochrome) return { width, height, channels: 3, data: rgb };
	const gray = new Uint8Array(width * height);
	for (let index = 0; index < gray.length; index += 1) gray[index] = rgb[index * 3];
	return { width, height, channels: 1, data: gray };
}

/* ------------------------------------------------------------------ *
 * PNG
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let index = 0; index < 256; index += 1) {
		let value = index;
		for (let bit = 0; bit < 8; bit += 1) {
			value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		}
		table[index] = value >>> 0;
	}
	return table;
})();

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (let index = 0; index < bytes.length; index += 1) {
		crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length, 0);
	const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body), 0);
	return Buffer.concat([length, body, crc]);
}

/** Codifica um PNG de 8 bits por canal (cinza ou RGB). */
export function encodePng(pixels: DecodedPixels): Buffer {
	const { width, height, channels, data } = pixels;
	const stride = width * channels;
	const raw = Buffer.alloc((stride + 1) * height);
	for (let row = 0; row < height; row += 1) {
		const target = row * (stride + 1);
		raw[target] = 0; // filtro "None"
		Buffer.from(data.buffer, data.byteOffset + row * stride, stride).copy(raw, target + 1);
	}
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8; // bits por canal
	header[9] = channels === 1 ? 0 : 2; // cinza ou RGB
	header[10] = 0;
	header[11] = 0;
	header[12] = 0;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", header),
		pngChunk("IDAT", deflateSync(raw, { level: 6 })),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

/* ------------------------------------------------------------------ *
 * Composição da página
 * ------------------------------------------------------------------ */

type Placement = {
	asset: ImageAsset;
	/** Retângulo da imagem na página, em pontos. */
	left: number;
	top: number;
	width: number;
	height: number;
};

function placedImages(context: PDFDocument["context"], page: ReturnType<PDFDocument["getPages"]>[number]): Placement[] {
	const xobjects = (() => {
		const resources = page.node.Resources();
		if (!resources) return null;
		return resources.lookupMaybe(PDFName.of("XObject"), PDFDict);
	})();
	if (!xobjects) return [];

	const streams = pageContentStreams(context, page);
	const stack: Matrix[] = [];
	let ctm = IDENTITY;
	const operands: Token[] = [];
	const placements: Placement[] = [];

	for (const stream of streams) {
		for (const token of tokenizeContentStream(stream)) {
			if (token.kind !== "operator") {
				operands.push(token);
				continue;
			}
			switch (token.value) {
				case "q":
					stack.push(ctm);
					break;
				case "Q":
					ctm = stack.pop() ?? IDENTITY;
					break;
				case "cm": {
					const numbers = operands
						.filter((item): item is { kind: "number"; value: number } => item.kind === "number")
						.map((item) => item.value);
					if (numbers.length >= 6) {
						const [a, b, c, d, e, f] = numbers.slice(-6);
						ctm = multiply({ a, b, c, d, e, f }, ctm);
					}
					break;
				}
				case "Do": {
					const name = [...operands].reverse().find((item) => item.kind === "name");
					if (name && name.kind === "name") {
						const reference = xobjects.lookup(PDFName.of(name.value));
						const resolved = resolve(context, reference);
						if (resolved instanceof PDFRawStream || resolved instanceof PDFStream) {
							const asset = readImageAsset(context, resolved);
							if (asset) {
								const corners = [
									transform(ctm, 0, 0),
									transform(ctm, 1, 0),
									transform(ctm, 0, 1),
									transform(ctm, 1, 1),
								];
								const xs = corners.map((corner) => corner.x);
								const ys = corners.map((corner) => corner.y);
								const left = Math.min(...xs);
								const right = Math.max(...xs);
								const bottom = Math.min(...ys);
								const top = Math.max(...ys);
								placements.push({
									asset,
									left,
									top,
									width: right - left,
									height: top - bottom,
								});
							}
						}
					}
					break;
				}
				default:
					break;
			}
			operands.length = 0;
		}
	}
	return placements;
}

/** Média dos pixels da origem cobertos por um pixel do destino (amostragem por área). */
function sampleArea(
	pixels: DecodedPixels,
	sourceX: number,
	sourceY: number,
	sourceXEnd: number,
	sourceYEnd: number,
): { r: number; g: number; b: number } {
	const channels = pixels.channels;
	const x0 = Math.max(0, Math.floor(sourceX));
	const y0 = Math.max(0, Math.floor(sourceY));
	const x1 = Math.min(pixels.width - 1, Math.ceil(sourceXEnd) - 1);
	const y1 = Math.min(pixels.height - 1, Math.ceil(sourceYEnd) - 1);
	if (x1 < x0 || y1 < y0) {
		const clampedX = Math.min(pixels.width - 1, Math.max(0, Math.round(sourceX)));
		const clampedY = Math.min(pixels.height - 1, Math.max(0, Math.round(sourceY)));
		const offset = (clampedY * pixels.width + clampedX) * channels;
		const value = pixels.data[offset];
		return channels === 1 ? { r: value, g: value, b: value } : { r: value, g: pixels.data[offset + 1], b: pixels.data[offset + 2] };
	}
	let r = 0;
	let g = 0;
	let b = 0;
	let count = 0;
	for (let y = y0; y <= y1; y += 1) {
		for (let x = x0; x <= x1; x += 1) {
			const offset = (y * pixels.width + x) * channels;
			if (channels === 1) {
				r += pixels.data[offset];
				g += pixels.data[offset];
				b += pixels.data[offset];
			} else {
				r += pixels.data[offset];
				g += pixels.data[offset + 1];
				b += pixels.data[offset + 2];
			}
			count += 1;
		}
	}
	if (count === 0) return { r: 255, g: 255, b: 255 };
	return { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count) };
}

/**
 * Desenha as imagens da página em uma tela do tamanho da página.
 *
 * A resolução vem da própria imagem quando ela cobre a página inteira (assim
 * o papel não é reamostrado e o OCR lê com a resolução original); caso
 * contrário, usa uma resolução fixa.
 */
function composePage(
	placements: Placement[],
	pageWidth: number,
	pageHeight: number,
): { pixels: DecodedPixels; dpi: number } | null {
	const usable = placements.filter((placement) => placement.width > 0 && placement.height > 0);
	if (!usable.length) return null;
	const pageArea = Math.max(1, pageWidth * pageHeight);
	const dominant = usable.reduce((best, placement) =>
		placement.width * placement.height > best.width * best.height ? placement : best,
	);

	let dpi = DEFAULT_DPI;
	const coverage = (dominant.width * dominant.height) / pageArea;
	if (coverage >= FULL_PAGE_COVERAGE) {
		const native = dominant.asset.width / (dominant.width / 72);
		dpi = Math.min(MAX_DPI, Math.max(MIN_DPI, Math.round(native)));
	}
	const canvasWidth = Math.max(1, Math.round((pageWidth * dpi) / 72));
	const canvasHeight = Math.max(1, Math.round((pageHeight * dpi) / 72));
	const canvas = new Uint8Array(canvasWidth * canvasHeight * 3).fill(255);

	for (const placement of usable) {
		const expanded = placement.asset.samples
			? expandSamples(
					placement.asset.samples,
					placement.asset.width,
					placement.asset.height,
					placement.asset.bitsPerComponent,
					placement.asset.colorSpace?.components ?? 1,
				)
			: null;
		if (!expanded) continue;
		const pixels = pixelsFromSamples(placement.asset, expanded);
		if (!pixels) continue;

		// Posição na página -> posição na tela (a origem do PDF é embaixo à esquerda).
		const left = (placement.left / 72) * dpi;
		const top = ((pageHeight - placement.top) / 72) * dpi;
		const width = (placement.width / 72) * dpi;
		const height = (placement.height / 72) * dpi;
		const scaleX = pixels.width / width;
		const scaleY = pixels.height / height;

		const x0 = Math.max(0, Math.floor(left));
		const y0 = Math.max(0, Math.floor(top));
		const x1 = Math.min(canvasWidth - 1, Math.ceil(left + width) - 1);
		const y1 = Math.min(canvasHeight - 1, Math.ceil(top + height) - 1);
		for (let y = y0; y <= y1; y += 1) {
			for (let x = x0; x <= x1; x += 1) {
				const sourceX = (x - left) * scaleX;
				const sourceY = (y - top) * scaleY;
				const sample = sampleArea(pixels, sourceX, sourceY, sourceX + scaleX, sourceY + scaleY);
				const offset = (y * canvasWidth + x) * 3;
				canvas[offset] = sample.r;
				canvas[offset + 1] = sample.g;
				canvas[offset + 2] = sample.b;
			}
		}
	}

	// Converte para cinza quando a página for monocromática.
	let monochrome = true;
	for (let index = 0; index < canvas.length; index += 3) {
		if (canvas[index] !== canvas[index + 1] || canvas[index] !== canvas[index + 2]) {
			monochrome = false;
			break;
		}
	}
	if (monochrome) {
		const gray = new Uint8Array(canvasWidth * canvasHeight);
		for (let index = 0; index < gray.length; index += 1) gray[index] = canvas[index * 3];
		return { pixels: { width: canvasWidth, height: canvasHeight, channels: 1, data: gray }, dpi };
	}
	return { pixels: { width: canvasWidth, height: canvasHeight, channels: 3, data: canvas }, dpi };
}

/* ------------------------------------------------------------------ *
 * API
 * ------------------------------------------------------------------ */

/**
 * Imagem da página, pronta para o OCR.
 *
 * Devolve `null` quando a página não tem imagem aproveitável (folha vetorial,
 * por exemplo) — nesse caso o chamador pode tentar o `pdftoppm` ou enviar a
 * página para a conferência manual.
 */
export async function extractPageRaster(buffer: Buffer, pageNumber: number): Promise<PageRaster | null> {
	let document: PDFDocument;
	try {
		document = await PDFDocument.load(buffer, {
			ignoreEncryption: true,
			updateMetadata: false,
			throwOnInvalidObject: false,
		});
	} catch {
		return null;
	}
	const page = document.getPages()[pageNumber - 1];
	if (!page) return null;

	let placements: Placement[];
	try {
		placements = placedImages(document.context, page);
	} catch {
		return null;
	}
	if (!placements.length) return null;

	const size = page.getSize();
	const rotation = page.getRotation().angle;
	const swap = rotation === 90 || rotation === 270;
	const pageWidth = swap ? size.height : size.width;
	const pageHeight = swap ? size.width : size.height;

	// Caso comum: a página é uma única imagem JPEG que cobre o papel.
	// Os bytes vão intactos: sem recompressão e sem perda de qualidade.
	const dominant = placements.reduce((best, placement) =>
		placement.width * placement.height > best.width * best.height ? placement : best,
	);
	const coverage = (dominant.width * dominant.height) / Math.max(1, pageWidth * pageHeight);
	if (dominant.asset.jpeg && placements.length === 1 && coverage >= FULL_PAGE_COVERAGE) {
		const native = dominant.asset.width / (dominant.width / 72);
		return {
			bytes: dominant.asset.jpeg,
			format: "jpeg",
			width: dominant.asset.width,
			height: dominant.asset.height,
			dpi: Math.min(MAX_DPI, Math.max(MIN_DPI, Math.round(native))),
		};
	}

	const composed = composePage(placements, pageWidth, pageHeight);
	if (!composed) return null;
	return {
		bytes: encodePng(composed.pixels),
		format: "png",
		width: composed.pixels.width,
		height: composed.pixels.height,
		dpi: composed.dpi,
	};
}
