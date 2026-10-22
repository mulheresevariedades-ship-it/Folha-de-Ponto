/**
 * Embarca o runtime do OCR no pacote do programa.
 *
 * O `tesseract.js` é externo no bundle (não dá para embutir: ele carrega o
 * núcleo WASM por caminho de arquivo). Em tempo de execução ele resolve:
 *
 * - o script do worker por caminho (`new Worker(workerPath)`);
 * - o núcleo WASM por `require('tesseract.js-core/...')`.
 *
 * Nenhum dos dois é um `require` estático do ponto de entrada, então o
 * empacotador do deploy não os acompanha: o worker nunca sobe, a promessa
 * nunca resolve e o OCR trava até o prazo. É o que acontecia na Vercel.
 *
 * Aqui o conjunto é copiado para `<dist>/ocr/tesseract/node_modules`, e o
 * OCR aponta para lá (`ocr.ts`). Com isso o runtime do OCR não depende do
 * `node_modules` do servidor: vale para a Vercel e para o modo portátil.
 */
import { existsSync, realpathSync } from "node:fs";
import { cp, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Pacotes que o worker do OCR carrega em tempo de execução. */
const DEPENDENCIAS = ["bmp-js", "is-url", "regenerator-runtime", "wasm-feature-detect"];

/**
 * Variantes do núcleo WASM.
 *
 * O worker escolhe uma conforme os recursos da CPU (`wasm-feature-detect`) e
 * conforme o modo do motor (`oem`). Todas as variantes entram no pacote: a
 * escolha acontece em tempo de execução e um arquivo faltando derruba a
 * leitura com "Cannot find module".
 */
const NUCLEOS = [
	"tesseract-core-relaxedsimd-lstm",
	"tesseract-core-relaxedsimd",
	"tesseract-core-simd-lstm",
	"tesseract-core-simd",
	"tesseract-core-lstm",
	"tesseract-core",
];

/**
 * Procura a pasta de um pacote a partir de um diretório.
 *
 * Serve para os dois layouts: o do pnpm (os irmãos ficam em
 * `node_modules/.pnpm/<pacote>@<versão>/node_modules`) e o plano ( tudo em
 * `node_modules`).
 */
export function acharPacote(partida, nome) {
	let dir = partida;
	for (;;) {
		const candidato = path.join(dir, "node_modules", nome);
		if (existsSync(candidato)) return realpathSync(candidato);
		const pai = path.dirname(dir);
		if (pai === dir) return null;
		dir = pai;
	}
}

async function tamanhoDe(arquivo) {
	try {
		const info = await stat(arquivo);
		return info.size;
	} catch {
		return 0;
	}
}

/**
 * Copia o runtime do OCR para `destino/ocr/tesseract/node_modules`.
 *
 * Devolve um resumo do que foi copiado (para o log do build).
 */
export async function copyOcrRuntime(destino) {
	const base = path.join(destino, "ocr", "tesseract", "node_modules");
	const pastaTesseract = acharPacote(path.dirname(fileURLToPath(import.meta.url)), "tesseract.js");
	if (!pastaTesseract) {
		return { ok: false, motivo: "tesseract.js não está instalado", arquivos: 0, bytes: 0 };
	}

	await mkdir(base, { recursive: true });
	let arquivos = 0;
	let bytes = 0;

	// O pacote do `tesseract.js`: só `src` (o worker) e o `package.json`
	// (o worker lê a versão do pacote). A pasta `dist` é o bundle do
	// navegador e não é usada aqui.
	const destinoTesseract = path.join(base, "tesseract.js");
	await mkdir(destinoTesseract, { recursive: true });
	await cp(path.join(pastaTesseract, "package.json"), path.join(destinoTesseract, "package.json"));
	arquivos += 1;
	bytes += await tamanhoDe(path.join(destinoTesseract, "package.json"));
	if (existsSync(path.join(pastaTesseract, "src"))) {
		await cp(path.join(pastaTesseract, "src"), path.join(destinoTesseract, "src"), {
			recursive: true,
		});
		const arquivosSrc = await cpCount(path.join(destinoTesseract, "src"));
		arquivos += arquivosSrc;
	}

	// O núcleo WASM: o carregador (`.js`) e o binário (`.wasm`) precisam
	// ficar na mesma pasta — o carregador procura o `.wasm` por `__dirname`.
	const pastaCore = acharPacote(pastaTesseract, "tesseract.js-core");
	if (pastaCore) {
		const destinoCore = path.join(base, "tesseract.js-core");
		await mkdir(destinoCore, { recursive: true });
		for (const nucleo of NUCLEOS) {
			for (const extensao of [".js", ".wasm"]) {
				const arquivo = path.join(pastaCore, `${nucleo}${extensao}`);
				if (!existsSync(arquivo)) continue;
				await cp(arquivo, path.join(destinoCore, `${nucleo}${extensao}`));
				arquivos += 1;
				bytes += await tamanhoDe(path.join(destinoCore, `${nucleo}${extensao}`));
			}
		}
	}

	// As dependências pequenas que o worker carrega.
	for (const dependencia of DEPENDENCIAS) {
		const pasta = acharPacote(pastaTesseract, dependencia);
		if (!pasta) continue;
		const destinoDependencia = path.join(base, dependencia);
		await cp(pasta, destinoDependencia, { recursive: true });
		arquivos += await cpCount(destinoDependencia);
		bytes += await tamanhoDe(pasta);
	}

	return { ok: true, motivo: "", arquivos, bytes };
}

/** Conta os arquivos de uma pasta (para o resumo do build). */
async function cpCount(pasta) {
	let total = 0;
	let filas = [pasta];
	while (filas.length > 0) {
		const atual = filas.pop();
		let entradas = [];
		try {
			entradas = await readdir(atual, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entrada of entradas) {
			if (entrada.isDirectory()) filas.push(path.join(atual, entrada.name));
			else total += 1;
		}
	}
	return total;
}
