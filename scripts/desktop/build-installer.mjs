/**
 * Gera o instalador Windows do Ponto Digital.
 *
 * Uso:
 *   pnpm build:installer     → dist-installer/Ponto-Digital-Setup-<versão>.exe
 *   pnpm build:desktop       → só o aplicativo descompactado (dist-desktop/),
 *                              útil para testar sem instalar
 *
 * O processo é inteiro: compila a interface e a API, monta o pacote portátil
 * (banco embutido, OCR e runtime do Node), confere se o OCR e os binários
 * estão no lugar e chama o electron-builder (NSIS). Nada precisa ser copiado
 * à mão depois.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { embeddedRuntimeVersion, installerVersion } from "../portable/node-runtime.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");
const desktopDir = path.join(repoRoot, "desktop");
const portableDir = path.join(repoRoot, "dist-portable");
const unpackedOnly = process.argv.includes("--dir");
const requireFromDesktop = createRequire(path.join(desktopDir, "package.json"));

function log(message) {
	console.log(`[instalador] ${message}`);
}

function run(command, args, options = {}) {
	// `shell` só é necessário para o `pnpm` (script .cmd no Windows). O Node é
	// chamado direto: com shell, "C:\Program Files\..." seria partido no espaço.
	const needsShell = process.platform === "win32" && command === "pnpm";
	try {
		execFileSync(command, args, { stdio: "inherit", cwd: repoRoot, shell: needsShell, ...options });
	} catch (error) {
		throw new Error(`Comando falhou: ${command} ${args.join(" ")}${error instanceof Error ? ` (${error.message})` : ""}`);
	}
}

function fileOrFail(file, hint) {
	if (!existsSync(file)) throw new Error(`Arquivo obrigatório ausente no pacote: ${path.relative(repoRoot, file)}\n${hint ?? ""}`);
	return file;
}

function directoryHasFiles(dir) {
	if (!existsSync(dir)) return false;
	return readdirSync(dir, { recursive: true }).length > 0;
}

/** Confere o conteúdo obrigatório do pacote (requisito de OCR offline). */
function verifyPortable() {
	const serverDir = path.join(portableDir, "server");
	fileOrFail(path.join(serverDir, "portable.mjs"), "Rode `pnpm build:portable` (ou o build do servidor).");
	fileOrFail(path.join(serverDir, "front", "index.html"), "A interface compilada não foi copiada.");
	fileOrFail(path.join(serverDir, "node_modules", "@electric-sql", "pglite", "package.json"), "Banco embutido (PGlite) ausente.");
	fileOrFail(path.join(serverDir, "pdfium.wasm"), "WASM do PDFium ausente no pacote portátil.");

	const migrations = path.join(serverDir, "migrations");
	const sql = directoryHasFiles(migrations)
		? readdirSync(migrations).filter((name) => name.endsWith(".sql"))
		: [];
	if (sql.length === 0) throw new Error("Migrações SQL ausentes no pacote.");

	fileOrFail(path.join(serverDir, "node_modules", "tesseract.js", "package.json"), "OCR (tesseract.js) ausente.");
	const tesseractRuntime = path.join(serverDir, "ocr", "tesseract");
	if (!directoryHasFiles(tesseractRuntime)) {
		throw new Error("Runtime do OCR (worker + núcleo WASM) ausente em server/ocr/tesseract.");
	}
	for (const idioma of ["por", "eng"]) {
		fileOrFail(
			path.join(serverDir, "ocr", "tessdata", `${idioma}.traineddata.gz`),
			"Sem o modelo de idioma o OCR não funciona offline. Rode `pnpm build:portable` com internet.",
		);
	}

	const runtime = embeddedRuntimeVersion(path.join(portableDir, "runtime"));
	if (!runtime) {
		throw new Error("Runtime do Node ausente no pacote (dist-portable/runtime/node.exe).");
	}

	log(`pacote portátil verificado: servidor, interface, migrações, PGlite, OCR por/eng, Node ${runtime}`);
}

