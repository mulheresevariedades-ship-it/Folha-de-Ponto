/**
 * Leitura dos erros do banco.
 *
 * O Drizzle não repassa o erro do Postgres como é: ele cria um
 * `DrizzleQueryError` com a mensagem "Failed query: ..." e guarda o erro
 * original em `cause`. Por isso, ler `error.code` diretamente não encontra o
 * código do Postgres (23505 = violação de restrição única) e a rota acabava
 * respondendo 500 com uma página de erro em HTML, em vez da mensagem que o
 * operador precisa ("Já existe um servidor com essa matrícula").
 */

/** Código do erro do Postgres, olhando o erro original dentro do `cause`. */
export function postgresErrorCode(error: unknown): string | null {
	if (typeof error !== "object" || !error) return null;
	const candidates: unknown[] = [error, (error as { cause?: unknown }).cause];
	for (const candidate of candidates) {
		if (typeof candidate !== "object" || !candidate) continue;
		const code = (candidate as { code?: unknown }).code;
		if (typeof code === "string" && code) return code;
	}
	return null;
}

/** O erro é uma violação de restrição única (matrícula ou data repetida). */
export function isUniqueViolation(error: unknown): boolean {
	return postgresErrorCode(error) === "23505";
}
