/**
 * OCR das páginas digitalizadas, sem depender do `poppler`.
 *
 * O motor é o `tesseract.js` (WASM puro, já usado pelo projeto). O que era
 * impeditivo até aqui era a *imagem*: o `pdftoppm` do poppler gerava o PNG
 * da página e ele não existe na Vercel nem no modo portátil. Agora a imagem vem
 * do próprio arquivo (`pdf-raster.ts`), então o OCR funciona nos dois ambientes.
 *
 * O modelo de idioma acompanha o programa: no modo portátil ele é copiado
 * para `tessdata/` dentro do pacote e na Vercel o build o embaraça na
 * função. Só quando não há modelo local a API o baixa do CDN — e, mesmo
 * assim, com limite de tempo, para não prender a requisição.
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

/**
 * Tempo máximo de uma leitura de OCR (carregar o modelo + ler a imagem).
 *
 * Sem esse limite, uma rede lenta ou indisponível — o caso da Vercel
 * baixando o modelo do CDN — prende a requisição até o servidor derrubar
 * ela. Estourado o tempo, a página é marcada para conferência manual: é
 * melhor do que inventar dado ou travar o lote.
 */
const DEFAULT_TIMEOUT_MS = 60_000;

function ocrTimeoutMs(): number {
	const raw = Number(process.env.PONTO_OCR_TIMEOUT_MS ?? "");
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`Tempo limite do OCR excedido (${label}).`)), ms);
				timer.unref?.();
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

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

async function ensureWorker(deadline: number): Promise<Worker> {
	const { langPath, languages } = resolveLanguageAssets();
	const key = `${langPath ?? "cdn"}|${languages.join("+")}`;
	if (activeWorker && activeKey === key) return activeWorker;
	if (activeWorker) {
		await activeWorker.terminate().catch(() => undefined);
		activeWorker = null;
	}
	const creating = createWorker(languages.join("+"), undefined, {
		langPath,
		cachePath: resolveCachePath(),
		logger: () => undefined,
		errorHandler: () => {
			// O worker falhou (ou foi congelado e morreu): o próximo OCR
			// precisa de um worker novo.
			activeWorker = null;
			activeKey = "";
		},
	});
	// Se o tempo estourar enquanto o motor ainda está subindo, o worker que
	// chegar depois é encerrado — ele não pode ficar rodando à toa.
	let cancelado = false;
	const vigia = creating.then((tardio) => {
		if (cancelado) {
			void tardio.terminate().catch(() => undefined);
			throw new Error("Motor de OCR cancelado.");
		}
		return tardio;
	});
	try {
		const worker = await withTimeout(vigia, Math.max(1, deadline - Date.now()), "motor de OCR");
		activeWorker = worker;
		activeKey = key;
		return worker;
	} catch (error) {
		cancelado = true;
		throw error;
	}
}

/** Lê o texto de uma imagem (PNG ou JPEG). */
export async function recognizeImage(image: Buffer): Promise<OcrOutcome> {
	const deadline = Date.now() + ocrTimeoutMs();
	const worker = await ensureWorker(deadline);
	const pending = worker.recognize(image);
	try {
		const result = await withTimeout(
			pending,
			Math.max(1, deadline - Date.now()),
			"leitura da imagem",
		);
		const confidence = result.data.confidence;
		return {
			text: result.data.text ?? "",
			confidence: Number.isFinite(confidence) ? Math.round(confidence) : 0,
		};
	} catch (error) {
		// O worker é "abandonado": o `tesseract.js` pode ainda estar
		// mandando a imagem para ele. Encerrá-lo nesse instante faz a
		// biblioteca tentar falar com um worker morto, o que vira uma
		// rejeição não tratada e derruba o processo — o encerramento espera
		// o trabalho pendente terminar.
		activeWorker = null;
		activeKey = "";
		void pending.then(
			() => worker.terminate().catch(() => undefined),
			() => worker.terminate().catch(() => undefined),
		);
		throw error;
	}
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
