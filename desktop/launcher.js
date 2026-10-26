"use strict";

/**
 * Ciclo de vida do servidor portátil usado pelo aplicativo desktop.
 *
 * Este módulo roda no processo principal do Electron (e nos testes, com Node
 * puro). Ele não conhece a interface: só descobre uma porta livre, inicia o
 * backend empacotado, espera o healthcheck responder e devolve a porta certa.
 *
 * Nada aqui altera o modo portátil existente: o `Iniciar-Ponto.bat` continua
 * subindo o mesmo `server/portable.mjs` com o mesmo banco embutido. A diferença
 * é que aqui os dados ficam em %LOCALAPPDATA%\PontoDigital (gravável sem
 * privilégio de administrador), em vez de ao lado do executável.
 */

const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

/** Rota de saúde já existente na API (`/api/healthz`). */
const HEALTH_PATH = "/api/healthz";

/**
 * Marcador de identidade: o título da interface compilada. Serve para não
 * confundir uma porta ocupada por outro programa com o nosso servidor.
 */
const IDENTITY_MARKER = "<title>Ponto Digital";

/** Portas candidatas, na ordem de preferência. */
const DEFAULT_PORTS = [8080, 8081, 8082, 8083, 8084];

/** Tempo máximo para o backend ficar saudável (primeira execução migra o banco). */
const HEALTH_TIMEOUT_MS = 90_000;

/** Intervalo entre tentativas do healthcheck. */
const HEALTH_INTERVAL_MS = 250;

/** Tamanho a partir do qual o log é rotacionado (launcher.log.1). */
const LOG_MAX_BYTES = 2 * 1024 * 1024;

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function launcherError(userMessage, detail) {
	const error = new Error(detail ? `${userMessage} ${detail}` : userMessage);
	error.userMessage = userMessage;
	error.detail = detail ?? "";
	return error;
}

/* ------------------------------------------------------------------ *
 * Log
 * ------------------------------------------------------------------ */

/**
 * Log simples em arquivo, sem dados sensíveis: só porta, caminhos e o que o
 * backend imprime (o backend não registra senha nem CPF em claro).
 */
function createLogger(logFile) {
	function rotateIfNeeded() {
		try {
			const info = fs.statSync(logFile);
			if (info.size > LOG_MAX_BYTES) {
				// unlinkSync em vez de rmSync: em caminho com acento o rm pode
				// retornar sem apagar e o rename seguinte falharia.
				try {
					fs.unlinkSync(`${logFile}.1`);
				} catch {
					// Ainda não há log anterior.
				}
				fs.renameSync(logFile, `${logFile}.1`);
			}
		} catch {
			// Arquivo ainda não existe: nada a rotacionar.
		}
	}
	function write(level, message) {
		const line = `[${new Date().toISOString()}] [${level}] ${message}\n`;
		try {
			fs.mkdirSync(path.dirname(logFile), { recursive: true });
			rotateIfNeeded();
			fs.appendFileSync(logFile, line, "utf8");
		} catch {
			// Sem permissão de escrita, o app continua; só perde o registro.
		}
		if (process.env.PONTO_LAUNCHER_VERBOSE) process.stdout.write(line);
	}
	return {
		info: (message) => write("info", message),
		warn: (message) => write("warn", message),
		error: (message) => write("error", message),
		/** Linha vinda do backend (stdout/stderr), prefixada no log. */
		child: (message) => write("backend", message),
	};
}

/* ------------------------------------------------------------------ *
 * Caminhos e configuração
 * ------------------------------------------------------------------ */

/** Pasta dos dados quando o usuário não configurou nada. */
function defaultDataDir(baseDir) {
	return path.join(baseDir, "data");
}

/**
 * Pasta de dados efetiva.
 *
 * Precedência: variável `PONTO_DATA_DIR` (compatível com o modo portátil, e é
 * assim que uma pasta de rede é usada), depois `config.json` ao lado do app,
 * depois `data/` dentro da pasta local. Um caminho relativo no `config.json`
 * é resolvido a partir da pasta do aplicativo.
 */
