import { and, eq, ilike, or } from "drizzle-orm";
import { Router, type IRouter } from "express";
import multer from "multer";
import * as XLSX from "xlsx";
import { CreateEmployeeBody, UpdateEmployeeBody } from "@workspace/api-zod";
import { db, employees } from "@workspace/db";
import { recordAudit, safeString } from "../lib/audit";
import { cpfHash, maskCpf, normalizeCpf, encryptSecret } from "../lib/demo-crypto";
import { assertSpreadsheetUpload, parseWorkloadHours } from "../lib/file-validation";

const router: IRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
// Coluna lógica + formas aceitas do cabeçalho após normalização (acentos,
// espaços e símbolos removidos). Planilhas reais variam: "Acumula cargo
// (Sim/Não)", "Acumula Cargos Sim/Não", "Nome Completo" etc.
const requiredColumns = [
	{ key: "nome", label: "Nome", aliases: ["nome", "nomecompleto", "nomedoservidor"] },
	{ key: "matricula", label: "Matrícula", aliases: ["matricula", "matriculadosservidor"] },
	{ key: "cpf", label: "CPF", aliases: ["cpf", "cpfdoservidor"] },
	{ key: "email", label: "E-mail", aliases: ["email", "elettronico", "correioeletronico"] },
	{ key: "cargahoraria", label: "Carga Horária", aliases: ["cargahoraria", "cargahorariah", "horassemanais", "carga"] },
	{ key: "acumulacargossimnao", label: "Acumula cargo (Sim/Não)", aliases: ["acumulacargossimnao", "acumulacargosimnao", "acumulacargos", "acumulacargo", "acumulaoutrocargo"] },
];

function normalizeHeader(value: unknown): string {
	return String(value ?? "")
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLocaleLowerCase("pt-BR")
		.replace(/[^a-z0-9]/g, "");
}

function cellText(value: unknown): string {
	return value === null || value === undefined ? "" : String(value).trim();
}

function toApiEmployee(employee: typeof employees.$inferSelect) {
	return {
		id: employee.id,
		name: employee.name,
		matricula: employee.matricula,
		cpf: maskCpf(employee.cpfLastDigits),
		email: employee.email ?? "",
		cargo: employee.cargo,
		carga_horaria: employee.workloadHours,
		acumula: employee.accumulatesRole,
	};
}

type ParsedEmployeeRow = {
	name: string;
	matricula: string;
	cpf: string;
	email: string;
	workloadHours: number;
	accumulatesRole: boolean;
};

type ParsedEmployeeIssue = { rowNumber: number; reason: string };

function parseSpreadsheet(buffer: Buffer): { rows: ParsedEmployeeRow[]; skipped: number; issues: ParsedEmployeeIssue[] } {
	const workbook = XLSX.read(buffer, { type: "buffer", cellDates: false });
	const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
	if (!firstSheet) throw new Error("A planilha não contém uma aba.");
	const data = XLSX.utils.sheet_to_json<unknown[]>(firstSheet, { header: 1, defval: "", raw: false });
	const headers = (data[0] ?? []).map(normalizeHeader);
	const positions = new Map<string, number>();
	headers.forEach((header, index) => {
		const column = requiredColumns.find((candidate) => candidate.aliases.includes(header));
		// Primeira ocorrência vence, caso a planilha repita a coluna.
		if (column && !positions.has(column.key)) positions.set(column.key, index);
	});
	const missing = requiredColumns.filter((column) => !positions.has(column.key)).map((column) => column.label);
	if (missing.length) {
		throw new Error(`Cabeçalhos inválidos. Estão faltando: ${missing.join(", ")}.`);
	}

	let skipped = 0;
	const rows: ParsedEmployeeRow[] = [];
	const issues: ParsedEmployeeIssue[] = [];
	for (const row of data.slice(1)) {
		if (!row.some((cell) => cellText(cell))) continue;
		const value = (key: string) => cellText(row[positions.get(key) ?? -1]);
		const name = value("nome");
		const matricula = value("matricula");
		const cpf = normalizeCpf(value("cpf"));
		const email = value("email");
		// Planilhas reais trazem "20h"/"40 h"; o parser tolera o sufixo.
		const hoursValue = parseWorkloadHours(value("cargahoraria"));
		const accumulates = ["sim", "s", "true", "yes", "1"].includes(normalizeHeader(value("acumulacargossimnao")));

		if (!name || !matricula || (cpf && cpf.length !== 11) || !Number.isFinite(hoursValue) || hoursValue < 1 || hoursValue > 100) {
			skipped += 1;
			issues.push({ rowNumber: data.indexOf(row) + 1, reason: "nome, matrícula, CPF ou carga horária inválidos." });
			continue;
		}
		if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
			skipped += 1;
			issues.push({ rowNumber: data.indexOf(row) + 1, reason: "e-mail inválido." });
			continue;
		}
		rows.push({
			name,
			matricula,
			cpf,
			email,
			workloadHours: Math.round(hoursValue),
			accumulatesRole: accumulates,
		});
	}
	return { rows, skipped, issues };
}

