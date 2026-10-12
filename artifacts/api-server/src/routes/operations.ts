import { desc, eq, ilike, inArray, or } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { auditEvents, db, dispatches, employees, timesheets } from "@workspace/db";
import { safeString } from "../lib/audit";
import { cpfHash, maskCpf, normalizeCpf } from "../lib/demo-crypto";

const router: IRouter = Router();

function currentCompetency(): string {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

router.get("/dashboard", async (req, res, next): Promise<void> => {
	try {
		const competency = safeString(req.query.competency) || currentCompetency();
		const sheets = await db
			.select({ status: timesheets.status, confidence: timesheets.confidence })
			.from(timesheets)
			.where(eq(timesheets.competency, competency));
		const deliveryRows = await db
			.select({ status: dispatches.status })
			.from(dispatches)
			.innerJoin(timesheets, eq(dispatches.timesheetId, timesheets.id))
			.where(eq(timesheets.competency, competency));
		const total = sheets.length;
		const recognized = sheets.filter((sheet) => sheet.status === "reconhecida" || sheet.status === "arquivada").length;
		const review = sheets.filter((sheet) =>
			["revisao", "pendente", "baixa_confianca", "ocr_indisponivel"].includes(sheet.status),
		).length;
		const lowConfidence = sheets.filter((sheet) => sheet.confidence < 70).length;
		const archived = sheets.filter((sheet) => sheet.status === "arquivada").length;
		res.json({
			total,
			recognized,
			review,
			low_confidence: lowConfidence,
			archived,
			recognition_rate: total ? Math.round((recognized / total) * 100) : 0,
			dispatch_pending: deliveryRows.filter((row) => row.status === "pendente").length,
			dispatch_sent: deliveryRows.filter((row) => row.status === "enviado").length,
			dispatch_error: deliveryRows.filter((row) => row.status === "erro").length,
		});
	} catch (error) {
		next(error);
	}
});

router.get("/audit", async (req, res, next): Promise<void> => {
	try {
		const query = safeString(req.query.q);
		const digits = normalizeCpf(query);
		const cpfDigest = digits.length === 11 ? cpfHash(digits) : null;
		const matches = query
			? await db
					.select({ id: employees.id, name: employees.name, matricula: employees.matricula, cpfLastDigits: employees.cpfLastDigits })
					.from(employees)
					.where(
						or(
							ilike(employees.name, `%${query}%`),
							ilike(employees.matricula, `%${query}%`),
							digits.length > 0 ? ilike(employees.cpfLastDigits, `%${digits.slice(-2)}%`) : undefined,
							cpfDigest ? eq(employees.cpfSearchHash, cpfDigest) : undefined,
						),
					)
			: [];
		const employeeIds = matches.map((employee) => employee.id);
		const relatedSheets = employeeIds.length
			? await db.select({ id: timesheets.id }).from(timesheets).where(inArray(timesheets.employeeId, employeeIds))
			: [];
		const relatedDispatches = employeeIds.length
			? await db.select({ id: dispatches.id }).from(dispatches).where(inArray(dispatches.employeeId, employeeIds))
			: [];
		const searchableEntityIds = new Set([
			...employeeIds.map(String),
			...relatedSheets.map((row) => row.id),
			...relatedDispatches.map((row) => String(row.id)),
		]);
		const events = await db.select().from(auditEvents).orderBy(desc(auditEvents.createdAt)).limit(500);
		const lower = query.toLocaleLowerCase("pt-BR");
		const filtered = query
			? events.filter((event) => {
					const metadata = event.metadata ?? {};
					const fields = [
						event.action,
						event.entityType,
						event.entityId,
						String(metadata.name ?? ""),
						String(metadata.matricula ?? ""),
						String(metadata.competency ?? metadata.competencia ?? ""),
						String(metadata.status ?? ""),
					].join(" ").toLocaleLowerCase("pt-BR");
					return searchableEntityIds.has(event.entityId) || fields.includes(lower);
				})
			: events;
		res.json(
			filtered.slice(0, 200).map((event) => {
				const metadata = event.metadata ?? {};
				const matchingEmployee = matches.find((employee) => String(employee.id) === event.entityId);
				return {
					id: String(event.id),
					name: safeString(metadata.name) || matchingEmployee?.name || "",
					matricula: safeString(metadata.matricula) || matchingEmployee?.matricula || "",
					cpf: maskCpf(
						safeString(metadata.cpfLastDigits) ||
							matchingEmployee?.cpfLastDigits ||
							null,
					),
					action: event.action,
					status: safeString(metadata.status),
					competencia: safeString(metadata.competency ?? metadata.competencia),
					date: event.createdAt.toISOString(),
				};
			}),
		);
	} catch (error) {
		next(error);
	}
});

export default router;
