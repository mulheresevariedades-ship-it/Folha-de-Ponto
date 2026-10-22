/**
 * Empacota o modo portátil em `dist-portable/`, pronto para copiar para um
 * pendrive ou pasta de rede e executar sem instalar nada.
 *
 * Layout gerado:
 *
 *   dist-portable/
 *     Iniciar-Ponto.bat      inicializador (duplo clique)
 *     server/portable.mjs    API + banco embutido + interface
 *     server/front/          interface compilada
 *     server/migrations/     migrações SQL do banco
 *     server/node_modules/@electric-sql/pglite/   binários do banco embutido
 *     runtime/node.exe       Node embutido (quando disponível)
 *
 * Uso:
 *   node scripts/portable/package.mjs
 *   node scripts/portable/package.mjs --runtime "C:\caminho\para\node"
 *
 * Sem `--runtime`, procura o Node atual e o `NODE_PORTABLE_RUNTIME`; se não
 * achar, o pacote sai sem o runtime e depende do Node instalado na estação.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchTessdata } from "./fetch-tessdata.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");
const outputDir = path.join(repoRoot, "dist-portable");
const serverDir = path.join(outputDir, "server");

function log(message) {
	console.log(`[portatil] ${message}`);
}

function run(command, args, options = {}) {
	execFileSync(command, args, { stdio: "inherit", cwd: repoRoot, shell: process.platform === "win32", ...options });
}

function resolveRuntimeDir() {
	const flagIndex = process.argv.indexOf("--runtime");
	const candidate = flagIndex !== -1
		? process.argv[flagIndex + 1]
		: process.env.NODE_PORTABLE_RUNTIME;

	if (!candidate) return null;

	const resolved = path.resolve(candidate);
	// Aceita tanto a pasta do Node quanto o caminho direto do executável.
	if (resolved.endsWith("node.exe") || path.basename(resolved) === "node") {
		return path.dirname(resolved);
	}
	return resolved;
}

function copyDirectory(from, to, { filter } = {}) {
	if (!existsSync(from)) throw new Error(`Não encontrado: ${from}`);
	// O pnpm organiza as dependências em pastas com symlink; `dereference`
	// copia o conteúdo real em vez de tentar recriar o link (que no Windows
	// exigiria privilégios de administrador).
	cpSync(from, to, {
		recursive: true,
		dereference: true,
		filter: (source) => path.basename(source) !== ".bin" && filter?.(source) !== false,
	});
}

function countFiles(dir) {
	let total = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		total += entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1;
	}
	return total;
}

log("1/7 — compilando a interface");
run("pnpm", ["--filter", "@workspace/ponto-digital", "run", "build"]);

log("2/7 — compilando a API");
run("pnpm", ["--filter", "@workspace/api-server", "run", "build"]);

log(`3/7 — preparando ${path.relative(repoRoot, outputDir)}`);
rmSync(outputDir, { recursive: true, force: true });
mkdirSync(serverDir, { recursive: true });

const apiDist = path.join(repoRoot, "artifacts", "api-server", "dist");
if (!existsSync(path.join(apiDist, "portable.mjs"))) {
	throw new Error("O bundle portátil não foi gerado. Verifique o build da API.");
}

log("4/7 — copiando servidor, interface e migrações");
// O bundle portátil importa os módulos `pino` empacotados ao lado, então copia
// todo o `dist` em vez de apenas `portable.mjs`.
copyDirectory(apiDist, path.join(serverDir));

const frontDir = path.join(repoRoot, "artifacts", "ponto-digital", "dist", "public");
if (!existsSync(path.join(frontDir, "index.html"))) {
	throw new Error("A interface compilada não foi encontrada. Verifique o build do front.");
}
copyDirectory(frontDir, path.join(serverDir, "front"));

const migrationsDir = path.join(repoRoot, "lib", "db", "migrations");
if (!existsSync(migrationsDir)) {
	throw new Error(
		`Migrações não encontradas em ${migrationsDir}. Rode ` +
			"`pnpm --filter @workspace/db run generate` antes de empacotar.",
	);
}
copyDirectory(migrationsDir, path.join(serverDir, "migrations"));

// O PGlite é externo ao bundle e lê os arquivos .wasm/.data da própria pasta.
const pgliteSource = path.join(
	repoRoot,
	"artifacts",
	"api-server",
	"node_modules",
	"@electric-sql",
	"pglite",
);
copyDirectory(realpathSync(pgliteSource), path.join(serverDir, "node_modules", "@electric-sql", "pglite"));

/**
 * Pacotes que o bundle portátil deixa de fora porque carregam arquivos de
 * disco em tempo de execução.
 *
 * O `tesseract.js` resolve o núcleo WASM com `require('tesseract.js-core/...')`
 * a partir da pasta do worker, e cada dependência fica num diretório irmão
 * dentro da loja do pnpm. Por isso a cópia leva o bloco inteiro
 * `.pnpm/<pacote>@<versão>/node_modules` — assim as dependências continuam
 * resolvíveis na pasta `node_modules` do pacote final.
 */
