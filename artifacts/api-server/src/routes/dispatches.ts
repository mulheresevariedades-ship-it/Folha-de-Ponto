import { and, desc, eq, ilike, inArray, or } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { SendDispatchBatchBody } from "@workspace/api-zod";
import { db, dispatches, employees, timesheets } from "@workspace/db";
import { recordAudit, safeString } from "../lib/audit";
import { cpfHash, maskCpf, normalizeCpf } from "../lib/demo-crypto";

const router: IRouter = Router();

async function joinedDispatch(id: number) {
	const [row] = await db
		.select({
			dispatch: dispatches,
			employeeName: employees.name,
			employeeMatricula: employees.matricula,
			employeeEmail: employees.email,
			employeeCpfLastDigits: employees.cpfLastDigits,
		})
		.from(dispatches)
		.innerJoin(employees, eq(dispatches.employeeId, employees.id))
		.where(eq(dispatches.id, id))
		.limit(1);
	return row;
}

function toApiDispatch(row: NonNullable<Awaited<ReturnType<typeof joinedDispatch>>>) {
	return {
		id: row.dispatch.id,
		employee_name: row.employeeName,
		employee_matricula: row.employeeMatricula,
		employee_email: row.employeeEmail ?? "",
		employee_cpf: maskCpf(row.employeeCpfLastDigits),
		status: row.dispatch.status,
		created_at: row.dispatch.createdAt.toISOString(),
		authorized_at: row.dispatch.authorizedAt?.toISOString() ?? null,
		sent_at: row.dispatch.sentAt?.toISOString() ?? null,
		error_message: row.dispatch.errorMessage,
		delivery_mode: "simulado" as const,
	};
}

async function simulateDispatch(id: number, allowRetry: boolean) {
	const row = await joinedDispatch(id);
	if (!row) return { kind: "missing" as const };
	if (row.dispatch.status === "enviado") return { kind: "already-sent" as const, dispatch: toApiDispatch(row) };
	if (!allowRetry && row.dispatch.status !== "pendente") {
		return { kind: "not-pending" as const, dispatch: toApiDispatch(row) };
	}
	if (allowRetry && row.dispatch.status !== "erro") {
		return { kind: "not-error" as const, dispatch: toApiDispatch(row) };
	}

	const now = new Date();
	const emailIsValid = Boolean(row.employeeEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.employeeEmail));
	const status = emailIsValid ? "enviado" : "erro";
	const message = emailIsValid
		? "Envio simulado: nenhum e-mail real foi enviado."
		: "E-mail ausente ou inválido. Nenhuma mensagem foi enviada.";
	await db
		.update(dispatches)
		.set({
			status,
			errorMessage: emailIsValid ? message : "E-mail ausente ou inválido.",
			deliveryMode: "simulado",
			authorizedAt: now,
			sentAt: emailIsValid ? now : null,
			attemptCount: row.dispatch.attemptCount + 1,
			lastAttemptAt: now,
		})
		.where(eq(dispatches.id, id));
	await recordAudit(emailIsValid ? "email_enviado_simulado" : "email_envio_falhou", "dispatch", String(id), {
		employeeId: row.dispatch.employeeId,
		name: row.employeeName,
		matricula: row.employeeMatricula,
		competency: "",
		status,
		deliveryMode: "simulado",
		message,
	});
	const updated = await joinedDispatch(id);
	return { kind: status === "enviado" ? "sent" as const : "error" as const, dispatch: updated ? toApiDispatch(updated) : null, message };
}