function maskedImportRow(employee: ParsedEmployeeRow, action: string) {
	return {
		name: employee.name,
		matricula: employee.matricula,
		cpf: employee.cpf ? maskCpf(employee.cpf.slice(-2)) : maskCpf(null),
		email: employee.email,
		workloadHours: employee.workloadHours,
		accumulatesRole: employee.accumulatesRole,
		action,
	};
}

async function buildImportPreview(buffer: Buffer) {
	const { rows, skipped: invalidRows, issues } = parseSpreadsheet(buffer);
	const existing = await db.select().from(employees);
	const existingByMatricula = new Map(existing.map((employee) => [employee.matricula, employee]));
	const seen = new Set<string>();
	let newCount = 0;
	let updatedCount = 0;
	// Ignorados = matrícula repetida na planilha; erros = linhas com estrutura
	// inválida (nome, CPF, carga horária ou e-mail) — contagens separadas para
	// o operador distinguir duplicidade de dado problemático.
	let skippedCount = 0;
	const errorCount = invalidRows;
	const previewRows: Array<Record<string, unknown>> = [];

	for (const employee of rows) {
		if (seen.has(employee.matricula)) {
			skippedCount += 1;
			previewRows.push(maskedImportRow(employee, "ignorar — matrícula repetida na planilha"));
			continue;
		}
		seen.add(employee.matricula);
		if (existingByMatricula.has(employee.matricula)) {
			updatedCount += 1;
			previewRows.push(maskedImportRow(employee, "atualizar"));
		} else {
			newCount += 1;
			previewRows.push(maskedImportRow(employee, "novo"));
		}
	}
	if (invalidRows) previewRows.push({ action: `${invalidRows} linha(s) com erro: ${issues.slice(0, 5).map((issue) => `linha ${issue.rowNumber} (${issue.reason})`).join("; ")}${issues.length > 5 ? "; ..." : ""}` });
	return { newCount, updatedCount, skippedCount, errorCount, rows: previewRows };
}

router.get("/employees", async (req, res, next): Promise<void> => {
	try {
		const query = safeString(req.query.q);
		const digits = normalizeCpf(query);
		const cpfExactHash = digits.length === 11 ? cpfHash(digits) : null;
		const predicate = query
			? or(
					ilike(employees.name, `%${query}%`),
					ilike(employees.matricula, `%${query}%`),
					ilike(employees.email, `%${query}%`),
					digits.length > 0 ? ilike(employees.cpfLastDigits, `%${digits.slice(-2)}%`) : undefined,
					cpfExactHash ? eq(employees.cpfSearchHash, cpfExactHash) : undefined,
				)
			: undefined;
		const results = await db
			.select()
			.from(employees)
			.where(predicate ? and(eq(employees.active, true), predicate) : eq(employees.active, true))
			.orderBy(employees.name);
		res.json(results.map(toApiEmployee));
	} catch (error) {
		next(error);
	}
});

router.post("/employees", async (req, res, next): Promise<void> => {
	try {
		const parsed = CreateEmployeeBody.safeParse(req.body);
		if (!parsed.success) {
			res.status(400).json({ message: "Revise os campos do servidor.", issues: parsed.error.issues });
			return;
		}
		const input = parsed.data;
		const cpfDigits = normalizeCpf(input.cpf);
		if (input.cpf && cpfDigits.length !== 11) {
			res.status(400).json({ message: "CPF deve conter 11 dígitos ou ficar em branco." });
			return;
		}
		if (input.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) {
			res.status(400).json({ message: "E-mail inválido." });
			return;
		}
		const [created] = await db
			.insert(employees)
			.values({
				name: input.name.trim(),
				matricula: input.matricula.trim(),
				cpfEncrypted: cpfDigits ? encryptSecret(cpfDigits) : null,
				cpfLastDigits: cpfDigits ? cpfDigits.slice(-2) : null,
				cpfSearchHash: cpfHash(cpfDigits),
				email: input.email?.trim() || null,
				cargo: input.cargo?.trim() || "",
				workloadHours: input.workloadHours ?? 40,
				accumulatesRole: input.accumulatesRole ?? false,
			})
			.returning();
		await recordAudit("servidor_criado", "employee", String(created.id), {
			name: created.name,
			matricula: created.matricula,
		});
		req.log.info({ employeeId: created.id }, "Synthetic employee record created");
		res.status(201).json(toApiEmployee(created));
	} catch (error) {
		if (typeof error === "object" && error && "code" in error && error.code === "23505") {
			res.status(409).json({ message: "Já existe um servidor com essa matrícula." });
			return;
		}
		next(error);
	}
});

