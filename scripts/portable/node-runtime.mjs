/**
 * Runtime do Node embutido no pacote portátil e no instalador.
 *
 * O computador do usuário final não tem Node instalado e não deve precisar
 * instalar. Este módulo copia um `node.exe` oficial para `runtime/node.exe`
 * dentro do pacote, de uma destas fontes, nesta ordem:
 *
 * 1. `--runtime <pasta|node.exe>` ou `NODE_PORTABLE_RUNTIME` (uso manual/CI);
 * 2. cache local do zip já baixado (`node_modules/.cache/node-runtime`);
 * 3. download oficial em nodejs.org (precisa de internet no build, não no uso).
 *
 * O download é feito uma vez e fica em cache; o instalador final não baixa
 * nada. Em redes com proxy/CA corporativa, defina `NODE_EXTRA_CA_CERTS` — ou
 * use a opção 1 para apontar um Node já existente na máquina de build.
 */
import { execFileSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, copyFileSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";

/** Versão padrão do runtime embutido (mesma linha do `.nvmrc`/engines). */
export const DEFAULT_NODE_RUNTIME_VERSION = "24.12.0";

/** Menor versão aceitável (`import.meta.dirname` exige 20.11+). */
const MIN_MAJOR = 22;

function nodeRuntimeVersion() {
	return process.env.NODE_RUNTIME_VERSION?.trim() || DEFAULT_NODE_RUNTIME_VERSION;
}

export function nodeExecutableIn(source) {
	if (!source) return null;
	const resolved = path.resolve(source);
	if (resolved.endsWith(".exe") || path.basename(resolved) === "node") return resolved;
	const candidate = path.join(resolved, "node.exe");
	return existsSync(candidate) ? candidate : null;
}

function copyRuntimeFiles(sourceExe, targetDir) {
	mkdirSync(targetDir, { recursive: true });
	copyFileSync(sourceExe, path.join(targetDir, "node.exe"));
	// Licença do Node acompanha o runtime redistribuído.
	const license = path.join(path.dirname(sourceExe), "LICENSE");
	if (existsSync(license)) copyFileSync(license, path.join(targetDir, "LICENSE"));
}

function runtimeVersion(exe, expectedVersion = null) {
	if (process.platform !== "win32" && exe.toLowerCase().endsWith(".exe")) {
		return expectedVersion ? `v${expectedVersion}` : null;
	}
	try {
		return execFileSync(exe, ["--version"], { encoding: "utf8", windowsHide: true }).trim();
	} catch {
		return null;
	}
}

function assertUsable(exe, sourceLabel, expectedVersion = null) {
	const reported = runtimeVersion(exe, expectedVersion);
	if (!reported) {
		throw new Error(`O runtime em ${sourceLabel} não executou (${exe}).`);
	}
	const major = Number(reported.replace(/^v/, "").split(".")[0]);
	if (!Number.isInteger(major) || major < MIN_MAJOR) {
		throw new Error(
			`O runtime em ${sourceLabel} é ${reported}; o Ponto Digital precisa de Node ${MIN_MAJOR}+ ` +
				`(recomendado: v${nodeRuntimeVersion()}).`,
		);
	}
	return reported;
}

async function downloadRuntime(zipFile, version, log) {
	if (existsSync(zipFile)) {
		log(`   reutilizando zip do cache: ${path.basename(zipFile)}`);
		return zipFile;
	}
	const url = `https://nodejs.org/dist/v${version}/node-v${version}-win-x64.zip`;
	log(`   baixando runtime: ${url}`);
	const response = await fetch(url);
	if (!response.ok || !response.body) {
		throw new Error(`Download do Node falhou (HTTP ${response.status}).`);
	}
	mkdirSync(path.dirname(zipFile), { recursive: true });
	const partial = `${zipFile}.partial`;
	await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
	if (statSync(partial).size < 10 * 1024 * 1024) {
		rmSync(partial, { force: true });
		throw new Error("O download do Node veio incompleto.");
	}
	rmSync(zipFile, { force: true });
	copyFileSync(partial, zipFile);
	rmSync(partial, { force: true });
	return zipFile;
}

function extractNodeFromZip(zipFile, workDir, version) {
	rmSync(workDir, { recursive: true, force: true });
	mkdirSync(workDir, { recursive: true });
	if (process.platform === "win32") {
		// Expand-Archive existe em qualquer Windows 10/11.
		execFileSync(
			"powershell",
			["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `Expand-Archive -LiteralPath '${zipFile}' -DestinationPath '${workDir}' -Force`],
			{ stdio: "ignore", windowsHide: true },
		);
	} else {
		// O pacote contém um runtime Windows, mas a preparação também pode rodar
		// em Linux/macOS, onde PowerShell não está necessariamente instalado.
		execFileSync("unzip", ["-q", "-o", zipFile, "-d", workDir], { stdio: "ignore" });
	}
	const folder = path.join(workDir, `node-v${version}-win-x64`);
	const exe = path.join(folder, "node.exe");
	if (!existsSync(exe)) throw new Error(`node.exe não encontrado dentro do zip em ${folder}.`);
	return exe;
}

/**
 * Garante `targetDir/node.exe` e devolve `{ ok, source, version, executable }`.
 */
export async function ensureNodeRuntime({ targetDir, cacheDir, configured, log = console.log }) {
	const exe = path.join(targetDir, "node.exe");
	if (existsSync(exe)) {
		const reported = runtimeVersion(exe, nodeRuntimeVersion());
		if (reported) return { ok: true, source: "já presente no pacote", version: reported, executable: exe };
		rmSync(exe, { force: true });
	}

	const manual = nodeExecutableIn(configured);
	if (manual) {
		const reported = assertUsable(manual, "NODE_PORTABLE_RUNTIME");
		copyRuntimeFiles(manual, targetDir);
		log(`   runtime embutido de ${manual} (${reported})`);
		return { ok: true, source: manual, version: reported, executable: exe };
	}

	const version = nodeRuntimeVersion();
	try {
		const zipFile = path.join(cacheDir, `node-v${version}-win-x64.zip`);
		await downloadRuntime(zipFile, version, log);
		const extracted = extractNodeFromZip(zipFile, path.join(cacheDir, "extract"), version);
		const reported = assertUsable(extracted, "download oficial", version);
		copyRuntimeFiles(extracted, targetDir);
		log(`   runtime embutido: Node ${reported}`);
		return { ok: true, source: "nodejs.org", version: reported, executable: exe };
	} catch (error) {
		throw new Error(
			"Runtime do Node não disponível: " +
				`${error instanceof Error ? error.message : String(error)}\n` +
				"Sem internet no build? Aponte um Node 24 já instalado na máquina:\n" +
				'  $env:NODE_PORTABLE_RUNTIME = "C\\caminho\\para\\node.exe"\n' +
				"  pnpm build:installer",
		);
	}
}

/** Versão do runtime embutido no pacote, se já existir. */
export function embeddedRuntimeVersion(targetDir) {
	const exe = path.join(targetDir, "node.exe");
	return existsSync(exe) ? runtimeVersion(exe, nodeRuntimeVersion()) : null;
}

/** Lê a versão do desktop/package.json (nome do artefato do instalador). */
export function installerVersion(repoRoot) {
	const pkg = JSON.parse(readFileSync(path.join(repoRoot, "desktop", "package.json"), "utf8"));
	return pkg.version;
}
