import { and, count, desc, eq, ilike, inArray, or } from "drizzle-orm";
import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import { ReviewTimesheetBody } from "@workspace/api-zod";
import { calendarEvents, db, dispatches, employees, timesheets } from "@workspace/db";
import { recordAudit, safeString } from "../lib/audit";
import { archiveStore, toArchiveKey } from "../lib/archive-store";
import { cpfHash, maskCpf, normalizeCpf } from "../lib/demo-crypto";
import { isUniqueViolation } from "../lib/db-errors";
import {
	monthFolderName,
	officialTimesheetFileName,
	oldTimesheetFileName,
} from "../lib/timesheet-files";
import {
	buildTimesheetPdf,
	officialGeneratedTimesheetFileName,
	sanitizePdfText,
} from "../lib/timesheet-pdf";

const router: IRouter = Router();

const statusLabels: Record<string, string> = {
	reconhecida: "Reconhecida",
	arquivada: "Arquivada",
	revisao: "Revisão necessária",
	pendente: "Pendente",
	baixa_confianca: "Baixa confiança",
	rejeitada: "Rejeitada",
	ocr_indisponivel: "OCR indisponível",
};

function extractTextField(data: Record<string, unknown> | null | undefined, key: string): string {
	return safeString(data?.[key]);
}

/**
 * Cabeçalho `Content-Disposition` seguro para nomes com acentos.
 *
 * Node recusa caracteres fora de Latin-1 no header; por isso o `filename=`
 * leva uma versão ASCII e o `filename*` (RFC 5987) preserva o nome oficial.
 */
function contentDisposition(kind: "inline" | "attachment", filename: string): string {
	const ascii = filename.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9._-]+/g, "_") || "folha-de-ponto.pdf";
	return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function toApiTimesheet(row: {
	sheet: typeof timesheets.$inferSelect;
	employeeName: string | null;
	employeeMatricula: string | null;
}) {
	const extracted = row.sheet.extractedData;
	const archivedName = toArchiveKey(row.sheet.originalFilePath)?.split("/").pop() ?? null;
	return {
		id: row.sheet.reference,
		name: row.employeeName || extractTextField(extracted, "name") || "Não identificado",
		matricula: row.employeeMatricula || extractTextField(extracted, "matricula") || null,
		competencia: row.sheet.competency,
		confidence: row.sheet.confidence,
		status: row.sheet.status,
		status_label: row.sheet.statusLabel,
		reviewed_at: row.sheet.reviewedAt?.toISOString() ?? null,
		note: row.sheet.note,
		file_url: row.sheet.originalFilePath ? `/api/timesheets/${encodeURIComponent(row.sheet.reference)}/file` : null,
		file_name: archivedName,
		competency_source: extractTextField(extracted, "competencySource") || null,
		ocr_applied: extracted?.ocrApplied === true,
		ocr_unavailable: extracted?.ocrUnavailable === true,
	};
}

async function findTimesheet(reference: string) {
	const [row] = await db
		.select({
			sheet: timesheets,
			employeeName: employees.name,
			employeeMatricula: employees.matricula,
		})
		.from(timesheets)
		.leftJoin(employees, eq(timesheets.employeeId, employees.id))
		.where(eq(timesheets.reference, reference))
		.limit(1);
	return row;
}

