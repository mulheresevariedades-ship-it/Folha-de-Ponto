import { and, eq, gte, lte, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import multer from "multer";
import * as XLSX from "xlsx";
import { CreateCalendarDateBody, UpdateCalendarDateBody } from "@workspace/api-zod";
import { calendarEvents, db } from "@workspace/db";
import { recordAudit } from "../lib/audit";
import { assertSpreadsheetUpload } from "../lib/file-validation";

const router: IRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });

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

function parseCalendarDate(value: unknown): string | null {
	if (typeof value === "number") {
		const parsed = XLSX.SSF.parse_date_code(value);
		if (!parsed || parsed.y < 1900 || parsed.y > 2200) return null;
		return `${parsed.y}-${String(parsed.m).padStart(2, "0")}-${String(parsed.d).padStart(2, "0")}`;
	}
	const text = cellText(value);
	let match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
	if (match) {
		const day = Number(match[1]);
		const month = Number(match[2]);
		const year = Number(match[3]);
		const candidate = new Date(Date.UTC(year, month - 1, day));
		if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) return null;
		return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
	}
	match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (match) {
		const year = Number(match[1]);
		const month = Number(match[2]);
		const day = Number(match[3]);
		const candidate = new Date(Date.UTC(year, month - 1, day));
		if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) return null;
		return text;
	}
	return null;
}

const eventTypes = ["feriado", "recesso", "ponto_facultativo", "suspensao_expediente", "outro"] as const;
type CalendarEventType = (typeof eventTypes)[number];
type CalendarRow = { date: string; description: string; type: CalendarEventType };

function inferEventType(description: string): CalendarEventType {
	const normalized = normalizeHeader(description);
	if (normalized.includes("feriado")) return "feriado";
	if (normalized.includes("recesso")) return "recesso";
	if (normalized.includes("facultativo")) return "ponto_facultativo";
	if (normalized.includes("suspensao") || normalized.includes("suspensaoexpediente")) return "suspensao_expediente";
	return "outro";
}

function parseCalendarSheet(buffer: Buffer): { rows: CalendarRow[]; skipped: number } {
	const workbook = XLSX.read(buffer, { type: "buffer", cellDates: false });
	const sheet = workbook.Sheets[workbook.SheetNames[0]];
	if (!sheet) throw new Error("A planilha não contém uma aba.");
	const data = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "", raw: false });
	const headers = (data[0] ?? []).map(normalizeHeader);
	const dateColumn = headers.indexOf("data");
	const descriptionColumn = headers.indexOf("especificacao");
	const typeColumn = headers.indexOf("tipo");
	if (dateColumn < 0 || descriptionColumn < 0) {
		throw new Error("Cabeçalhos inválidos. A planilha precisa conter as colunas Data e Especificação.");
	}
	const rows: CalendarRow[] = [];
	let skipped = 0;
	for (const row of data.slice(1)) {
		if (!row.some((cell) => cellText(cell))) continue;
		const date = parseCalendarDate(row[dateColumn]);
		const description = cellText(row[descriptionColumn]);
		const rawType = typeColumn >= 0 ? normalizeHeader(row[typeColumn]) : "";
		const typeMap: Record<string, CalendarEventType> = {
			feriado: "feriado",
			recesso: "recesso",
			pontofacultativo: "ponto_facultativo",
			suspensaodeexpediente: "suspensao_expediente",
			outro: "outro",
		};
		const type = typeMap[rawType] ?? inferEventType(description);
		if (!date || !description || !type) {
			skipped += 1;
			continue;
		}
		rows.push({ date, description, type });
	}
	return { rows, skipped };
}

async function buildPreview(buffer: Buffer) {
	const { rows, skipped: invalidRows } = parseCalendarSheet(buffer);
	const current = await db.select().from(calendarEvents);
	const currentByDate = new Map(current.map((event) => [event.date, event]));
	const seen = new Set<string>();
	const previewRows: Array<Record<string, string>> = [];
	let newCount = 0;
	let updatedCount = 0;
	let skippedCount = invalidRows;
	for (const row of rows) {
		if (seen.has(row.date)) {
			skippedCount += 1;
			previewRows.push({ date: row.date, description: row.description, action: "ignorar — data repetida na planilha" });
			continue;
		}
		seen.add(row.date);
		if (currentByDate.has(row.date)) {
			updatedCount += 1;
			previewRows.push({ ...row, action: "atualizar" });
		} else {
			newCount += 1;
			previewRows.push({ ...row, action: "novo" });
		}
	}
	if (invalidRows) previewRows.push({ date: "", description: "", type: "", action: `${invalidRows} linha(s) ignorada(s): data, tipo ou especificação inválida.` });
	return { newCount, updatedCount, skippedCount, rows: previewRows };
}

router.get("/calendar", async (req, res, next): Promise<void> => {
	try {
		const year = Number(req.query.year);
		const hasYear = req.query.year !== undefined;
		if (hasYear && (!Number.isInteger(year) || year < 1900 || year > 2200)) {
			res.status(400).json({ message: "Ano inválido." });
			return;
		}
		const results = hasYear
			? await db
					.select()
					.from(calendarEvents)
					.where(and(gte(calendarEvents.date, `${year}-01-01`), lte(calendarEvents.date, `${year}-12-31`)))
					.orderBy(calendarEvents.date)
			: await db.select().from(calendarEvents).orderBy(calendarEvents.date);
		res.json(results.map(({ id, date, description, type }) => ({ id, date, description, type })));
	} catch (error) {
		next(error);
	}
});