router.patch("/employees/:id", async (req, res, next): Promise<void> => {
	try {
		const id = Number(req.params.id);
		if (!Number.isInteger(id) || id < 1) {
			res.status(400).json({ message: "Identificador inválido." });
			return;
		}
		const parsed = UpdateEmployeeBody.safeParse(req.body);
		if (!parsed.success) {
			res.status(400).json({ message: "Revise os campos do servidor.", issues: parsed.error.issues });
			return;
		}
		const input = parsed.data;
		const update: Partial<typeof employees.$inferInsert> = { updatedAt: new Date() };
		if (input.name !== undefined) update.name = input.name.trim();
		if (input.matricula !== undefined) update.matricula = input.matricula.trim();
		if (input.cargo !== undefined) update.cargo = input.cargo.trim();
		if (input.email !== undefined) {
			if (input.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) {
				res.status(400).json({ message: "E-mail inválido." });
				return;
			}
			update.email = input.email.trim() || null;
		}
		if (input.workloadHours !== undefined) update.workloadHours = input.workloadHours;
		if (input.accumulatesRole !== undefined) update.accumulatesRole = input.accumulatesRole;
		if (input.cpf !== undefined) {
			const cpfDigits = normalizeCpf(input.cpf);
			if (input.cpf && cpfDigits.length !== 11) {
				res.status(400).json({ message: "CPF deve conter 11 dígitos ou ficar em branco." });
				return;
			}
			update.cpfEncrypted = cpfDigits ? encryptSecret(cpfDigits) : null;
			update.cpfLastDigits = cpfDigits ? cpfDigits.slice(-2) : null;
			update.cpfSearchHash = cpfHash(cpfDigits);
		}
		const [updated] = await db
			.update(employees)
			.set(update)
			.where(and(eq(employees.id, id), eq(employees.active, true)))
			.returning();
		if (!updated) {
			res.status(404).json({ message: "Servidor não encontrado." });
			return;
		}
		await recordAudit("servidor_atualizado", "employee", String(id), {
			name: updated.name,
			matricula: updated.matricula,
		});
		res.json(toApiEmployee(updated));
	} catch (error) {
		if (typeof error === "object" && error && "code" in error && error.code === "23505") {
			res.status(409).json({ message: "Já existe um servidor com essa matrícula." });
			return;
		}
		next(error);
	}
});

router.delete("/employees/:id", async (req, res, next): Promise<void> => {
	try {
		const id = Number(req.params.id);
		if (!Number.isInteger(id) || id < 1) {
			res.status(400).json({ message: "Identificador inválido." });
			return;
		}
		const [removed] = await db
			.update(employees)
			.set({ active: false, updatedAt: new Date() })
			.where(and(eq(employees.id, id), eq(employees.active, true)))
			.returning({ id: employees.id, name: employees.name, matricula: employees.matricula });
		if (!removed) {
			res.status(404).json({ message: "Servidor não encontrado." });
			return;
		}
		await recordAudit("servidor_desativado", "employee", String(id), removed);
		res.status(204).end();
	} catch (error) {
		next(error);
	}
});

router.post("/employees/import/preview", upload.single("file"), async (req, res, next): Promise<void> => {
	try {
		const file = assertSpreadsheetUpload(req.file);
		res.json(await buildImportPreview(file.buffer));
	} catch (error) {
		res.status(422).json({ message: error instanceof Error ? error.message : "Não foi possível validar a planilha." });
	}
});

router.post("/employees/import", upload.single("file"), async (req, res, next): Promise<void> => {
	try {
		const file = assertSpreadsheetUpload(req.file);
		const { rows, skipped: invalidRows } = parseSpreadsheet(file.buffer);
		const existing = await db.select().from(employees);
		const existingByMatricula = new Map(existing.map((employee) => [employee.matricula, employee]));
		const seen = new Set<string>();
		let imported = 0;
		let updated = 0;
		let skipped = invalidRows;

		await db.transaction(async (tx) => {
			for (const input of rows) {
				if (seen.has(input.matricula)) {
					skipped += 1;
					continue;
				}
				seen.add(input.matricula);
				const old = existingByMatricula.get(input.matricula);
				const cpfDigits = input.cpf;
				const patch: typeof employees.$inferInsert = {
					name: input.name,
					matricula: input.matricula,
					cpfEncrypted: cpfDigits ? encryptSecret(cpfDigits) : (old?.cpfEncrypted ?? null),
					cpfLastDigits: cpfDigits ? cpfDigits.slice(-2) : (old?.cpfLastDigits ?? null),
					cpfSearchHash: cpfDigits ? cpfHash(cpfDigits) : (old?.cpfSearchHash ?? null),
					email: input.email || old?.email || null,
					cargo: old?.cargo ?? "",
					workloadHours: input.workloadHours,
					accumulatesRole: input.accumulatesRole,
					active: true,
					updatedAt: new Date(),
				};
				if (old) {
					await tx.update(employees).set(patch).where(eq(employees.id, old.id));
					updated += 1;
				} else {
					await tx.insert(employees).values(patch);
					imported += 1;
				}
			}
		});
		await recordAudit("servidores_importados", "employee", "import", { imported, updated, skipped });
		req.log.info({ imported, updated, skipped }, "Synthetic employee spreadsheet imported");
		res.json({ imported, updated, skipped });
	} catch (error) {
		if (error instanceof Error && error.message.includes("Cabeçalhos inválidos")) {
			res.status(422).json({ message: error.message });
			return;
		}
		next(error);
	}
});

export default router;