router.get("/timesheets", async (req, res, next): Promise<void> => {
	try {
		const competency = safeString(req.query.competency);
		const status = safeString(req.query.status);
		const query = safeString(req.query.q);
		const digits = normalizeCpf(query);
		const hash = digits.length === 11 ? cpfHash(digits) : null;
		const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 200));
		const offset = Math.max(0, Number(req.query.offset) || 0);
		const filters = [];
		if (competency) filters.push(eq(timesheets.competency, competency));
		if (status) {
			if (status === "revisao") {
				filters.push(inArray(timesheets.status, ["revisao", "pendente", "baixa_confianca", "ocr_indisponivel"]));
			} else {
				filters.push(eq(timesheets.status, status as typeof timesheets.$inferSelect.status));
			}
		}
		if (query) {
			// CPF só deve filtrar por CPF exato (11 dígitos). Busca livre prioriza nome/matrícula.
			if (digits.length === 11 && hash) {
				filters.push(eq(employees.cpfSearchHash, hash));
			} else {
				filters.push(
					or(
						ilike(employees.name, `%${query}%`),
						ilike(employees.matricula, `%${query}%`),
					)!,
				);
			}
		}
		const whereClause = filters.length ? and(...filters) : undefined;
		const [countRow] = await db.select({ total: count() }).from(timesheets).leftJoin(employees, eq(timesheets.employeeId, employees.id)).where(whereClause);
		const rows = await db
			.select({
				sheet: timesheets,
				employeeName: employees.name,
				employeeMatricula: employees.matricula,
			})
			.from(timesheets)
			.leftJoin(employees, eq(timesheets.employeeId, employees.id))
			.where(whereClause)
			.orderBy(desc(timesheets.updatedAt))
			.limit(limit)
			.offset(offset);
		res.json({ items: rows.map(toApiTimesheet), total: Number(countRow?.total ?? 0), limit, offset });
	} catch (error) {
		next(error);
	}
});

router.get("/timesheets/missing", async (req, res, next): Promise<void> => {
	try {
		const competency = safeString(req.query.competency);
		if (!competency) {
			res.status(400).json({ message: "Informe a competência (AAAA-MM)." });
			return;
		}
		if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(competency)) {
			res.status(400).json({ message: "Competência inválida. Use o formato AAAA-MM." });
			return;
		}
		const query = safeString(req.query.q);
		const digits = normalizeCpf(query);
		const hash = digits.length === 11 ? cpfHash(digits) : null;
		const filters = [eq(employees.active, true)];
		if (query) {
			if (digits.length === 11 && hash) {
				filters.push(eq(employees.cpfSearchHash, hash));
			} else {
				filters.push(or(ilike(employees.name, `%${query}%`), ilike(employees.matricula, `%${query}%`))!);
			}
		}
		const rows = await db
			.select({
				employee: employees,
				sheetId: timesheets.id,
			})
			.from(employees)
			.leftJoin(timesheets, and(eq(timesheets.employeeId, employees.id), eq(timesheets.competency, competency)))
			.where(and(...filters))
			.orderBy(employees.name);
		const missing = rows
			.filter((row) => row.sheetId === null)
			.map((row) => ({
				id: row.employee.id,
				name: row.employee.name,
				matricula: row.employee.matricula,
				email: row.employee.email,
				cpf: row.employee.cpfLastDigits ? maskCpf(row.employee.cpfLastDigits) : "—",
				competency,
				status: "faltante",
			}));
		res.json({ competency, total: missing.length, items: missing });
	} catch (error) {
		next(error);
	}
});

// A rota literal precisa ser registrada ANTES de `/timesheets/:id`: o Express
// resolve na ordem de registro e, do contrário, "generate" seria lido como um
// identificador de folha e a geração do modelo DOCX responderia 404.
router.get("/timesheets/generate", handleGenerateTimesheet);

router.get("/timesheets/:id", async (req, res, next): Promise<void> => {
	try {
		const row = await findTimesheet(req.params.id);
		if (!row) {
			res.status(404).json({ message: "Folha não encontrada." });
			return;
		}
		res.json(toApiTimesheet(row));
	} catch (error) {
		next(error);
	}
});

