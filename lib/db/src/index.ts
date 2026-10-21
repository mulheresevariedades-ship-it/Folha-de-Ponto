import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

/**
 * Driver padrão: PostgreSQL gerenciado (`pg`), ativado por `DATABASE_URL`.
 * É o caminho do deploy na Vercel e de qualquer servidor com banco instalado.
 *
 * O modo portátil (`@workspace/db/portable`) registra um banco embutido
 * (PGlite em arquivo) e não depende de `DATABASE_URL`. A escolha é explícita
 * via `PONTO_DB_MODE=portable`, e não pela ausência da variável, para que
 * esquecer a configuração continue sendo um erro claro.
 */
export const isPortableMode = process.env.PONTO_DB_MODE === "portable";

const connectionString = process.env.DATABASE_URL;

if (!isPortableMode && !connectionString) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = connectionString && !isPortableMode
  ? new Pool({ connectionString })
  : null;

export type NodeDatabase = NodePgDatabase<typeof schema>;

let activeDatabase: NodeDatabase | null = pool ? drizzle(pool, { schema }) : null;

/**
 * Registra o banco embutido do modo portátil. Chamado pelo entry portátil
 * durante o boot, antes de qualquer requisição ser atendida.
 */
export function registerPortableDatabase(instance: unknown): void {
  activeDatabase = instance as NodeDatabase;
}

function requireActive(): NodeDatabase {
  if (!activeDatabase) {
    throw new Error(
      "Nenhum banco ativo. Defina DATABASE_URL ou inicie pelo entry portátil " +
        "(PONTO_DB_MODE=portable).",
    );
  }
  return activeDatabase;
}

/**
 * Fachada estável usada pelas rotas: delega sempre para o banco ativo, o que
 * permite ao modo portátil substituir o driver no boot sem alterar nenhuma
 * rota. Métodos são vinculados à instância real para que `this` continue
 * correto dentro do drizzle.
 */
export const db = new Proxy({} as NodeDatabase, {
	get(_target, property) {
		const instance = requireActive();
		const value = Reflect.get(instance as object, property);
		return typeof value === "function" ? value.bind(instance) : value;
	},
}) as NodeDatabase;

export * from "./schema";