function resolveDataDir(baseDir, env = process.env) {
	const configured = env.PONTO_DATA_DIR?.trim();
	if (configured) return path.resolve(configured);

	try {
		const configFile = path.join(baseDir, "config.json");
		const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
		if (typeof config.dataDir === "string" && config.dataDir.trim()) {
			const raw = config.dataDir.trim();
			return path.isAbsolute(raw) ? path.normalize(raw) : path.join(baseDir, raw);
		}
	} catch {
		// Sem config.json (ou inválido): usa o padrão.
	}

	return defaultDataDir(baseDir);
}

function stateFile(baseDir) {
	return path.join(baseDir, "state", "server.json");
}

function readState(baseDir) {
	try {
		const state = JSON.parse(fs.readFileSync(stateFile(baseDir), "utf8"));
		if (!state || typeof state.port !== "number") return null;
		return state;
	} catch {
		return null;
	}
}

function writeState(baseDir, state) {
	try {
		const file = stateFile(baseDir);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	} catch {
		// Sem estado gravado, a próxima abertura só demora mais para encontrar a porta.
	}
}

function removeState(baseDir) {
	try {
		// unlinkSync em vez de rmSync: em caminho com acento o rm pode
		// retornar sem apagar o arquivo.
		fs.unlinkSync(stateFile(baseDir));
	} catch {
		// ignore
	}
}

/* ------------------------------------------------------------------ *
 * Rede
 * ------------------------------------------------------------------ */

/** GET de texto com timeout curto; devolve `null` em qualquer falha. */
async function fetchText(url, timeoutMs) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, { signal: controller.signal, redirect: "manual" });
		if (!response.ok) return null;
		return await response.text();
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * O servidor nesta porta é o Ponto Digital?
 *
 * Exige o healthcheck E o título da interface: dupla checagem para não adotar
 * um programa alheio que por acaso responda em `/api/healthz`.
 */
async function isPontoDigital(port, { timeoutMs = 1500 } = {}) {
	const health = await fetchText(`http://127.0.0.1:${port}${HEALTH_PATH}`, timeoutMs);
	if (!health) return false;
	try {
		if (JSON.parse(health).status !== "ok") return false;
	} catch {
		return false;
	}
	const index = await fetchText(`http://127.0.0.1:${port}/`, timeoutMs);
	return Boolean(index && index.includes(IDENTITY_MARKER));
}

/** A porta está livre para escuta local? */
function isPortFree(port) {
	return new Promise((resolve) => {
		const probe = net.createServer();
		probe.unref();
		probe.once("error", () => resolve(false));
		probe.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
			probe.close(() => resolve(true));
		});
	});
}

/**
 * A porta está realmente livre?
 *
 * `isPortFree` testa só 127.0.0.1: outro processo escutando em 0.0.0.0 ou [::]
 * pode deixar o teste passar e o backend falhar ao abrir a porta. O netstat
 * cobre esse caso e também revela processos que escutam sem responder HTTP.
 */
async function isPortAvailable(port) {
	if (pidListeningOn(port) !== null) return false;
	return isPortFree(port);
}

/** Deixa o sistema escolher uma porta livre (último recurso). */
function freeEphemeralPort() {
	return new Promise((resolve, reject) => {
		const probe = net.createServer();
		probe.unref();
		probe.once("error", reject);
		probe.listen({ port: 0, host: "127.0.0.1", exclusive: true }, () => {
			const address = probe.address();
			probe.close(() => resolve(address.port));
		});
	});
}

/**
 * PID do processo que escuta na porta (Windows).
 *
 * Usado para "adotar" um servidor iniciado por uma execução anterior que perdeu
 * o arquivo de estado — assim ele também é encerrado quando a janela fecha.
 */
