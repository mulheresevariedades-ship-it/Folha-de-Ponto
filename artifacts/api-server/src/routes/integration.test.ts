import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import * as XLSX from "xlsx";
import { after, before, describe, it } from "node:test";

const sessionId = "integration-session-0001";
const competingSessionId = "integration-session-0002";
const spreadsheetMime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

let baseUrl = "";
let dataDir = "";
let server: Server | null = null;
let databaseHandle: { close: () => Promise<void> } | null = null;

function spreadsheetBuffer(rows: unknown[][]): Buffer {
	const workbook = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "Dados");
	return Buffer.from(XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }));
}

function spreadsheetForm(buffer: Buffer, filename = "dados.xlsx"): FormData {
	const form = new FormData();
	const bytes = Uint8Array.from(buffer);
	form.append("file", new Blob([bytes.buffer], { type: spreadsheetMime }), filename);
	return form;
}

async function postJson(route: string, value: unknown, owner = sessionId): Promise<Response> {
	return fetch(`${baseUrl}/api${route}`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-demo-session": owner },
		body: JSON.stringify(value),
	});
}

async function postSpreadsheet(route: string, buffer: Buffer, filename = "dados.xlsx"): Promise<Response> {
	return fetch(`${baseUrl}/api${route}`, {
		method: "POST",
		headers: { "x-demo-session": sessionId },
		body: spreadsheetForm(buffer, filename),
	});
}

async function responseJson<T>(response: Response): Promise<T> {
	return response.json() as Promise<T>;
}

