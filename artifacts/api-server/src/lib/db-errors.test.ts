import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isUniqueViolation, postgresErrorCode } from "./db-errors";

describe("postgresErrorCode", () => {
	it("lê o código direto do erro do Postgres", () => {
		const error = Object.assign(new Error("duplicate key"), { code: "23505" });
		assert.equal(postgresErrorCode(error), "23505");
	});

	it("lê o código que o Drizzle deixou dentro do cause", () => {
		const cause = Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
		const error = Object.assign(new Error("Failed query: insert into \"employees\""), { cause });
		assert.equal(postgresErrorCode(error), "23505");
	});

	it("devolve null quando não há código de banco", () => {
		assert.equal(postgresErrorCode(new Error("falha qualquer")), null);
		assert.equal(postgresErrorCode(null), null);
		assert.equal(postgresErrorCode("texto"), null);
		assert.equal(postgresErrorCode(undefined), null);
	});
});

describe("isUniqueViolation", () => {
	it("reconhece a violação de restrição única nas duas formas", () => {
		assert.equal(isUniqueViolation(Object.assign(new Error("x"), { code: "23505" })), true);
		assert.equal(
			isUniqueViolation(
				Object.assign(new Error("x"), { cause: Object.assign(new Error("y"), { code: "23505" }) }),
			),
			true,
		);
	});

	it("não confunde outros erros", () => {
		assert.equal(isUniqueViolation(Object.assign(new Error("x"), { code: "23503" })), false);
		assert.equal(isUniqueViolation(new Error("x")), false);
	});
});
