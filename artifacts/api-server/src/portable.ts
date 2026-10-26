/**
 * Entry do modo portátil.
 *
 * Diferenças em relação ao `index.ts` (usado na Vercel e em servidores com
 * banco instalado):
 * - inicializa um PostgreSQL embutido (PGlite) em arquivo, sem `DATABASE_URL`;
 * - serve a interface compilada na mesma porta, para as demais estações da rede
 *   abrirem apenas o navegador;
 * - gera um `SESSION_SECRET` estável em arquivo quando não configurado, já que
 *   não há tela de configuração de ambiente para o operador.
 *
 * Nada aqui é carregado pelo deploy da Vercel.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

/**
 * `NODE_ENV` é lido pelo logger para escolher entre a saída formatada
 * (desenvolvimento) e a simples (produção). O operador não configura nada
 * no modo portátil, então o padrão é o de desenvolvimento.
 */
process.env.NODE_ENV ??= "development";

/**
 * Raiz do pacote *empacotado* (`dist-portable/server`), onde `portable.mjs`,
 * `front/` e `migrations/` ficam lado a lado. Quando não é um pacote (execução
 * direta do repositório), esses diretórios vivem em outro lugar.
 */
const bundleDir = import.meta.dirname;

/** Raiz do repositório, usada apenas no desenvolvimento. */
const repoRoot = path.resolve(bundleDir, "..", "..", "..");

/**
 * Localiza um diretório que existe tanto no pacote (`server/`) quanto no
 * repositório. O pacote tem prioridade, porque é a forma de distribuição.
 */
function resolveResourceDirectory(packagedName: string, repoRelative: string): string {
	const packaged = path.join(bundleDir, packagedName);
	if (existsSync(packaged)) return packaged;
	return path.join(repoRoot, ...repoRelative.split("/"));
}

const migrationsFolder = resolveResourceDirectory("migrations", "lib/db/migrations");
const frontendDir = resolveResourceDirectory("front", "artifacts/ponto-digital/dist/public");

function resolveDataDir(): string {
	const configured = process.env.PONTO_DATA_DIR?.trim();
	if (configured) {
		return path.isAbsolute(configured) ? path.normalize(configured) : path.resolve(repoRoot, configured);
	}
	return path.join(repoRoot, "data");
}

const dataDir = resolveDataDir();
mkdirSync(dataDir, { recursive: true });

// Modo portátil explícito: o lib/db não exige DATABASE_URL nesta modalidade.
process.env.PONTO_DB_MODE = "portable";

/**
 * `SESSION_SECRET` protege o CPF (HMAC) e a senha de SMTP (AES). No modo
 * portátil não existe painel de ambiente, então o segredo é criado uma única
 * vez e guardado junto dos dados — mantendo os valores legíveis entre reinícios.
 */
function ensureSessionSecret(): string {
	const existing = process.env.SESSION_SECRET?.trim();
	if (existing) return existing;

	const secretFile = path.join(dataDir, "SESSION_SECRET.txt");
	if (existsSync(secretFile)) {
		const stored = readFileSync(secretFile, "utf8").trim();
		if (stored) {
			process.env.SESSION_SECRET = stored;
			return stored;
		}
	}

	const generated = randomBytes(48).toString("base64");
	process.env.SESSION_SECRET = generated;
	try {
		writeFileSync(secretFile, generated, "utf8");
	} catch {
		// Sem permissão de escrita, o segredo vale só para esta execução.
	}
	return generated;
}

const sessionSecret = ensureSessionSecret();

const { openPortableDatabase } = await import("@workspace/db/portable");
const handle = await openPortableDatabase({
	dataDir,
	// O bundle embute o lib/db, então o caminho das migrações é resolvido aqui.
	migrationsFolder,
});

const { default: app } = await import("./app");
const { logger } = await import("./lib/logger");
const { serveFrontend } = await import("./lib/static-frontend");

const servingFrontend = serveFrontend(app, frontendDir);

const port = Number(process.env.PORT ?? 8080);
if (Number.isNaN(port) || port <= 0) {
	throw new Error(`Valor de PORT inválido: "${process.env.PORT}"`);
}

const server = app.listen(port, () => {
	const shown = servingFrontend ? frontendDir : "(interface não compilada)";
	logger.info(
		{ port, dataDir, frontendDir: shown, sessionSecretSource: process.env.SESSION_SECRET === sessionSecret ? "arquivo/ambiente" : "memória" },
		"Modo portátil ativo",
	);
	if (!servingFrontend) {
		logger.warn(
			"A interface não foi encontrada. Rode `pnpm --filter @workspace/ponto-digital run build` para compilá-la.",
		);
	}
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	logger.info({ signal }, "Encerrando o modo portátil");
	server.close(async () => {
		await handle.close();
		process.exit(0);
	});
	// Se conexões ficarem penduradas, não trava o encerramento.
	setTimeout(() => process.exit(0), 5000).unref();
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
	process.on(signal, () => {
		void shutdown(signal);
	});
}

/**
 * Encerramento ordenado pedido pelo aplicativo desktop (`desktop/launcher.js`).
 *
 * No modo portátil clássico (`Iniciar-Ponto.bat`) não existe canal IPC e este
 * evento nunca dispara; o comportamento continua o mesmo. No aplicativo
 * instalado, fechar a janela fecha o banco e libera a trava antes de sair, em
 * vez de depender do encerramento abrupto do processo.
 */
process.on("message", (message) => {
	if (message && typeof message === "object" && (message as { type?: unknown }).type === "shutdown") {
		void shutdown("ipc");
	}
});

/**
 * Libera a trava de forma síncrona antes de o processo morrer.
 *
 * No Windows o encerramento do console (Ctrl+C no `.bat`, fechar a janela) não
 * entrega `SIGTERM`: o processo simplesmente termina. Sem este gancho, uma
 * trava órfã sobraria no disco e a próxima abertura seria recusada até o
 * intervalo de expiração. O `exit` é o último ponto em que dá para agir.
 */
process.on("exit", () => {
	handle.removeLockSync();
});