function pidListeningOn(port) {
	if (process.platform !== "win32") return null;
	try {
		const output = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8", windowsHide: true });
		for (const line of output.split(/\r?\n/)) {
			if (!line.includes("LISTENING")) continue;
			const columns = line.trim().split(/\s+/);
			if (columns.length < 5) continue;
			if (!columns[1].endsWith(`:${port}`)) continue;
			const pid = Number(columns[4]);
			return Number.isInteger(pid) && pid > 0 ? pid : null;
		}
	} catch {
		// netstat indisponível: só não adota o processo.
	}
	return null;
}

/* ------------------------------------------------------------------ *
 * Inicialização
 * ------------------------------------------------------------------ */

/** Executa o backend até o healthcheck responder. */
async function waitForHealth(port, { timeoutMs, intervalMs, isAlive }) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (isAlive && !isAlive()) return "exit";
		if (await isPontoDigital(port)) return "ok";
		await delay(intervalMs);
	}
	return "timeout";
}

function runtimeExecutable(portableDir) {
	const embedded = path.join(portableDir, "runtime", "node.exe");
	if (fs.existsSync(embedded)) return embedded;
	// Desenvolvimento: sem empacotamento, usa o Node do PATH (o instalador
	// sempre embute o runtime, então o usuário final nunca cai aqui).
	return null;
}

