import { and, desc, eq, ilike, or } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
	AlignmentType,
	Document,
	HeadingLevel,
	Packer,
	Paragraph,
	Table,
	TableCell,
	TableRow,
	TextRun,
	WidthType,
} from "docx";
import { ReviewTimesheetBody } from "@workspace/api-zod";
import { calendarEvents, db, dispatches, employees, timesheets } from "@workspace/db";
import { recordAudit, safeString } from "../lib/audit";
import { archiveStore, toArchiveKey } from "../lib/archive-store";
import { cpfHash, maskCpf, normalizeCpf } from "../lib/demo-crypto";

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

function toApiTimesheet(row: {
	sheet: typeof timesheets.$inferSelect;
	employeeName: string | null;
	employeeMatricula: string | null;
}) {
	const extracted = row.sheet.extractedData;
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
		const filters = [];
		if (competency) filters.push(eq(timesheets.competency, competency));
		if (status) filters.push(eq(timesheets.status, status as typeof timesheets.$inferSelect.status));
		if (query) {
			filters.push(
				or(
					ilike(employees.name, `%${query}%`),
					ilike(employees.matricula, `%${query}%`),
					digits.length > 0 ? ilike(employees.cpfLastDigits, `%${digits.slice(-2)}%`) : undefined,
					hash ? eq(employees.cpfSearchHash, hash) : undefined,
				)!,
			);
		}
		const rows = await db
			.select({
				sheet: timesheets,
				employeeName: employees.name,
				employeeMatricula: employees.matricula,
			})
			.from(timesheets)
			.leftJoin(employees, eq(timesheets.employeeId, employees.id))
			.where(filters.length ? and(...filters) : undefined)
			.orderBy(desc(timesheets.updatedAt))
			.limit(500);
		res.json(rows.map(toApiTimesheet));
	} catch (error) {
		next(error);
	}
});

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
		const note =
			input.action === "reject"
				? input.note?.trim() || "Rejeitada durante revisão."
				: input.action === "pending"
					? input.note?.trim() || current.sheet.note
					: null;
		const [updated] = await db
			.update(timesheets)
			.set({
				employeeId,
				personCompetencyKey: personKey,
				competency,
				status,
				statusLabel: label,
				note,
				reviewedAt: now,
				extractedData: {
					...(current.sheet.extractedData ?? {}),
					name: employeeName,
					matricula,
				},
				updatedAt: now,
			})
			.where(eq(timesheets.id, current.sheet.id))
			.returning();

		if (input.action === "confirm" && employeeId) {
			const [employee] = await db.select().from(employees).where(eq(employees.id, employeeId)).limit(1);
			if (employee?.accumulatesRole) {
				await db
					.insert(dispatches)
					.values({ timesheetId: updated.id, employeeId, status: "pendente", deliveryMode: "simulado" })
					.onConflictDoNothing();
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
		if (typeof error === "object" && error && "code" in error && error.code === "23505") {
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
			res.status(404).json({ message: "Arquivo não encontrado." });
			return;
		}
		// O arquivo vem do store (filesystem ou bucket S3-compatível) em vez de
		// um caminho local fixo; o bucket permanece privado, com o download
		// servido pela API.
		const file = await archiveStore().read(archiveKey);
		if (!file) {
			res.status(404).json({ message: "Arquivo não encontrado." });
			return;
		}
		// Nome oficial (Nome_do_servidor-AAAA-MM.pdf) já é o basename da chave
		// do store; sem o header o navegador salvaria o id interno no lugar.
		const filename = (archiveKey.split(/[\\/]/).pop() ?? "folha-de-ponto.pdf").replace(/["\\]/g, "_");
		res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
		res.type("application/pdf").send(file);
	} catch (error) {
		next(error);
	}
});

router.get("/timesheets/generate", async (req, res, next): Promise<void> => {
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
		const [yearText, monthText] = competency.split("-");
		const year = Number(yearText);
		const month = Number(monthText);
		const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
		const allSpecials = await db.select().from(calendarEvents);
		const specialByDay = new Map(
			allSpecials
				.filter((event) => event.date.startsWith(`${competency}-`))
				.map((event) => [event.date, event.description]),
		);
		const monthName = new Intl.DateTimeFormat("pt-BR", { month: "long", timeZone: "UTC" }).format(
			new Date(Date.UTC(year, month - 1, 1)),
		);
		const headerCells = ["Dia", "Entrada", "Saída", "Entrada", "Saída", "Observação"].map(
			(text) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text, bold: true })] })] }),
		);
		const rows = [new TableRow({ children: headerCells })];
		for (let day = 1; day <= daysInMonth; day += 1) {
			const date = `${competency}-${String(day).padStart(2, "0")}`;
			const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
			const observation =
				specialByDay.get(date) ??
				(weekday === 0 ? "Domingo" : weekday === 6 ? "Sábado" : "");
			rows.push(
				new TableRow({
					children: [
						String(day).padStart(2, "0"),
						"",
						"",
						"",
						"",
						observation,
					].map((text) => new TableCell({ children: [new Paragraph(text)] })),
				}),
			);
		}
		const document = new Document({
			sections: [
				{
					properties: { page: { margin: { top: 720, right: 720, bottom: 720, left: 720 } } },
					children: [
						new Paragraph({
							heading: HeadingLevel.TITLE,
							alignment: AlignmentType.CENTER,
							children: [new TextRun({ text: "REGISTRO DE FREQUÊNCIA", bold: true })],
						}),
						new Paragraph({
							alignment: AlignmentType.CENTER,
							children: [new TextRun({ text: `Competência: ${monthName} de ${year}` })],
						}),
						new Paragraph({
							spacing: { before: 240, after: 100 },
							children: [
								new TextRun({ text: "Servidor(a): ", bold: true }),
								new TextRun(employee.name),
							],
						}),
						new Paragraph({
							spacing: { after: 100 },
							children: [
								new TextRun({ text: "Matrícula: ", bold: true }),
								new TextRun(employee.matricula),
								new TextRun({ text: "    Carga horária: ", bold: true }),
								new TextRun(`${employee.workloadHours} horas`),
							],
						}),
						new Paragraph({
							spacing: { after: 120 },
							children: [new TextRun({ text: "Preencha os horários de entrada e saída em cada dia útil." })],
						}),
						new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }),
						new Paragraph({
							spacing: { before: 600 },
							alignment: AlignmentType.CENTER,
							children: [new TextRun("________________________________________")],
						}),
						new Paragraph({
							alignment: AlignmentType.CENTER,
							children: [new TextRun(`Assinatura do(a) servidor(a) — ${employee.name}`)],
						}),
					],
				},
			],
		});
		const file = await Packer.toBuffer(document);
		const safeName = employee.name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9-]+/g, "-");
		res.setHeader(
			"Content-Disposition",
			`attachment; filename="${safeName}-${competency}.docx"`,
		);
		res.type("application/vnd.openxmlformats-officedocument.wordprocessingml.document").send(file);
	} catch (error) {
		next(error);
	}
});

export default router;