router.get("/dispatches", async (req, res, next): Promise<void> => {
	try {
		const query = safeString(req.query.q);
		const status = safeString(req.query.status);
		const digits = normalizeCpf(query);
		const hash = digits.length === 11 ? cpfHash(digits) : null;
		const filters = [];
		if (status) filters.push(eq(dispatches.status, status as typeof dispatches.$inferSelect.status));
		if (query) {
			filters.push(
				or(
					ilike(employees.name, `%${query}%`),
					ilike(employees.matricula, `%${query}%`),
					ilike(employees.email, `%${query}%`),
					digits.length ? ilike(employees.cpfLastDigits, `%${digits.slice(-2)}%`) : undefined,
					hash ? eq(employees.cpfSearchHash, hash) : undefined,
				)!,
			);
		}
		const rows = await db
			.select({
				dispatch: dispatches,
				employeeName: employees.name,
				employeeMatricula: employees.matricula,
				employeeEmail: employees.email,
				employeeCpfLastDigits: employees.cpfLastDigits,
			})
			.from(dispatches)
			.innerJoin(employees, eq(dispatches.employeeId, employees.id))
			.where(filters.length ? and(...filters) : undefined)
			.orderBy(desc(dispatches.createdAt))
			.limit(500);
		res.json(rows.map(toApiDispatch));
	} catch (error) {
		next(error);
	}
});

router.patch("/dispatches/:id/send", async (req, res, next): Promise<void> => {
	try {
		const id = Number(req.params.id);
		if (!Number.isInteger(id) || id < 1) {
			res.status(400).json({ message: "Identificador inválido." });
			return;
		}
		const result = await simulateDispatch(id, false);
		if (result.kind === "missing") {
			res.status(404).json({ message: "Registro de envio não encontrado." });
			return;
		}
		if (result.kind === "already-sent" || result.kind === "not-pending") {
			res.status(409).json({ message: "Somente envios pendentes podem ser enviados. Use a opção de nova tentativa para erros." });
			return;
		}
		if (!result.dispatch) {
			res.status(500).json({ message: "Não foi possível atualizar o registro de envio." });
			return;
		}
		res.json(result.dispatch);
	} catch (error) {
		next(error);
	}
});

router.patch("/dispatches/:id/resend", async (req, res, next): Promise<void> => {
	try {
		const id = Number(req.params.id);
		if (!Number.isInteger(id) || id < 1) {
			res.status(400).json({ message: "Identificador inválido." });
			return;
		}
		const result = await simulateDispatch(id, true);
		if (result.kind === "missing") {
			res.status(404).json({ message: "Registro de envio não encontrado." });
			return;
		}
		if (result.kind === "already-sent" || result.kind === "not-error") {
			res.status(409).json({ message: "Nova tentativa disponível apenas para envios com erro." });
			return;
		}
		if (!result.dispatch) {
			res.status(500).json({ message: "Não foi possível atualizar o registro de envio." });
			return;
		}
		res.json(result.dispatch);
	} catch (error) {
		next(error);
	}
});

router.post("/dispatches/send-batch", async (req, res, next): Promise<void> => {
	try {
		const parsed = SendDispatchBatchBody.safeParse(req.body);
		if (!parsed.success) {
			res.status(400).json({ message: "Informe o grupo de envios.", issues: parsed.error.issues });
			return;
		}
		const { mode, ids = [] } = parsed.data;
		if (mode === "selected" && !ids.length) {
			res.status(400).json({ message: "Selecione pelo menos um registro." });
			return;
		}
		const statusFilter =
			mode === "pending" ? eq(dispatches.status, "pendente") :
				mode === "errors" ? eq(dispatches.status, "erro") :
					inArray(dispatches.status, ["pendente", "erro"]);
		const targets =
			mode === "selected"
				? await db
						.select({ id: dispatches.id })
						.from(dispatches)
						.where(and(inArray(dispatches.id, ids), inArray(dispatches.status, ["pendente", "erro"])))
				: await db.select({ id: dispatches.id }).from(dispatches).where(statusFilter);
		const results: Array<{ id: number; status: string; message: string }> = [];
		for (const target of targets) {
			const result = await simulateDispatch(target.id, false);
			if (result.kind === "sent" || result.kind === "error") {
				results.push({ id: target.id, status: result.kind === "sent" ? "enviado" : "erro", message: result.message });
			}
		}
		res.json({ processed: results.length, results });
	} catch (error) {
		next(error);
	}
});

export default router;