const CLEAN_LINE = /^\[?[0-9]{4}-[0-9]{2}-[0-9]{2}/;

/** Mensagem curta para a caixa de diálogo, sem caminhos nem stack trace. */
function friendlyDetail(lines) {
	const cleaned = lines
		.map((line) => line.trim())
		.filter((line) => line && !CLEAN_LINE.test(line))
		.filter((line) => !/^at\s/.test(line))
		.map((line) => line.replace(/(?:[A-Za-z]:\\|\/)[^\s"'`,;)]*/g, "…"))
		.filter(Boolean)
		.slice(-2);
	return cleaned.join(" ");
}

/**
 * Garante um servidor do Ponto Digital ativo e devolve a porta.
 *
 * Ordem:
 * 1. estado salvo da execução anterior (servidor ainda vivo) → reutiliza;
 * 2. varredura das portas padrão (servidor órfão de outra execução) → adota;
 * 3. porta livre + backend novo → espera o healthcheck.
 *
 * Nunca inicia uma segunda instância do backend só porque o ícone foi clicado
 * duas vezes: com o estado válido, a segunda chamada reutiliza a primeira.
 */
async function ensureServer({
	baseDir,
	portableDir,
	log,
	version = "0.0.0",
	ports = DEFAULT_PORTS,
	timeoutMs = HEALTH_TIMEOUT_MS,
}) {
	const saved = readState(baseDir);
	if (saved && (await isPontoDigital(saved.port))) {
		log.info(`Servidor já em execução na porta ${saved.port}; reutilizando.`);
		return { port: saved.port, pid: saved.pid ?? null, reused: true, child: null, baseDir };
	}
	if (saved) removeState(baseDir);

	for (const port of ports) {
		if (!(await isPontoDigital(port))) continue;
		const pid = pidListeningOn(port);
		writeState(baseDir, { port, pid, startedAt: new Date().toISOString(), version, adopted: true });
		log.info(`Servidor encontrado na porta ${port} (pid ${pid ?? "desconhecido"}); adotando.`);
		return { port, pid, reused: true, child: null, baseDir };
	}

	let port = null;
	for (const candidate of ports) {
		if (await isPortAvailable(candidate)) {
			port = candidate;
			break;
		}
	}
	if (port === null) {
		port = await freeEphemeralPort();
		log.warn("Todas as portas preferenciais estão ocupadas; usando uma porta livre do sistema.");
	}

	const nodeExe = runtimeExecutable(portableDir);
	if (!nodeExe) {
		throw launcherError(
			"O aplicativo está incompleto: não foi encontrado o runtime do servidor.",
			`Esperado em ${path.join(portableDir, "runtime", "node.exe")}.`,
		);
	}
	const entry = path.join(portableDir, "server", "portable.mjs");
	if (!fs.existsSync(entry)) {
		throw launcherError("O aplicativo está incompleto: a pasta do servidor não foi encontrada.", entry);
	}

	const dataDir = resolveDataDir(baseDir);
	fs.mkdirSync(dataDir, { recursive: true });
	log.info(`Iniciando backend na porta ${port} (dados em ${dataDir}).`);

	const child = spawn(nodeExe, [entry], {
		cwd: path.join(portableDir, "server"),
		env: { ...process.env, PORT: String(port), PONTO_DATA_DIR: dataDir },
		windowsHide: true,
		// "ipc" permite encerrar o backend de forma ordenada (fecha o banco
		// e libera a trava), em vez de matar o processo.
		stdio: ["ignore", "pipe", "pipe", "ipc"],
	});

	const tail = [];
	const collect = (chunk) => {
		for (const line of String(chunk).split(/\r?\n/)) {
			if (!line.trim()) continue;
			log.child(line);
			tail.push(line);
			if (tail.length > 40) tail.shift();
		}
	};
	child.stdout.on("data", collect);
	child.stderr.on("data", collect);

	let exited = false;
	let exitCode = null;
	child.on("exit", (code) => {
		exited = true;
		exitCode = code;
		log.info(`Backend encerrado (código ${code ?? "?"}).`);
	});
	child.on("error", (error) => {
		exited = true;
		log.error(`Falha ao iniciar o backend: ${error.message}`);
	});

	const result = await waitForHealth(port, {
		timeoutMs,
		intervalMs: HEALTH_INTERVAL_MS,
		isAlive: () => !exited,
	});

	if (result !== "ok") {
		await stopServer({ pid: child.pid, child }, log, { graceMs: 2000 });
		const detail = friendlyDetail(tail);
		const reason = result === "exit"
			? `O servidor encerrou durante a inicialização (código ${exitCode ?? "?"}).`
			: "O servidor não respondeu a tempo.";
		throw launcherError(reason, detail);
	}

	writeState(baseDir, { port, pid: child.pid, startedAt: new Date().toISOString(), version });
	return { port, pid: child.pid, reused: false, child, baseDir };
}

/**
 * Encerra o backend.
 *
 * Com o processo filho em mãos, pede o encerramento pelo canal IPC: o
 * `portable.ts` fecha o banco e libera a trava antes de sair. Depois de 8 s
 * (ou quando só há o PID), usa `taskkill`, que é o que o Windows oferece.
 */
async function stopServer(server, log, { graceMs = 8_000 } = {}) {
	if (!server) return;
	if (server.child && server.child.connected) {
		try {
			server.child.send({ type: "shutdown" });
			const started = Date.now();
			while (server.child.exitCode === null && Date.now() - started < graceMs) {
				await delay(100);
			}
		} catch {
			// canal já fechado: cai para o taskkill.
		}
	}
	const pid = server.pid;
	// Servidor adotado (instância que já estava rodando) não tem `child`: mesmo
	// assim precisa ser encerrado, senão fica órfão depois que a janela fecha.
	const alreadyExited = server.child != null && server.child.exitCode !== null;
	if (pid && !alreadyExited) {
		if (process.platform === "win32") {
			try {
				execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
				log?.info?.(`Backend encerrado à força (pid ${pid}).`);
			} catch {
				// Já não existia.
			}
		} else {
			try {
				process.kill(pid, "SIGTERM");
			} catch {
				// Já não existia.
			}
		}
	}
	if (server.baseDir) removeState(server.baseDir);
}

module.exports = {
	DEFAULT_PORTS,
	HEALTH_PATH,
	IDENTITY_MARKER,
	createLogger,
	defaultDataDir,
	resolveDataDir,
	stateFile,
	readState,
	writeState,
	removeState,
	isPontoDigital,
	isPortFree,
	isPortAvailable,
	freeEphemeralPort,
	pidListeningOn,
	waitForHealth,
	ensureServer,
	stopServer,
	launcherError,
	friendlyDetail,
};
