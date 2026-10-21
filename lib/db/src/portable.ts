import { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerPortableDatabase } from "./index";
import * as schema from "./schema";

/**
 * Modo portátil — PostgreSQL embutido (PGlite/WASM) gravado em arquivo.
 *
 * Permite rodar o sistema direto de uma pasta (inclusive de rede) sem instalar
 * nenhum servidor de banco. Este módulo é carregado apenas pelo entry portátil,
 * nunca pelo deploy da Vercel, que continua usando `pg` + `DATABASE_URL`.
 *
 * ## Concorrência — leia antes de usar em rede
 *
 * O PGlite **não implementa trava entre processos**: se duas máquinas abrirem o
 * mesmo diretório de dados, a última a fechar sobrescreve o que a outra gravou
 * (perda silenciosa de dados). O modo portátil pressupõe, portanto, **uma única
 * estação executando a API**; as demais abrem apenas o navegador. O arquivo de
 * trava abaixo transforma esse abuso em erro explícito, em vez de corrupção.
 */

/** Subdiretório do banco dentro da pasta de dados. */
const DATABASE_DIRECTORY = "banco";

/** Arquivo que sinaliza qual estação está com o banco aberto. */
const LOCK_FILENAME = "LOCK-PONTO.json";

/** Sem renovação por este tempo, a trava é considerada abandonada. */
const LOCK_STALE_MS = 90_000;

/** Intervalo de renovação da trava. */
const LOCK_HEARTBEAT_MS = 20_000;

export interface PortablePaths {
	/** Pasta de dados informada pelo operador (ou a padrão). */
	dataDir: string;
	/** Onde o banco em arquivo é gravado. */
	databaseDir: string;
	/** Caminho do arquivo de trava. */
	lockFile: string;
}

export interface PortableHandle {
	db: PgliteDatabase<typeof schema>;
	client: PGlite;
	paths: PortablePaths;
	/** Libera a trava e fecha o banco. */
	close: () => Promise<void>;
	/**
	 * Remove a trava de forma síncrona, sem fechar o banco.
	 *
	 * Para o gancho `process.on("exit")`, no qual não é possível aguardar
	 * promessas. Não deve ser usada no fluxo normal — use `close()`.
	 */
	removeLockSync: () => void;
}

interface LockPayload {
	pid: number;
	host: string;
	startedAt: string;
	heartbeatAt: string;
}

function readLock(lockFile: string): LockPayload | null {
	try {
		if (!existsSync(lockFile)) return null;
		const parsed = JSON.parse(readFileSync(lockFile, "utf8")) as Partial<LockPayload>;
		if (typeof parsed.pid !== "number" || typeof parsed.heartbeatAt !== "string") return null;
		return parsed as LockPayload;
	} catch {
		// Trava ilegível (arquivo truncado por uma queda) é tratada como livre.
		return null;
	}
}

function isStale(lock: LockPayload): boolean {
	const heartbeat = Date.parse(lock.heartbeatAt);
	return Number.isNaN(heartbeat) || Date.now() - heartbeat > LOCK_STALE_MS;
}

/**
 * `true` quando a trava é do próprio computador e o processo que a criou já
 * morreu.
 *
 * No Windows o encerramento pela janela do console é um `TerminateProcess`:
 * nenhum gancho do Node roda e a trava ficaria órfã até expirar. Consultar a
 * existência do processo (mesma máquina) devolve a pasta imediatamente, sem
 * esperar o intervalo de expiração. Em máquinas diferentes isso não é possível
 * nem necessário — a expiração cobre o caso.
 */
function belongsToDeadLocalProcess(lock: LockPayload): boolean {
	if (lock.host !== currentHost()) return false;
	try {
		// `kill(pid, 0)` não envia sinal: só testa se o processo existe.
		// `EPERM` significa que existe mas é de outro usuário — está vivo.
		process.kill(lock.pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}

function currentHost(): string {
	return process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "desconhecido";
}

function writeLock(lockFile: string): void {
	const now = new Date().toISOString();
	const payload: LockPayload = {
		pid: process.pid,
		host: currentHost(),
		startedAt: now,
		heartbeatAt: now,
	};
	try {
		writeFileSync(lockFile, JSON.stringify(payload, null, 2), "utf8");
	} catch {
		// Pasta somente leitura ou rede caindo não deve derrubar a aplicação.
	}
}

function removeOwnLock(lockFile: string): void {
	const lock = readLock(lockFile);
	// Só remove a trava se ela ainda pertencer a este processo.
	if (lock && lock.pid !== process.pid) return;
	try {
		rmSync(lockFile, { force: true });
	} catch {
		// ignore
	}
}

/** Caminho das migrações versionadas (`drizzle-kit generate`). */
function defaultMigrationsFolder(): string {
	// Quando o pacote é executado a partir do código-fonte (`lib/db/src`), as
	// migrações ficam um nível acima. O bundle da API embute este módulo e passa
	// o caminho explicitamente.
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
}

export interface PortableOptions {
	/** Pasta de dados (banco + arquivos). */
	dataDir: string;
	/**
	 * Pasta das migrações SQL. Necessário quando o módulo roda empacotado, caso
	 * em que o caminho relativo ao bundle não corresponde ao código-fonte.
	 */
	migrationsFolder?: string;
}

/**
 * Abre (ou cria) o banco portátil, aplica as migrações e assume a trava de
 * estação única.
 *
 * @throws quando outra estação já mantém o banco aberto.
 */
export async function openPortableDatabase(
	options: PortableOptions | string,
): Promise<PortableHandle> {
	const dataDir = typeof options === "string" ? options : options.dataDir;
	const migrationsFolder = typeof options === "string"
		? defaultMigrationsFolder()
		: (options.migrationsFolder ?? defaultMigrationsFolder());

	const resolved = path.resolve(dataDir);
	const databaseDir = path.join(resolved, DATABASE_DIRECTORY);
	const lockFile = path.join(resolved, LOCK_FILENAME);

	mkdirSync(resolved, { recursive: true });

	const existing = readLock(lockFile);
	if (existing && !isStale(existing) && !belongsToDeadLocalProcess(existing)) {
		throw new Error(
			`O banco portátil já está aberto por outra estação: pid ${existing.pid} em ` +
				`${existing.host}. Feche o sistema naquele computador — ou apague ` +
				`"${LOCK_FILENAME}" caso ele tenha travado — e tente novamente. ` +
				"Duas estações gravando no mesmo arquivo causam perda de dados.",
		);
	}

	if (!existsSync(migrationsFolder)) {
		throw new Error(
			`Migrações não encontradas em ${migrationsFolder}. ` +
				"Rode `pnpm --filter @workspace/db run generate` para criá-las.",
		);
	}

	const client = new PGlite(databaseDir);
	const db = drizzle(client, { schema });
	await migrate(db, { migrationsFolder });

	// Publica o banco embutido na fachada usada pelas rotas da API.
	registerPortableDatabase(db);

	writeLock(lockFile);
	const heartbeat = setInterval(() => writeLock(lockFile), LOCK_HEARTBEAT_MS);
	heartbeat.unref?.();

	let closed = false;
	return {
		db,
		client,
		paths: { dataDir: resolved, databaseDir, lockFile },
		close: async () => {
			if (closed) return;
			closed = true;
			clearInterval(heartbeat);
			try {
				await client.close();
			} finally {
				removeOwnLock(lockFile);
			}
		},
		removeLockSync: () => {
			clearInterval(heartbeat);
			removeOwnLock(lockFile);
		},
	};
}