function artifactPath(version) {
	return path.join(repoRoot, "dist-installer", `Ponto-Digital-Setup-${version}.exe`);
}

/**
 * CLI do electron-builder.
 *
 * É executado com o Node deste build (não com `pnpm exec`): o electron-builder
 * 26 carrega `@noble/hashes` via `require()` de um módulo ESM, o que exige
 * Node 22+ — o Node 18 do PATH quebraria o empacotamento.
 */
function electronBuilderCli() {
	const candidates = [
		() => requireFromDesktop.resolve("electron-builder/cli.js"),
		() => path.join(path.dirname(requireFromDesktop.resolve("electron-builder/package.json")), "cli.js"),
		() => path.join(desktopDir, "node_modules", "electron-builder", "cli.js"),
	];
	for (const candidate of candidates) {
		try {
			const resolved = candidate();
			if (existsSync(resolved)) return resolved;
		} catch {
			// tenta o próximo caminho
		}
	}
	throw new Error("electron-builder não encontrado. Rode `pnpm install` na raiz.");
}

function runElectronBuilder(args) {
	const cli = electronBuilderCli();
	log(`electron-builder: ${path.relative(repoRoot, cli)}`);
	run(process.execPath, [cli, ...args], { cwd: desktopDir });
}

/**
 * Gera um script NSIS autocontido, derivado do template do electron-builder,
 * que cria o desinstalador **na instalação** (`WriteUninstaller`) em vez de
 * embutir um desinstalador pré-compilado.
 *
 * Por que não usar `nsis.script` apontando para uma cópia do template: o
 * electron-builder manda o script por stdin e roda o makensis com o diretório
 * de templates como pasta de trabalho, então os `!include` relativos continuam
 * vindo do pacote original — os patches seriam ignorados. Aqui os includes do
 * template são resolvidos e embutidos no arquivo; só os headers do próprio NSIS
 * (MUI2, LogicLib, nsDialogs...) continuam sendo resolvidos pelo makensis.
 *
 * Em máquinas com App Control/WDAC o electron-builder não consegue executar o
 * stub sem assinatura usado para extrair esse desinstalador. As alterações
 * abaixo são as mínimas para o fluxo clássico do NSIS; se o template do
 * electron-builder mudar, o build falha com instrução clara em vez de gerar um
 * instalador quebrado.
 */
