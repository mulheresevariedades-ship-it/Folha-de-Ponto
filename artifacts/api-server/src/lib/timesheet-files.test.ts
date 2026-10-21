import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	competencyFromContent,
	isValidCompetency,
	monthFolderName,
	nameFromContent,
	matriculaFromContent,
	officialTimesheetFileName,
	oldTimesheetFileName,
	sanitizeFileStem,
	stripAccents,
} from "./timesheet-files";
import { isPdfBuffer } from "./file-validation";

describe("sanitizeFileStem", () => {
	it("remove acentos e caracteres especiais", () => {
		assert.equal(sanitizeFileStem("José da Conceição"), "Jose_da_Conceicao");
		assert.equal(sanitizeFileStem("Maria/Silva; <teste>"), "Maria_Silva_teste");
	});

	it("colapsa underscores repetidos e remove bordas", () => {
		assert.equal(sanitizeFileStem("__Ana__Maria__"), "Ana_Maria");
	});

	it("sufixa nomes reservados do Windows", () => {
		assert.equal(sanitizeFileStem("CON"), "CON_");
		assert.equal(sanitizeFileStem("com1"), "com1_");
	});

	it("trunca nomes longos preservando o início", () => {
		const stem = sanitizeFileStem("a".repeat(200), 10);
		assert.equal(stem, "a".repeat(10));
	});

	it("retorna string vazia para conteúdo sem letras ou números", () => {
		assert.equal(sanitizeFileStem("!!!"), "");
	});
});

describe("isValidCompetency", () => {
	it("aceita AAAA-MM válido", () => {
		assert.equal(isValidCompetency("2026-10"), true);
		assert.equal(isValidCompetency("2026-01"), true);
		assert.equal(isValidCompetency("2026-12"), true);
	});

	it("rejeita meses e formatos inválidos", () => {
		assert.equal(isValidCompetency("2026-00"), false);
		assert.equal(isValidCompetency("2026-13"), false);
		assert.equal(isValidCompetency("26-10"), false);
		assert.equal(isValidCompetency("2026/10"), false);
		assert.equal(isValidCompetency(""), false);
	});
});

describe("monthFolderName", () => {
	it("gera a pasta oficial Folhas_AAAA-MM", () => {
		assert.equal(monthFolderName("2026-10"), "Folhas_2026-10");
	});
});

describe("officialTimesheetFileName", () => {
	it("usa o nome oficial Nome_do_servidor-AAAA-MM.pdf", () => {
		assert.equal(
			officialTimesheetFileName({ name: "Maria da Silva", competency: "2026-10" }),
			"Maria_da_Silva-2026-10.pdf",
		);
	});

	it("usa matrícula e hash quando o servidor não foi identificado", () => {
		const fileName = officialTimesheetFileName({
			name: "",
			competency: "2026-10",
			matricula: "12345",
			unidentifiedHash: "ab12cd34",
		});
		assert.equal(fileName, "Servidor_nao_identificado_12345_ab12cd34-2026-10.pdf");
	});

	it("páginas não identificadas sem matrícula não colidem entre si", () => {
		const first = officialTimesheetFileName({ name: "  ", competency: "2026-10", unidentifiedHash: "aaaa1111" });
		const second = officialTimesheetFileName({ name: "", competency: "2026-10", unidentifiedHash: "bbbb2222" });
		assert.notEqual(first, second);
	});
});

describe("oldTimesheetFileName", () => {
	it("preserva o nome e acrescenta o carimbo _OLD_AAAAMMDD-HHMMSS", () => {
		const stamped = oldTimesheetFileName("Folhas_2026-10/Maria_Silva-2026-10.pdf", new Date(2027, 1, 15, 14, 30, 22));
		assert.equal(stamped, "Maria_Silva-2026-10_OLD_20270215-143022.pdf");
	});

	it("gera carimbos diferentes em momentos diferentes", () => {
		const first = oldTimesheetFileName("x.pdf", new Date(2027, 1, 15, 14, 30, 22));
		const second = oldTimesheetFileName("x.pdf", new Date(2027, 1, 15, 14, 30, 23));
		assert.notEqual(first, second);
	});
});

describe("isPdfBuffer", () => {
	it("reconhece a assinatura %PDF-", () => {
		assert.equal(isPdfBuffer(Buffer.from("%PDF-1.7 rest")), true);
	});

	it("rejeita conteúdos que não são PDF", () => {
		assert.equal(isPdfBuffer(Buffer.from("PK xlsx")), false);
		assert.equal(isPdfBuffer(Buffer.alloc(0)), false);
	});
});

describe("competencyFromContent", () => {
	it("identifica o mês escrito por extenso", () => {
		assert.equal(competencyFromContent("Competência outubro de 2026"), "2026-10");
		assert.equal(competencyFromContent("Folha de Março/2027"), "2027-03");
	});

	it("identifica rótulo competência/referência com MM/AAAA", () => {
		assert.equal(competencyFromContent("Competência: 10/2026"), "2026-10");
		assert.equal(competencyFromContent("Referência 03 - 2027"), "2027-03");
	});

	it("aceita MM/AAAA isolado, mas ignora datas completas dd/mm/aaaa", () => {
		assert.equal(competencyFromContent("Emitido em 05/10/2026 pago em 10/2026"), "2026-10");
		assert.equal(competencyFromContent("Data de emissão 05/10/2026"), null);
	});

	it("retorna null quando não há referência de mês", () => {
		assert.equal(competencyFromContent("Sem indicação de período no documento"), null);
	});
});

describe("matriculaFromContent", () => {
	it("extrai a matrícula numérica informada no texto", () => {
		assert.equal(matriculaFromContent("Matrícula: 12345"), "12345");
		assert.equal(matriculaFromContent("matricula 9.887.654"), "9887654");
	});

	it("retorna null quando a matrícula não aparece", () => {
		assert.equal(matriculaFromContent("Servidor sem matrícula no cabeçalho"), null);
	});
});

describe("nameFromContent", () => {
	it("extrai o nome do rótulo Nome/Servidor", () => {
		assert.equal(nameFromContent("Nome: Maria da Silva\nMatrícula: 12345"), "Maria da Silva");
		assert.equal(nameFromContent("Servidor(a): Ana Souza"), "Ana Souza");
	});

	it("ignora valores curtos demais que não continuam na linha seguinte", () => {
		assert.equal(nameFromContent("Nome: Jo"), null);
	});
});

describe("stripAccents", () => {
	it("remove acentos preservando letras", () => {
		assert.equal(stripAccents("Conceiçãoação"), "Conceicaoacao");
	});
});
