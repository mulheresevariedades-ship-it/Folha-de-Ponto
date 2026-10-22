/**
 * Baixa o modelo de idioma do OCR (tesseract.js) para o pacote portátil.
 *
 * Por que existe: o `tesseract.js` baixa o modelo de idioma da internet na
 * primeira execução. Na Vercel isso não é problema (a internet está lá), mas
 * no modo portátil a estação pode estar sem internet — e sem o modelo, o OCR
 * de folha digitalizada não funciona.
 *
 * O modelo é baixado uma vez (com cache no repositório) e copiado para a pasta
 * `tessdata` do pacote. Em tempo de execução a API procura essa pasta e usa
 * o modelo local; sem ela, volta para o download automático.
 *
 * Uso:
 *   node scripts/portable/fetch-tessdata.mjs
 *   node scripts/portable/fetch-tessdata.mjs --destino caminho/da/pasta
 */
import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const CDN = "https://cdn.jsdelivr.net/npm/@tesseract.js-data";

export const DEFAULT_LANGUAGES = ["por", "eng"];

function log(message) {
	console.log(`[ocr] ${message}`);
}

/**
 * Baixa (ou reaproveita do cache) os modelos de idioma.
 *
 * Devolve a lista de arquivos prontos; os que não puderam ser baixados são
 * ignorados — o OCR cai para o download automático.
 */
export async function fetchTessdata({
	target,
	languages = DEFAULT_LANGUAGES,
	cacheDir,
	quiet = false,
} = {}) {
	if (!target) throw new Error("Informe a pasta de destino dos modelos de idioma.");
	await mkdir(target, { recursive: true });
	if (cacheDir) await mkdir(cacheDir, { recursive: true });

	const ready = [];
	const falhas = [];
	for (const language of languages) {
		const fileName = `${language}.traineddata.gz`;
		const targetFile = path.join(target, fileName);
		if (existsSync(targetFile)) {
			if (!quiet) log(`${fileName} já está no pacote`);
			ready.push(targetFile);
			continue;
		}
		const cachedFile = cacheDir ? path.join(cacheDir, fileName) : null;
		if (cachedFile && existsSync(cachedFile)) {
			await copyFile(cachedFile, targetFile);
			if (!quiet) log(`${fileName} veio do cache local`);
			ready.push(targetFile);
			continue;
		}
		const url = `${CDN}/${language}/4.0.0_best_int/${fileName}`;
		try {
			const response = await fetch(url);
			if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
			await pipeline(Readable.fromWeb(response.body), createWriteStream(targetFile));
			if (cachedFile) await copyFile(targetFile, cachedFile);
			if (!quiet) log(`${fileName} baixado (${(await fileSize(targetFile))})`);
			ready.push(targetFile);
		} catch (error) {
			falhas.push(`${fileName}: ${error instanceof Error ? error.message : String(error)}`);
			if (!quiet) {
				log(`não foi possível baixar ${fileName}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
	// Um arquivo de texto na pasta registra o resultado do download: ele entra
	// no pacote da Vercel (includeFiles) e o diagnóstico da API mostra se o
	// modelo chegou a ser baixado no build.
	await writeFile(
		path.join(target, "MODELO.txt"),
		falhas.length === 0
			? `OK: ${ready.map((arquivo) => path.basename(arquivo)).join(", ")}\n`
			: `FALHA: ${falhas.join(" | ")}\n`,
		"utf8",
	);
	return ready;
}

async function fileSize(file) {
	const info = await stat(file);
	return `${(info.size / 1024 / 1024).toFixed(1)} MB`;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	const scriptDir = path.dirname(fileURLToPath(import.meta.url));
	const repoRoot = path.resolve(scriptDir, "..", "..");
	// `--destino` pode vir várias vezes: o build precisa do modelo em mais
	// de um lugar (a pasta de saída e a pasta do bundle).
	const targets = [];
	for (let index = 0; index < process.argv.length; index += 1) {
		if (process.argv[index] === "--destino" && process.argv[index + 1]) {
			targets.push(path.resolve(process.argv[index + 1]));
			index += 1;
		}
	}
	if (targets.length === 0) {
		targets.push(path.join(repoRoot, "dist-portable", "server", "tessdata"));
	}
	const cacheDir = path.join(repoRoot, "node_modules", ".cache", "tessdata");
	for (const target of targets) {
		try {
			const ready = await fetchTessdata({ target, cacheDir });
			log(`modelos prontos em ${target} (${ready.length} arquivo(s))`);
		} catch (error) {
			// O script roda dentro do build (Vercel) e do empacotador portátil:
			// falhar aqui não pode derrubar o build — o OCR volta para o
			// download automático, com limite de tempo.
			log(`modelo indisponível em ${target}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}