function customNsisScript() {
	const cli = electronBuilderCli();
	const candidates = [
		path.join(path.dirname(path.dirname(cli)), "app-builder-lib", "templates", "nsis"),
		path.join(desktopDir, "node_modules", "app-builder-lib", "templates", "nsis"),
	];
	const templates = candidates.find((dir) => existsSync(path.join(dir, "installer.nsi")));
	if (!templates) throw new Error("Template NSIS do electron-builder não encontrado.");

	// Alterações no template. As chaves são caminhos absolutos no pacote.
	const patches = new Map([
		[
			path.join(templates, "installer.nsi"),
			[
				// Páginas do desinstalador no próprio instalador (MUI).
				[
					'!ifdef ONE_CLICK\n  !include "oneClick.nsh"\n!else\n  !include "assistedInstaller.nsh"\n!endif',
					'!ifdef ONE_CLICK\n  !include "oneClick.nsh"\n!else\n  !include "assistedInstaller.nsh"\n!endif\n\n' +
						'!ifndef BUILD_UNINSTALLER\n' +
						'  !insertmacro MUI_UNPAGE_CONFIRM\n' +
						'  !insertmacro MUI_UNPAGE_INSTFILES\n' +
						'!endif',
				],
				// Escreve o desinstalador junto com a instalação...
				[
					'    !include "installSection.nsh"\n  !endif\nSectionEnd',
					'    !include "installSection.nsh"\n' +
						'    WriteUninstaller "$INSTDIR\\${UNINSTALL_FILENAME}"\n' +
						'  !endif\nSectionEnd',
				],
				// ...e o desinstalador é escrito na instalação, com um código
				// próprio: o do template depende do desinstalador pré-compilado.
				[
					'!ifdef BUILD_UNINSTALLER\n  !include "uninstaller.nsh"\n!endif',
					[
						"!ifndef BUILD_UNINSTALLER",
						"; Desinstalador gravado pelo próprio instalador (WriteUninstaller),",
						"; usando só comandos do NSIS. O código un.* do template depende do",
						"; desinstalador pré-compilado, que o App Control/WDAC bloqueia aqui.",
						'Section "un.${UNINSTALL_DISPLAY_NAME}"',
						"  SetShellVarContext current",
						"  !insertmacro check64BitAndSetRegView",
						"  ; encerra o aplicativo, se ainda estiver aberto",
						'  nsExec::Exec `"$SYSDIR\\cmd.exe" /C taskkill /F /IM "${APP_EXECUTABLE_FILENAME}"`',
						'  Delete "$DESKTOP\\${SHORTCUT_NAME}.lnk"',
						'  Delete "$SMPROGRAMS\\${SHORTCUT_NAME}.lnk"',
						"  ; o desinstalador em execução não pode ser apagado: renomeia",
						'  Rename "$INSTDIR\\${UNINSTALL_FILENAME}" "$TEMP\\PontoDigital-uninstall.exe"',
						'  RMDir /r "$INSTDIR"',
						'  Delete "$LOCALAPPDATA\\${APP_INSTALLER_STORE_FILE}"',
						'  DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY}"',
						'  DeleteRegKey HKCU "${INSTALL_REGISTRY_KEY}"',
						"SectionEnd",
						"!endif",
					].join("\n"),
				],
			],
		],
		[
			path.join(templates, "include", "installer.nsh"),
			[
				// O desinstalador pré-compilado não existe: sem esse embed.
				['\n  File "/oname=${UNINSTALL_FILENAME}" "${UNINSTALLER_OUT_FILE}"', ""],
			],
		],
	]);

	const includePattern = /^([ \t]*)!include[ \t]+(?:"([^"]+)"|(\S+))[ \t]*$/gm;
	const stack = [];

	function resolveInclude(name, fromDir) {
		const attempts = [
			path.resolve(fromDir, name),
			path.resolve(templates, name),
			path.resolve(templates, "include", name),
		];
		for (const attempt of attempts) {
			if (attempt.startsWith(`${templates}${path.sep}`) && existsSync(attempt)) return attempt;
		}
		return null;
	}

	function expand(file) {
		if (stack.includes(file)) {
			const caminho = [...stack, file].map((item) => path.relative(templates, item)).join(" -> ");
			throw new Error(`Include circular no template NSIS: ${caminho}`);
		}
		if (stack.length > 16) throw new Error("Includes NSIS aninhados demais no template do electron-builder.");
		stack.push(file);

		// Normaliza CRLF: os templates podem mudar de fim de linha entre versões.
		let text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
		for (const [from, to] of patches.get(file) ?? []) {
			if (!text.includes(from)) {
				throw new Error(
					`O template NSIS do electron-builder mudou (${path.relative(templates, file)}). ` +
						"Gere o instalador em uma máquina sem App Control/WDAC ou ajuste scripts/desktop/build-installer.mjs.",
				);
			}
			text = text.replace(from, to);
		}

		const expandido = text.replace(includePattern, (line, indent, quoted, bare) => {
			const name = quoted ?? bare;
			// Nome montado com define: o makensis resolve em tempo de compilação.
			if (name.includes("${")) return line;
			const resolved = resolveInclude(name, path.dirname(file));
			// Header do próprio NSIS (MUI2, LogicLib, nsDialogs...): fica como está.
			if (!resolved) return line;
			return `${indent}; --- ${path.relative(templates, resolved)} ---\n${expand(resolved)}`;
		});

		stack.pop();
		return expandido;
	}

	const target = path.join(repoRoot, "dist-installer", "nsis-custom");
	rmSync(target, { recursive: true, force: true });
	mkdirSync(target, { recursive: true });
	const outFile = path.join(target, "installer.nsi");
	writeFileSync(outFile, expand(path.join(templates, "installer.nsi")), "utf8");
	return outFile;
}