router.patch("/timesheets/:id/review", async (req, res, next): Promise<void> => {
	try {
		const parsed = ReviewTimesheetBody.safeParse(req.body);
		if (!parsed.success) {
			res.status(400).json({ message: "Dados de revisão inválidos.", issues: parsed.error.issues });
			return;
		}
		const current = await findTimesheet(req.params.id);
		if (!current) {
			res.status(404).json({ message: "Folha não encontrada." });
			return;
		}
		const input = parsed.data;
		const now = new Date();
		let employeeId = current.sheet.employeeId;
		let personKey = current.sheet.personCompetencyKey;
		let employeeName = input.name?.trim() || current.employeeName || extractTextField(current.sheet.extractedData, "name");
		let matricula = input.matricula?.trim() || current.employeeMatricula || extractTextField(current.sheet.extractedData, "matricula");
		const competency = input.competency?.trim() || current.sheet.competency;
		if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(competency)) {
			res.status(400).json({ message: "Competência inválida. Use o formato AAAA-MM." });
			return;
		}

		if (input.action === "confirm") {
			if (!employeeName || !matricula) {
				res.status(400).json({ message: "Informe o nome e a matrícula antes de arquivar." });
				return;
			}
			const [registered] = await db.select().from(employees).where(eq(employees.matricula, matricula)).limit(1);
			let employee = registered;
			if (!employee) {
				[employee] = await db
					.insert(employees)
					.values({ name: employeeName, matricula, workloadHours: 40, active: true })
					.returning();
				await recordAudit("servidor_criado_por_revisao", "employee", String(employee.id), {
					name: employeeName,
					matricula,
				});
			} else if (!employee.active) {
				res.status(409).json({ message: "A matrícula pertence a um servidor desativado. Reative-o antes de arquivar." });
				return;
			}
			employeeId = employee.id;
			personKey = `employee:${employee.id}`;
			employeeName = employee.name;
			matricula = employee.matricula;
		}

		const status = input.action === "confirm" ? "arquivada" : input.action === "reject" ? "rejeitada" : "revisao";
		const label = statusLabels[status] ?? "Revisão necessária";

		/**
		 * Ao confirmar, o arquivo arquivado passa a usar a nomenclatura oficial
		 * (Nome_do_servidor-AAAA-MM.pdf) na pasta da competência corrigida. Sem
		 * isso a folha revisada continuaria com o nome/pasta da leitura
		 * automática, e o download mostraria um nome diferente do registro.
		 */
		const currentKey = toArchiveKey(current.sheet.originalFilePath);
		let renamedTo: string | null = null;
		if (input.action === "confirm" && currentKey) {
			const fileName = officialTimesheetFileName({ name: employeeName, competency, matricula });
			const targetKey = `${monthFolderName(competency)}/${fileName}`;
			if (targetKey !== currentKey) {
				const store = archiveStore();
				if (await store.exists(currentKey)) {
					// A convenção do sistema preserva a versão anterior como *_OLD_*.
					if (await store.exists(targetKey)) {
						await store.move(targetKey, oldTimesheetFileName(targetKey));
					}
					await store.move(currentKey, targetKey);
					renamedTo = targetKey;
				}
			}
		}

		const note =
			input.action === "reject"
				? input.note?.trim() || "Rejeitada durante revisão."
				: input.action === "pending"
					? input.note?.trim() || current.sheet.note
					: null;
		let updated: typeof timesheets.$inferSelect;
		try {
			[updated] = await db
				.update(timesheets)
				.set({
					employeeId,
					personCompetencyKey: personKey,
					competency,
					status,
					statusLabel: label,
					note,
					reviewedAt: now,
					originalFilePath: renamedTo ?? current.sheet.originalFilePath,
					extractedData: {
						...(current.sheet.extractedData ?? {}),
						name: employeeName,
						matricula,
					},
					updatedAt: now,
				})
				.where(eq(timesheets.id, current.sheet.id))
				.returning();
		} catch (error) {
			// O arquivo foi movido antes da gravação: desfaz para não deixar o
			// registro apontando para um caminho que não existe.
			if (renamedTo && currentKey) {
				await archiveStore()
					.move(renamedTo, currentKey)
					.catch(() => undefined);
			}
			throw error;
		}

		if (input.action === "confirm" && employeeId) {
			const [employee] = await db.select().from(employees).where(eq(employees.id, employeeId)).limit(1);
			if (employee?.accumulatesRole) {
				await db
					.insert(dispatches)
					.values({ timesheetId: updated.id, employeeId, status: "pendente", deliveryMode: "simulado" })
					.onConflictDoNothing({ target: dispatches.timesheetId });
			}
		}
		await recordAudit(`folha_${input.action === "confirm" ? "arquivada" : input.action}`, "timesheet", updated.id, {
			name: employeeName,
			matricula,
			competency,
			status,
		});
		const row = await findTimesheet(updated.reference);
		res.json(row ? toApiTimesheet(row) : toApiTimesheet({ sheet: updated, employeeName, employeeMatricula: matricula }));
	} catch (error) {
		if (isUniqueViolation(error)) {
			res.status(409).json({ message: "Já existe uma folha arquivada para esta matrícula e competência." });
			return;
		}
		next(error);
	}
});

