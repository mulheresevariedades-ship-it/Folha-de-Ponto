/**
 * OCR das páginas digitalizadas, sem depender do `poppler`.
 *
 * O motor é o `tesseract.js` (WASM puro, já usado pelo projeto). O que era
 * impeditivo até aqui era a *imagem*: o `pdftoppm` do poppler gerava o PNG
 * da página e ele não existe na Vercel nem no modo portátil. Agora a imagem vem
 * do próprio arquivo (`pdf-raster.ts`), então o OCR funciona nos dois ambientes.
 *
 * O modelo de idioma é baixado da internet na primeira uso. No modo portátil
 * ele é copiado junto com o pacote (`tessdata/`), e o caminho local é usado
 * quando existe — assim o OCR também funciona sem internet.
 */
import { createWorker, type Worker } from "tesseract.js";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type OcrOutcome = {
	/** Texto lido na imagem. */
	text: string;
	/** Confiança do OCR, de 0 a 100. */
	confidence: number;
};

/** Motor de OCR usado pela leitura das páginas (trocável nos testes). */
export type OcrEngine = {
	recognize(image: Buffer): Promise<OcrOutcome>;
};

/** Confiança mínima para confiar no que o OCR leu. */
export const OCR_MIN_CONFIDENCE = 60;

const DEFAULT_LANGUAGES = "por+eng";

function configuredLanguages(): string[] {
	const raw = process.env.PONTO_OCR_LANGUAGES ?? DEFAULT_LANGUAGES;
	return raw
		.split("+")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

/**
 * Onde estão os modelos de idioma.
 *
 * Prioridade:
 * 1. `PONTO_TESSDATA_PATH` (apontado pelo operador);
 * 2. a pasta `tessdata` ao lado do bundle (modo portátil);
 * 3. internet (padrão do `tesseract.js`).
 */
function resolveLanguageAssets(): { langPath?: string; languages: string[] } {
	const languages = configuredLanguages();
	const candidates: string[] = [];
	if (process.env.PONTO_TESSDATA_PATH) candidates.push(process.env.PONTO_TESSDATA_PATH);
	try {
		candidates.push(path.join(path.dirname(fileURLToPath(import.meta.url)), "tessdata"));
	} catch {
		// Bundle sem `import.meta.url`: segue com o download.
	}
	for (const candidate of candidates) {
		if (!candidate || !existsSync(candidate)) continue;
		const available = languages.filter((language) => existsSync(path.join(candidate, `${language}.traineddata.gz`)));
		if (available.length > 0) return { langPath: candidate, languages: available };
	}
	return { languages };
}

/** Pasta de cache do modelo de idioma (evita baixar de novo a cada reinício). */
function resolveCachePath(): string {
	const dir = process.env.PONTO_OCR_CACHE ?? path.join(os.tmpdir(), "ponto-ocr-cache");
	try {
		mkdirSync(dir, { recursive: true });
	} catch {
		// Sem permissão de escrita: o `tesseract.js` apenas não guarda cache.
	}
	return dir;
}

let activeWorker: Worker | null = null;
let activeKey = "";

async function ensureWorker(): Promise<Worker> {
	const { langPath, languages } = resolveLanguageAssets();
	const key = `${langPath ?? "cdn"}|${languages.join("+")}`;
	if (activeWorker && activeKey === key) return activeWorker;
	if (activeWorker) {
		await activeWorker.terminate().catch(() => undefined);
		activeWorker = null;
	}
	const worker = await createWorker(languages.join("+"), undefined, {
		langPath,
		cachePath: resolveCachePath(),
		logger: () => undefined,
		errorHandler: () => undefined,
	});
	activeWorker = worker;
	activeKey = key;
	return worker;
}

/** Lê o texto de uma imagem (PNG ou JPEG). */
export async function recognizeImage(image: Buffer): Promise<OcrOutcome> {
	const worker = await ensureWorker();
	const result = await worker.recognize(image);
	const confidence = result.data.confidence;
	return {
		text: result.data.text ?? "",
		confidence: Number.isFinite(confidence) ? Math.round(confidence) : 0,
	};
}

/** Encerra o worker de OCR (usado no fim de cada lote). */
export async function terminateOcr(): Promise<void> {
	if (!activeWorker) return;
	const worker = activeWorker;
	activeWorker = null;
	activeKey = "";
	await worker.terminate().catch(() => undefined);
}

/** O OCR está disponível neste ambiente? */
export function isOcrAvailable(): boolean {
	try {
		createRequire(import.meta.url).resolve("tesseract.js");
		return true;
	} catch {
		return false;
	}
}
