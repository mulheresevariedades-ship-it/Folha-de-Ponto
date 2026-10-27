"use strict";

/**
 * Testes do ciclo de vida do servidor (sem Electron): descoberta de porta,
 * healthcheck, identidade, estado e mensagens de erro.
 *
 * Executar: pnpm --filter @workspace/desktop test
 */

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const {
	defaultDataDir,
	ensureServer,
	friendlyDetail,
	isPontoDigital,
	isPortFree,
	isPortAvailable,
	launcherError,
	readState,
	removeState,
	resolveDataDir,
	stopServer,
	waitForHealth,
	writeState,
} = require("./launcher");

function tempDir(prefix) {
	return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

async function startFakeApp({ title = "<title>Ponto Digital DIGEP</title>", health = { status: "ok" } } = {}) {
	const server = http.createServer((req, res) => {
		if (req.url === "/api/healthz") {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify(health));
			return;
		}
		res.setHeader("content-type", "text/html; charset=utf-8");
		res.end(`<!doctype html><html><head>${title}</head><body></body></html>`);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { server, port: server.address().port };
}

function closeServer(server) {
	// O `fetch` mantém a conexão viva; sem isso, `close` só responde depois do
	// keep-alive do cliente (5 s por teste).
	server.closeAllConnections?.();
	return new Promise((resolve) => server.close(resolve));
}

describe("resolveDataDir", () => {
	it("prioriza PONTO_DATA_DIR (pasta de rede/compatibilidade portátil)", () => {
		const base = tempDir("ponto-base");
		const custom = path.join(base, "rede");
		assert.equal(resolveDataDir(base, { PONTO_DATA_DIR: custom }), path.resolve(custom));
	});

	it("lê config.json, resolvendo caminho relativo a partir do aplicativo", () => {
		const base = tempDir("ponto-base");
		fs.writeFileSync(path.join(base, "config.json"), JSON.stringify({ dataDir: "dados-compartilhados" }));
		assert.equal(resolveDataDir(base, {}), path.join(base, "dados-compartilhados"));
	});

	it("aceita caminho absoluto no config.json", () => {
		const base = tempDir("ponto-base");
		const absolute = path.join(tempDir("ponto-abs"), "dados");
		fs.writeFileSync(path.join(base, "config.json"), JSON.stringify({ dataDir: absolute }));
		assert.equal(resolveDataDir(base, {}), path.normalize(absolute));
	});

	it("usa data/ dentro do aplicativo quando não há configuração", () => {
		const base = tempDir("ponto-base");
		assert.equal(resolveDataDir(base, {}), defaultDataDir(base));
		assert.equal(resolveDataDir(base, {}), path.join(base, "data"));
	});
});

describe("estado do servidor", () => {
	it("grava, lê e remove o estado", () => {
		const base = tempDir("ponto-estado");
		assert.equal(readState(base), null);
		writeState(base, { port: 8123, pid: 4321, startedAt: "2026-10-22T00:00:00.000Z", version: "1.0.0" });
		const state = readState(base);
		assert.equal(state.port, 8123);
		assert.equal(state.pid, 4321);
		removeState(base);
		assert.equal(readState(base), null);
	});

	it("ignora estado corrompido", () => {
		const base = tempDir("ponto-estado");
		fs.mkdirSync(path.join(base, "state"), { recursive: true });
		fs.writeFileSync(path.join(base, "state", "server.json"), "{ não é json");
		assert.equal(readState(base), null);
	});
});

describe("identidade do servidor", () => {
	it("reconhece o Ponto Digital pelo healthcheck + título", async () => {
		const { server, port } = await startFakeApp();
		try {
			assert.equal(await isPontoDigital(port), true);
		} finally {
			await closeServer(server);
		}
	});

	it("recusa um programa que responde healthz mas não é o Ponto Digital", async () => {
		const { server, port } = await startFakeApp({ title: "<title>Outro sistema</title>" });
		try {
			assert.equal(await isPontoDigital(port), false);
		} finally {
			await closeServer(server);
		}
	});

	it("recusa healthcheck com status diferente de ok", async () => {
		const { server, port } = await startFakeApp({ health: { status: "degraded" } });
		try {
			assert.equal(await isPontoDigital(port), false);
		} finally {
			await closeServer(server);
		}
	});

	it("porta fechada não é o Ponto Digital", async () => {
		const { server, port } = await startFakeApp();
		await closeServer(server);
		assert.equal(await isPontoDigital(port), false);
	});
});

describe("portas", () => {
	it("detecta porta livre e ocupada", async () => {
		const { server, port } = await startFakeApp();
		try {
			assert.equal(await isPortFree(port), false);
		} finally {
			await closeServer(server);
		}
		assert.equal(await isPortFree(port), true);
	});

	it("a checagem usada na escolha da porta cobre escuta em qualquer interface", async () => {
		const { server, port } = await startFakeApp();
		try {
			assert.equal(await isPortAvailable(port), false);
		} finally {
			await closeServer(server);
		}
		assert.equal(await isPortAvailable(port), true);
	});
});

describe("ensureServer", () => {
	it("reutiliza um servidor já ativo em vez de iniciar outro", async () => {
		const { server, port } = await startFakeApp();
		const base = tempDir("ponto-reuso");
		try {
			const serverInfo = await ensureServer({
				baseDir: base,
				portableDir: path.join(base, "pacote-inexistente"),
				ports: [port],
				log: { info: () => {}, warn: () => {}, error: () => {}, child: () => {} },
			});
			assert.equal(serverInfo.reused, true);
			assert.equal(serverInfo.port, port);
			assert.equal(readState(base)?.adopted, true);
		} finally {
			await closeServer(server);
		}
	});

	it("falha com mensagem amigável quando o pacote está incompleto", async () => {
		const base = tempDir("ponto-incompleto");
		const portable = path.join(base, "pacote");
		fs.mkdirSync(portable, { recursive: true });
		await assert.rejects(
			ensureServer({
				baseDir: base,
				portableDir: portable,
				ports: [18080 + Math.floor(Math.random() * 500)],
				timeoutMs: 1000,
				log: { info: () => {}, warn: () => {}, error: () => {}, child: () => {} },
			}),
			(error) => {
				assert.match(error.userMessage, /incompleto/i);
				return true;
			},
		);
	});
});

describe("waitForHealth", () => {
	it("encerra assim que o processo morre", async () => {
		const start = Date.now();
		const result = await waitForHealth(1, { timeoutMs: 5000, intervalMs: 50, isAlive: () => false });
		assert.equal(result, "exit");
		assert.ok(Date.now() - start < 1000);
	});
});

describe("mensagens de erro", () => {
	it("mostra só a informação útil, sem caminho nem stack", () => {
		const detail = friendlyDetail([
			"Error: O banco portátil já está aberto por outra estação: pid 42 em PC-01.",
			"    at openPortableDatabase (C:\\projeto\\lib\\db\\src\\portable.ts:12:3)",
			"[2026-10-22T10:00:00.000Z] [info] Modo portátil ativo",
			"Falhou em C:\\Users\\Fulano\\AppData\\Local\\PontoDigital\\data",
		]);
		assert.match(detail, /banco portátil/);
		assert.ok(!detail.includes("C:\\"));
		assert.ok(!detail.includes("    at "));
	});

	it("preserva a exceção em vez da versão do Node", () => {
		const detail = friendlyDetail([
			"Error: ENOENT: no such file or directory, open 'C:\\app\\pdfium.wasm'",
			"    at Object.openSync (node:fs:596:3)",
			"Node.js v24.12.0",
		]);
		assert.match(detail, /ENOENT/);
		assert.ok(!detail.includes("Node.js"));
		assert.ok(!detail.includes("C:\\app"));
	});

	it("launcherError carrega mensagem e detalhe", () => {
		const error = launcherError("Mensagem", "Detalhe");
		assert.equal(error.userMessage, "Mensagem");
		assert.equal(error.detail, "Detalhe");
	});

	it("stopServer sem servidor não faz nada", async () => {
		await stopServer(null, { info: () => {} });
	});

	it("stopServer encerra servidor adotado (sem processo filho)", async () => {
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
		await new Promise((resolve, reject) => {
			child.once("spawn", resolve);
			child.once("error", reject);
		});

		await stopServer({ pid: child.pid, child: null }, { info: () => {} });

		const limite = Date.now() + 5000;
		while (child.exitCode === null && child.signalCode === null && Date.now() < limite) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.ok(
			child.exitCode !== null || child.signalCode !== null,
			"o processo adotado deveria ter sido encerrado",
		);
	});
});