describe("integração das rotas administrativas", () => {
	before(async () => {
		process.env.PONTO_DB_MODE = "portable";
		process.env.SESSION_SECRET = "api-integration-test-session-secret";
		dataDir = await mkdtemp(path.join(tmpdir(), "ponto-api-integration-"));

		const { openPortableDatabase } = await import("@workspace/db/portable");
		databaseHandle = await openPortableDatabase({
			dataDir,
			migrationsFolder: fileURLToPath(new URL("../../../../lib/db/migrations", import.meta.url)),
		});
		const { default: app } = await import("../app");
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve, reject) => {
			server?.once("listening", resolve);
			server?.once("error", reject);
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Não foi possível iniciar o servidor de teste.");
		baseUrl = `http://127.0.0.1:${address.port}`;

		const lock = await postJson("/lock/heartbeat", { sessionId });
		assert.equal(lock.status, 200);
	});

	after(async () => {
		if (server) {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => {
				server?.close((error) => error ? reject(error) : resolve());
			});
		}
		await databaseHandle?.close();
		if (dataDir) await rm(dataDir, { recursive: true, force: true });
		delete process.env.PONTO_DB_MODE;
		delete process.env.SESSION_SECRET;
	});

	it("protege gravações com o lock de sessão", async () => {
		const missingSession = await fetch(`${baseUrl}/api/calendar`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ date: "2027-12-24", description: "Recesso", type: "recesso" }),
		});
		assert.equal(missingSession.status, 428);

		const competingSession = await postJson(
			"/calendar",
			{ date: "2027-12-24", description: "Recesso", type: "recesso" },
			competingSessionId,
		);
		assert.equal(competingSession.status, 423);
	});

	it("faz prévia e importação de servidores, sem gravar antes da confirmação", async () => {
		const employees = spreadsheetBuffer([
			["Nome", "Matrícula", "CPF", "E-mail", "Carga Horária", "Acumula cargo (Sim/Não)"],
			["Maria Silva", "12345", "12345678909", "maria@example.com", "40h", "Não"],
			["Duplicada", "12345", "", "", "20h", "Sim"],
			["Linha inválida", "12346", "", "", "sem horas", "Não"],
		]);

		const previewResponse = await postSpreadsheet("/employees/import/preview", employees);
		assert.equal(previewResponse.status, 200);
		const preview = await responseJson<{ newCount: number; skippedCount: number; errorCount: number }>(previewResponse);
		assert.equal(preview.newCount, 1);
		assert.equal(preview.skippedCount, 1);
		assert.equal(preview.errorCount, 1);

		const beforeImport = await responseJson<{ total: number }>(await fetch(`${baseUrl}/api/employees`));
		assert.equal(beforeImport.total, 0);

		const importResponse = await postSpreadsheet("/employees/import", employees);
		assert.equal(importResponse.status, 200);
		assert.deepEqual(await responseJson(importResponse), { imported: 1, updated: 0, skipped: 2 });

		const byName = await responseJson<{ items: Array<{ id: number; name: string; active: boolean }>; total: number }>(
			await fetch(`${baseUrl}/api/employees?q=Maria`),
		);
		assert.equal(byName.total, 1);
		assert.equal(byName.items[0].name, "Maria Silva");

		const updatedSheet = spreadsheetBuffer([
			["Nome", "Matrícula", "CPF", "E-mail", "Carga Horária", "Acumula cargo (Sim/Não)"],
			["Maria Silva Atualizada", "12345", "12345678909", "maria.updated@example.com", "30h", "Sim"],
			["Ana Costa", "67890", "98765432100", "ana@example.com", "40h", "Não"],
		]);
		const updatePreview = await responseJson<{ newCount: number; updatedCount: number }>(
			await postSpreadsheet("/employees/import/preview", updatedSheet),
		);
		assert.equal(updatePreview.newCount, 1);
		assert.equal(updatePreview.updatedCount, 1);
		assert.deepEqual(
			await responseJson(await postSpreadsheet("/employees/import", updatedSheet)),
			{ imported: 1, updated: 1, skipped: 0 },
		);

		const cpfSearch = await responseJson<{ items: Array<{ id: number }> }>(
			await fetch(`${baseUrl}/api/employees?q=12345678909`),
		);
		assert.equal(cpfSearch.items.length, 1);
		const employeeId = cpfSearch.items[0].id;

		const updated = await fetch(`${baseUrl}/api/employees/${employeeId}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", "x-demo-session": sessionId },
			body: JSON.stringify({ name: "Maria Silva Manual" }),
		});
		assert.equal(updated.status, 200);
		assert.equal((await responseJson<{ name: string }>(updated)).name, "Maria Silva Manual");

		const removed = await fetch(`${baseUrl}/api/employees/${employeeId}`, {
			method: "DELETE",
			headers: { "x-demo-session": sessionId },
		});
		assert.equal(removed.status, 204);
		const reactivated = await fetch(`${baseUrl}/api/employees/${employeeId}/reactivate`, {
			method: "POST",
			headers: { "x-demo-session": sessionId },
		});
		assert.equal(reactivated.status, 200);
		assert.equal((await responseJson<{ active: boolean }>(reactivated)).active, true);

		const rejected = await postSpreadsheet("/employees/import/preview", Buffer.from("Nome,Matricula"), "dados.csv");
		assert.equal(rejected.status, 422);
	});

	it("faz prévia/importação do calendário e mantém edição manual", async () => {
		const firstSheet = spreadsheetBuffer([
			["Data", "Especificação"],
			["01/01/2027", "Feriado Nacional"],
			["01/07/2027", "Recesso Acadêmico"],
			["01/07/2027", "Data repetida"],
			["31/02/2027", "Data inválida"],
		]);
		const previewResponse = await postSpreadsheet("/calendar/import/preview", firstSheet);
		assert.equal(previewResponse.status, 200);
		assert.deepEqual(
			await responseJson(previewResponse),
			{
				newCount: 2,
				updatedCount: 0,
				skippedCount: 2,
				rows: [
					{ date: "2027-01-01", description: "Feriado Nacional", type: "feriado", action: "novo" },
					{ date: "2027-07-01", description: "Recesso Acadêmico", type: "recesso", action: "novo" },
					{ date: "2027-07-01", description: "Data repetida", action: "ignorar — data repetida na planilha" },
					{ date: "", description: "", type: "", action: "1 linha(s) ignorada(s): data, tipo ou especificação inválida." },
				],
			},
		);
		assert.deepEqual(await responseJson(await postSpreadsheet("/calendar/import", firstSheet)), {
			imported: 2,
			updated: 0,
			skipped: 2,
		});

		const replacement = spreadsheetBuffer([
			["Data", "Especificação"],
			["01/01/2027", "Feriado atualizado"],
			["01/07/2027", "Recesso atualizado"],
			["15/08/2027", "Ponto Facultativo"],
		]);
		assert.deepEqual(
			await responseJson(await postSpreadsheet("/calendar/import/preview", replacement)),
			{
				newCount: 1,
				updatedCount: 2,
				skippedCount: 0,
				rows: [
					{ date: "2027-01-01", description: "Feriado atualizado", type: "feriado", action: "atualizar" },
					{ date: "2027-07-01", description: "Recesso atualizado", type: "recesso", action: "atualizar" },
					{ date: "2027-08-15", description: "Ponto Facultativo", type: "ponto_facultativo", action: "novo" },
				],
			},
		);
		assert.deepEqual(await responseJson(await postSpreadsheet("/calendar/import", replacement)), {
			imported: 1,
			updated: 2,
			skipped: 0,
		});

		const calendar = await responseJson<Array<{ id: number; date: string; description: string; type: string }>>(
			await fetch(`${baseUrl}/api/calendar?year=2027`),
		);
		assert.equal(calendar.length, 3);
		assert.equal(calendar[0].description, "Feriado atualizado");
		const manual = await postJson("/calendar", {
			date: "2027-12-24",
			description: "Recesso manual",
			type: "recesso",
		});
		assert.equal(manual.status, 201);
		const manualItem = await responseJson<{ id: number }>(manual);
		const update = await fetch(`${baseUrl}/api/calendar/${manualItem.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", "x-demo-session": sessionId },
			body: JSON.stringify({ description: "Recesso alterado" }),
		});
		assert.equal(update.status, 200);
		assert.equal((await responseJson<{ description: string }>(update)).description, "Recesso alterado");
		const remove = await fetch(`${baseUrl}/api/calendar/${manualItem.id}`, {
			method: "DELETE",
			headers: { "x-demo-session": sessionId },
		});
		assert.equal(remove.status, 204);
	});
});