async function main() {
	if (process.platform !== "win32" && !unpackedOnly) {
		throw new Error("O instalador NSIS do Ponto Digital é gerado no Windows; use `pnpm build:desktop` para gerar a versão descompactada neste sistema.");
	}
	// Uso interno: só prepara o script NSIS e sai (depuração do empacotamento).
	if (process.argv.includes("--prepare-nsis")) {
		log(`script NSIS preparado: ${path.relative(repoRoot, customNsisScript())}`);
		return;
	}
	const version = installerVersion(repoRoot);
	const skipPortable = process.argv.includes("--skip-portable");
	const nodeMajor = Number(process.versions.node.split(".")[0]);

	if (!skipPortable) {
		log("1/3 — montando o pacote portátil (interface, API, OCR, banco e runtime)");
		run(process.execPath, [path.join(repoRoot, "scripts", "portable", "package.mjs")]);
	}

	log("2/3 — conferindo o pacote");
	verifyPortable();

	if (!Number.isInteger(nodeMajor) || nodeMajor < 22) {
		// O electron-builder 26 exige Node 22+; o `pnpm run` pode executar este
		// script com um Node antigo do PATH. O pacote recém-montado já traz um
		// Node 24 embutido — reaproveitamos ele em vez de pedir instalação manual.
		const embedded = path.join(portableDir, "runtime", "node.exe");
		if (skipPortable || !existsSync(embedded)) {
			throw new Error(`O empacotamento precisa de Node 22+ (este processo está em ${process.version}).`);
		}
		log(`Node atual é ${process.version}; reiniciando o empacotamento com o Node embutido (${embeddedRuntimeVersion(path.join(portableDir, "runtime"))}).`);
		run(embedded, [fileURLToPath(import.meta.url), "--skip-portable", ...(unpackedOnly ? ["--dir"] : [])]);
		return;
	}

	if (unpackedOnly) {
		log("3/3 — gerando o aplicativo descompactado (sem instalador)");
		runElectronBuilder(["--win", "--dir", "--config.directories.output=../dist-desktop"]);
		log(`pronto: ${path.relative(repoRoot, path.join(repoRoot, "dist-desktop", "win-unpacked"))}`);
		return;
	}

	log("3/3 — gerando o instalador NSIS");
	const artifact = artifactPath(version);
	try {
		runElectronBuilder(["--win", "nsis"]);
	} catch (error) {
		// O stub gerado tem poucos KB; um instalador de verdade passa de 100 MB.
		const blockedStub = existsSync(artifact) && statSync(artifact).size < 5 * 1024 * 1024;
		if (!blockedStub) throw error;
		log("O Windows bloqueou a execução do stub sem assinatura (App Control/WDAC).");
		log("Repetindo com o script NSIS do electron-builder: o desinstalador será criado na instalação, sem assinatura prévia.");
		rmSync(artifact, { force: true });
		runElectronBuilder(["--win", "nsis", `--config.nsis.script=${customNsisScript()}`]);
	}

	if (!existsSync(artifact)) {
		throw new Error(`O electron-builder terminou sem gerar ${artifact}.`);
	}
	const tamanho = (statSync(artifact).size / 1024 / 1024).toFixed(1);
	log(`instalador pronto: ${path.relative(repoRoot, artifact)} (${tamanho} MB)`);
}

main().catch((error) => {
	console.error(`[instalador] falhou: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
