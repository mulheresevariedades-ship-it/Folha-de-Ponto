import { and, count, desc, eq, ilike, inArray, or } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { auditEvents, db, dispatches, employees, timesheets, users } from "@workspace/db";
import { safeString } from "../lib/audit";
import { cpfHash, maskCpf, normalizeCpf } from "../lib/demo-crypto";

const router: IRouter = Router();

/**
 * Competências com material arquivado.
 *
 * A navegação da interface não pode depender do mês corrente: o arquivo é
 * histórico e podem existir folhas de meses futuros (2027-01, por exemplo).
 * A lista vem do banco, em ordem decrescente, com a quantidade de folhas.
 */
router.get("/competencies", async (_req, res, next): Promise<void> => {
	try {
		const rows = await db
			.select({ competency: timesheets.competency, count: count() })
			.from(timesheets)
			.groupBy(timesheets.competency)
			.orderBy(desc(timesheets.competency));
		res.json(rows.map((row) => ({ competency: row.competency, count: Number(row.count) })));
	} catch (error) {
		next(error);
	}
});

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
		const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
		const offset = Math.max(0, Number(req.query.offset) || 0);
		const matches = query
			? await db
					.select({ id: employees.id, name: employees.name, matricula: employees.matricula, cpfLastDigits: employees.cpfLastDigits })
					.from(employees)
					.where(
						digits.length === 11 && cpfDigest
							? eq(employees.cpfSearchHash, cpfDigest)
							: or(
									ilike(employees.name, `%${query}%`),
									ilike(employees.matricula, `%${query}%`),
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
		const allEvents = await db.select().from(auditEvents).orderBy(desc(auditEvents.createdAt));
		const lower = query.toLocaleLowerCase("pt-BR");
		const filtered = query
			? allEvents.filter((event) => {
					const metadata = (event.metadata && typeof event.metadata === "object" ? event.metadata : {}) as Record<string, unknown>;
					const fields = [
						event.action,
						event.entityType,
						event.entityId,
						String(metadata.name ?? ""),
						String(metadata.matricula ?? ""),
						String(metadata.competency ?? metadata.competencia ?? ""),
						String(metadata.status ?? ""),
						String(metadata.email ?? ""),
					].join(" ").toLocaleLowerCase("pt-BR");
					return searchableEntityIds.has(event.entityId) || fields.includes(lower);
				})
			: allEvents;
		const items = filtered.slice(offset, offset + limit);
		const usersRows = await db.select({ id: users.id, name: users.name, email: users.email }).from(users);
		const userMap = new Map(usersRows.map((user) => [user.id, user]));
		res.json({
			items: items.map((event) => {
				const metadata = (event.metadata && typeof event.metadata === "object" ? event.metadata : {}) as Record<string, unknown>;
				const matchingEmployee = matches.find((employee) => String(employee.id) === event.entityId) || matches.find((employee) => event.userId !== null && String(employee.id) === String(event.userId));
				const actor = event.userId ? userMap.get(event.userId) : null;
				const cpfFromMeta = safeString(metadata.cpfLastDigits) || safeString(metadata.cpf);
				const cpfDigits = normalizeCpf(cpfFromMeta);
				return {
					id: String(event.id),
					action: event.action,
					entity_type: event.entityType,
					entity_id: event.entityId,
					created_at: event.createdAt.toISOString(),
					date: event.createdAt.toISOString(),
					actor_name: actor?.name ?? null,
					actor_email: actor?.email ?? null,
					cpf: cpfDigits.length === 11 ? maskCpf(cpfDigits) : cpfFromMeta ? maskCpf(cpfFromMeta) : (matchingEmployee?.cpfLastDigits ? maskCpf(matchingEmployee.cpfLastDigits) : "—"),
					name: safeString(metadata.name) || matchingEmployee?.name || actor?.name || "—",
					matricula: safeString(metadata.matricula) || matchingEmployee?.matricula || "—",
					email: safeString(metadata.email) || actor?.email || null,
					file_name: safeString(metadata.fileName) || safeString(metadata.filename) || null,
					delivery_mode: safeString(metadata.deliveryMode) || null,
					smtp_source: safeString(metadata.smtpSource) || null,
					message: safeString(metadata.message) || null,
					competencia: safeString(metadata.competency ?? metadata.competencia) || null,
					status: safeString(metadata.status) || null,
				};
			}),
			total: filtered.length,
			limit,
			offset,
		});
	} catch (error) {
		next(error);
	}
});

export default router;