router.post("/calendar", async (req, res, next): Promise<void> => {
	try {
		const parsed = CreateCalendarDateBody.safeParse(req.body);
		if (!parsed.success) {
			res.status(400).json({ message: "Informe uma data e sua especificação.", issues: parsed.error.issues });
			return;
		}
		const [created] = await db
			.insert(calendarEvents)
			.values({
				date: parsed.data.date.toISOString().slice(0, 10),
				description: parsed.data.description,
				type: parsed.data.type,
			})
			.returning();
		await recordAudit("data_calendario_criada", "calendar", String(created.id), {
			date: created.date,
			description: created.description,
		});
		res.status(201).json({ id: created.id, date: created.date, description: created.description, type: created.type });
	} catch (error) {
		if (typeof error === "object" && error && "code" in error && error.code === "23505") {
			res.status(409).json({ message: "Já existe um evento cadastrado para essa data." });
			return;
		}
		next(error);
	}
});

router.patch("/calendar/:id", async (req, res, next): Promise<void> => {
	try {
		const id = Number(req.params.id);
		if (!Number.isInteger(id) || id < 1) {
			res.status(400).json({ message: "Identificador inválido." });
			return;
		}
		const parsed = UpdateCalendarDateBody.safeParse(req.body);
		if (!parsed.success) {
			res.status(400).json({ message: "Revise a data e sua especificação.", issues: parsed.error.issues });
			return;
		}
		const changes: { date?: string; description?: string; type?: CalendarEventType; updatedAt: Date } = { updatedAt: new Date() };
		if (parsed.data.date) changes.date = parsed.data.date.toISOString().slice(0, 10);
		if (parsed.data.description !== undefined) changes.description = parsed.data.description;
		if (parsed.data.type !== undefined) changes.type = parsed.data.type;
		const [updated] = await db
			.update(calendarEvents)
			.set(changes)
			.where(eq(calendarEvents.id, id))
			.returning();
		if (!updated) {
			res.status(404).json({ message: "Data especial não encontrada." });
			return;
		}
		await recordAudit("data_calendario_atualizada", "calendar", String(id), {
			date: updated.date,
			description: updated.description,
			type: updated.type,
		});
		res.json({ id: updated.id, date: updated.date, description: updated.description, type: updated.type });
	} catch (error) {
		if (typeof error === "object" && error && "code" in error && error.code === "23505") {
			res.status(409).json({ message: "Já existe um evento cadastrado para essa data." });
			return;
		}
		next(error);
	}
});

router.delete("/calendar/:id", async (req, res, next): Promise<void> => {
	try {
		const id = Number(req.params.id);
		if (!Number.isInteger(id) || id < 1) {
			res.status(400).json({ message: "Identificador inválido." });
			return;
		}
		const [removed] = await db.delete(calendarEvents).where(eq(calendarEvents.id, id)).returning();
		if (!removed) {
			res.status(404).json({ message: "Data especial não encontrada." });
			return;
		}
		await recordAudit("data_calendario_removida", "calendar", String(id), {
			date: removed.date,
			description: removed.description,
			type: removed.type,
		});
		res.status(204).end();
	} catch (error) {
		next(error);
	}
});

router.post("/calendar/import/preview", upload.single("file"), async (req, res): Promise<void> => {
	try {
		const file = assertSpreadsheetUpload(req.file);
		res.json(await buildPreview(file.buffer));
	} catch (error) {
		res.status(422).json({ message: error instanceof Error ? error.message : "Não foi possível validar o calendário." });
	}
});

router.post("/calendar/import", upload.single("file"), async (req, res, next): Promise<void> => {
	try {
		const file = assertSpreadsheetUpload(req.file);
		const { rows, skipped: invalidRows } = parseCalendarSheet(file.buffer);
		const existing = await db.select().from(calendarEvents);
		const existingByDate = new Map(existing.map((event) => [event.date, event]));
		const seen = new Set<string>();
		let imported = 0;
		let updated = 0;
		let skipped = invalidRows;
		await db.transaction(async (tx) => {
			for (const row of rows) {
				if (seen.has(row.date)) {
					skipped += 1;
					continue;
				}
				seen.add(row.date);
				if (existingByDate.has(row.date)) updated += 1;
				else imported += 1;
				await tx
					.insert(calendarEvents)
					.values(row)
					.onConflictDoUpdate({
						target: calendarEvents.date,
						set: { description: sql`excluded.description`, type: sql`excluded.type`, updatedAt: new Date() },
					});
			}
		});
		await recordAudit("calendario_importado", "calendar", "import", { imported, updated, skipped });
		req.log.info({ imported, updated, skipped }, "Academic calendar spreadsheet imported");
		res.json({ imported, updated, skipped });
	} catch (error) {
		next(error);
	}
});

export default router;