router.get("/timesheets/:id/file", async (req, res, next): Promise<void> => {
	try {
		const [sheet] = await db.select().from(timesheets).where(eq(timesheets.reference, req.params.id)).limit(1);
		const archiveKey = toArchiveKey(sheet?.originalFilePath);
		if (!archiveKey) {
			res.status(404).json({ message: "Não foi possível localizar o PDF deste registro." });
			return;
		}
		// O arquivo vem do store (filesystem ou bucket S3-compatível) em vez de
		// um caminho local fixo; o bucket permanece privado, com o download
		// servido pela API.
		const file = await archiveStore().read(archiveKey);
		if (!file) {
			res.status(404).json({ message: "Não foi possível localizar o PDF deste registro." });
			return;
		}
		// Nome oficial (Nome_do_servidor-AAAA-MM.pdf) já é o basename da chave
		// do store; sem o header o navegador salvaria o id interno no lugar.
		const filename = (archiveKey.split(/[\\/]/).pop() ?? "folha-de-ponto.pdf").replace(/["\\]/g, "_");
		// Visualizar e baixar são ações diferentes: `inline` permite abrir o PDF
		// na própria aplicação; `?download=1` força o download com o nome oficial.
		const download = req.query.download === "1" || req.query.download === "true";
		res.setHeader("Content-Disposition", contentDisposition(download ? "attachment" : "inline", filename));
		res.setHeader("Cache-Control", "private, no-store");
		res.type("application/pdf").send(file);
	} catch (error) {
		next(error);
	}
});

async function handleGenerateTimesheet(req: Request, res: Response, next: NextFunction): Promise<void> {
	try {
		const employeeId = Number(req.query.employeeId);
		const competency = safeString(req.query.competency);
		if (!Number.isInteger(employeeId) || employeeId < 1 || !/^\d{4}-(0[1-9]|1[0-2])$/.test(competency)) {
			res.status(400).json({ message: "Selecione um servidor e uma competência no formato AAAA-MM." });
			return;
		}
		const [employee] = await db
			.select()
			.from(employees)
			.where(and(eq(employees.id, employeeId), eq(employees.active, true)))
			.limit(1);
		if (!employee) {
			res.status(404).json({ message: "Servidor não encontrado." });
			return;
		}
		const specialDates = (await db.select().from(calendarEvents))
			.filter((event) => event.date.startsWith(`${competency}-`))
			.map((event) => ({ date: event.date, description: event.description }));
		const file = await buildTimesheetPdf({
			employeeName: sanitizePdfText(employee.name),
			matricula: employee.matricula,
			competency,
			workloadHours: employee.workloadHours,
			specialDates,
		});
		const fileName = officialGeneratedTimesheetFileName({
			employeeName: employee.name,
			matricula: employee.matricula,
			competency,
		});
		res.setHeader("Content-Disposition", contentDisposition("inline", fileName));
		res.setHeader("Cache-Control", "private, no-store");
		res.type("application/pdf").send(file);
	} catch (error) {
		next(error);
	}
}

/**
 * Folhas faltantes por competência: servidores ativos sem folha arquivada para a competência.
 * LEFT JOIN entre employees (ativos) e timesheets por (employee_id, competency).
 */


export default router;
