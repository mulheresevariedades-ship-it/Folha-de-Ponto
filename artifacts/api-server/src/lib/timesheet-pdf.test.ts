import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTimesheetPdf, officialGeneratedTimesheetFileName, sanitizePdfText } from "./timesheet-pdf";
import { extractPdfPageTexts } from "./pdf-text";

const input = {
	employeeName: "Maria Silva Santos",
	matricula: "12345",
	competency: "2027-01",
	workloadHours: 40,
	generatedAt: new Date("2026-10-23T12:00:00Z"),
	specialDates: [
		{ date: "2027-01-01", description: "Confraternização Universal" },
		{ date: "2027-01-15", description: "Recesso Acadêmico" },
	],
};

test("gera um PDF real com a competência, o calendário e os dias corretos", async () => {
	const buffer = await buildTimesheetPdf(input);
	assert.equal(buffer.subarray(0, 5).toString("latin1"), "%PDF-");
	assert.ok(buffer.length > 2000, "o PDF precisa ter conteúdo, não ser um arquivo vazio");

	const pages = await extractPdfPageTexts(buffer);
	assert.equal(pages.length, 1, "a folha deve caber em uma página A4");
	const text = pages[0].text;

	assert.match(text, /Maria Silva Santos/);
	assert.match(text, /12345/);
	assert.match(text, /janeiro de 2027/i);
	assert.match(text, /Confraternização Universal/);
	assert.match(text, /Recesso Acadêmico/);
	assert.match(text, /31/);
	assert.match(text, /Sábado/i);
	assert.match(text, /Domingo/i);
});

test("não gera 29/02 em ano não bissexto e aceita fevereiro", async () => {
	const buffer = await buildTimesheetPdf({ ...input, competency: "2027-02", specialDates: [] });
	const text = (await extractPdfPageTexts(buffer))[0].text;
	assert.match(text, /fevereiro de 2027/i);
	assert.match(text, /28/);
	assert.doesNotMatch(text, /29\/02\/2027/);
});

test("rejeita competência inválida em vez de gerar folha sem mês", async () => {
	await assert.rejects(() => buildTimesheetPdf({ ...input, competency: "2027-13" }), /Competência inválida/);
	await assert.rejects(() => buildTimesheetPdf({ ...input, competency: "janeiro" }), /Competência inválida/);
});

test("nome do PDF segue a nomenclatura oficial por competência", () => {
	assert.equal(
		officialGeneratedTimesheetFileName({ employeeName: "Maria Silva Santos", competency: "2027-01", matricula: "12345" }),
		"Maria_Silva_Santos-2027-01.pdf",
	);
});

test("sanitiza caracteres fora do WinAnsi sem quebrar o gerador", async () => {
	assert.equal(sanitizePdfText("Ana ‘Lúcia’ — Nº 1… 😀"), "Ana 'Lúcia' - Nº 1... ");
	const buffer = await buildTimesheetPdf({ ...input, employeeName: "Ana ‘Lúcia’ — 😀" });
	assert.equal(buffer.subarray(0, 5).toString("latin1"), "%PDF-");
});