const runtimePackages = ["tesseract.js"];
for (const packageName of runtimePackages) {
	const source = path.join(repoRoot, "artifacts", "api-server", "node_modules", ...packageName.split("/"));
	if (!existsSync(source)) {
		throw new Error(`Pacote de runtime não encontrado: ${source}`);
	}
	const realSource = realpathSync(source);
	const destination = path.join(serverDir, "node_modules", ...packageName.split("/"));
	copyDirectory(realSource, destination);

	// Dependências irmãs do bloco do pnpm: o diretório que contém o pacote
	// também contém suas dependências (tesseract.js-core, regenerator-runtime,
	// wasm-feature-detect...). É esse diretório que precisa ser replicado.
	const pnpmBlock = path.dirname(realSource);
	if (existsSync(pnpmBlock)) {
		for (const entry of readdirSync(pnpmBlock, { withFileTypes: true })) {
			// No pnpm, as dependências são links simbólicos: `isDirectory()` é
			// falso para elas, então o tipo é conferido pelo destino do link.
			const isPackage = entry.isDirectory() || entry.isSymbolicLink();
			if (!isPackage || entry.name === packageName) continue;
			const dependencySource = path.join(pnpmBlock, entry.name);
			const dependencyTarget = path.join(destination, "node_modules", entry.name);
			if (entry.name.startsWith("@")) {
				// Pacotes com escopo: copia cada pacote dentro do escopo.
				mkdirSync(dependencyTarget, { recursive: true });
				for (const scoped of readdirSync(dependencySource)) {
					copyDirectory(
						realpathSync(path.join(dependencySource, scoped)),
						path.join(dependencyTarget, scoped),
					);
				}
				continue;
			}
			copyDirectory(realpathSync(dependencySource), dependencyTarget);
		}
	}
	log(`   copiado ${packageName} e suas dependências`);
}

log("5/7 — copiando o inicializador");
copyFileSync(path.join(scriptDir, "Iniciar-Ponto.bat"), path.join(outputDir, "Iniciar-Ponto.bat"));

log("6/7 — embutindo o runtime do Node");
const runtimeDir = resolveRuntimeDir();
if (runtimeDir && existsSync(runtimeDir)) {
	copyDirectory(runtimeDir, path.join(outputDir, "runtime"));
	log(`   runtime embutido de ${runtimeDir}`);
} else {
	log("   runtime não informado — o pacote usará o Node instalado na estação");
}

log("7/7 — trazendo o modelo de idioma do OCR");
// O modelo fica ao lado do runtime do OCR, em `ocr/` (a mesma pasta que a
// Vercel recebe por `includeFiles`).
const tessdataDir = path.join(serverDir, "ocr", "tessdata");
try {
	const ready = await fetchTessdata({
		target: tessdataDir,
		cacheDir: path.join(repoRoot, "node_modules", ".cache", "tessdata"),
	});
	if (ready.length > 0) {
		log(`   OCR funciona sem internet (${ready.length} modelo(s) em tessdata/)`);
	} else {
		log("   modelo indisponível — o OCR usará o download automático (precisa de internet)");
	}
} catch (error) {
	log(`   não foi possível preparar o OCR offline: ${error instanceof Error ? error.message : String(error)}`);
}

const readme = `Folha de Ponto — modo portátil
================================

Como usar
---------
1. Copie a pasta inteira para o computador ou pendrive desejado.
2. Dê duplo clique em "Iniciar-Ponto.bat".
3. Abra o navegador em http://localhost:8080 (ou o endereço mostrado na janela).

Outras estações da rede
-----------------------
Neste computador, as demais pessoas abrem apenas o navegador:

    http://<nome-deste-computador>:8080

Não execute o "Iniciar-Ponto.bat" em mais de um computador apontando para a
mesma pasta: o banco embutido não suporta escrita simultânea e os dados podem
ser perdidos.

Onde ficam os dados
-------------------
Tudo é gravado na subpasta "data", ao lado do inicializador:

    data/banco/              banco de dados (não abra nem edite)
    data/uploads/            arquivos anexados
    data/SESSION_SECRET.txt  chave local (não apague, ou os dados cifrados se perdem)

Para fazer backup, copie a pasta "data" inteira com o sistema encerrado.

Leitura de folha digitalizada (OCR)
------------------------------------
O reconhecimento de PDF escaneado funciona sem internet: o runtime do OCR e o
modelo de idioma vêm na subpasta "server/ocr". Se essa pasta for removida, o
sistema passa a baixar o modelo da internet no primeiro uso.

Encerrar
--------
Feche a janela do inicializador ou pressione Ctrl+C nela.

Se a janela for fechada à força
-------------------------------
Na próxima abertura, o sistema reconhece que a execução anterior terminou e
libera o acesso sozinho. Se ainda assim aparecer a mensagem de que "o banco já
está aberto", apague o arquivo data/LOCK-PONTO.json e tente de novo.
`;

writeFileSync(path.join(outputDir, "LEIA-ME.txt"), readme, "utf8");

const files = countFiles(outputDir);
log(`pronto: ${path.relative(repoRoot, outputDir)} (${files} arquivos)`);
