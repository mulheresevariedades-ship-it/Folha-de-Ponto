import { and, desc, eq, gte, ilike, inArray, lte, or } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { SendDispatchBatchBody } from "@workspace/api-zod";
import { db, dispatches, employees, timesheets } from "@workspace/db";
import { recordAudit, safeString } from "../lib/audit";
import { cpfHash, maskCpf, normalizeCpf } from "../lib/demo-crypto";
import { resolveSmtpConfig } from "../lib/smtp-config";
import nodemailer from "nodemailer";
import path from "node:path";

const router: IRouter = Router();

async function joinedDispatch(id: number) {
	const [row] = await db
		.select({
			dispatch: dispatches,
			employeeName: employees.name,
			employeeMatricula: employees.matricula,
			employeeEmail: employees.email,
			employeeCpfLastDigits: employees.cpfLastDigits,
			timesheetPath: timesheets.originalFilePath,
			timesheetCompetency: timesheets.competency,
		})
		.from(dispatches)
		.innerJoin(employees, eq(dispatches.employeeId, employees.id))
		// A folha é lida junto porque o despacho precisa do arquivo anexado e da
		// competência. Sem este join a consulta falha ("table timesheets is not
		// part of the query") e todo envio termina em erro 500.
		.innerJoin(timesheets, eq(dispatches.timesheetId, timesheets.id))
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
		delivery_mode: row.dispatch.deliveryMode as "simulado" | "real",
		file_name: row.timesheetPath ? path.basename(row.timesheetPath) : null,
		competency: row.timesheetCompetency,
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
	const smtp = await resolveSmtpConfig();
	let status: "enviado" | "erro" = "erro";
	let deliveryMode: "simulado" | "real" = "simulado";
	let message = !emailIsValid
		? "E-mail ausente ou inválido. Nenhuma mensagem foi enviada."
		: !smtp.configured
			? "SMTP não configurado. Defina a configuração na tela Configurações ou as variáveis SMTP_HOST/SMTP_FROM/SMTP_PASSWORD."
			: !row.timesheetPath
				? "A folha ainda não possui PDF arquivado para anexar."
				: "";
	if (emailIsValid && smtp.configured && row.timesheetPath) {
		try {
			const transporter = nodemailer.createTransport({
				host: smtp.host,
				port: smtp.port,
				secure: smtp.secure,
				auth: smtp.username && smtp.password ? { user: smtp.username, pass: smtp.password } : undefined,
				connectionTimeout: 15_000,
			});
			await transporter.sendMail({
				from: smtp.senderEmail,
				to: row.employeeEmail!,
				subject: `Folha de ponto - ${row.employeeName} - ${row.timesheetCompetency}`,
				text: `Segue a folha de ponto de ${row.employeeName} referente a ${row.timesheetCompetency}.`,
				attachments: [{ filename: path.basename(row.timesheetPath), path: row.timesheetPath }],
			});
			status = "enviado";
			deliveryMode = "real";
			message = "E-mail enviado com sucesso.";
		} catch (error) {
			message = error instanceof Error ? `Falha no envio SMTP: ${error.message}` : "Falha no envio SMTP.";
		}
	}
	await db
		.update(dispatches)
		.set({
			status,
			errorMessage: status === "enviado" ? null : message,
			deliveryMode,
			authorizedAt: now,
			sentAt: status === "enviado" ? now : null,
			attemptCount: row.dispatch.attemptCount + 1,
			lastAttemptAt: now,
		})
		.where(eq(dispatches.id, id));
	await recordAudit(status === "enviado" ? "email_enviado" : "email_envio_falhou", "dispatch", String(id), {
		employeeId: row.dispatch.employeeId,
		name: row.employeeName,
		matricula: row.employeeMatricula,
		email: row.employeeEmail ?? "",
		cpfLastDigits: row.employeeCpfLastDigits ?? "",
		competency: row.timesheetCompetency,
		fileName: row.timesheetPath ? path.basename(row.timesheetPath) : "",
		smtpSource: smtp.source,
		status,
		deliveryMode,
		message,
	});
	const updated = await joinedDispatch(id);
	return { kind: status === "enviado" ? "sent" as const : "error" as const, dispatch: updated ? toApiDispatch(updated) : null, message };
}

router.get("/dispatches", async (req, res, next): Promise<void> => {
	try {
		const query = safeString(req.query.q);
		const status = safeString(req.query.status);
		const from = safeString(req.query.from);
		const to = safeString(req.query.to);
		const digits = normalizeCpf(query);
		const hash = digits.length === 11 ? cpfHash(digits) : null;
		const filters = [];
		if (status) filters.push(eq(dispatches.status, status as typeof dispatches.$inferSelect.status));
		const isoDate = /^\d{4}-\d{2}-\d{2}$/;
		if (from && isoDate.test(from)) filters.push(gte(dispatches.createdAt, new Date(`${from}T00:00:00.000Z`)));
		if (to && isoDate.test(to)) filters.push(lte(dispatches.createdAt, new Date(`${to}T23:59:59.999Z`)));
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
				timesheetPath: timesheets.originalFilePath,
				timesheetCompetency: timesheets.competency,
			})
			.from(dispatches)
			.innerJoin(employees, eq(dispatches.employeeId, employees.id))
			// Mesma folha do envio: sem ela o histórico nunca mostra o nome do
			// arquivo anexado nem a competência.
			.innerJoin(timesheets, eq(dispatches.timesheetId, timesheets.id))
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
			const result = await simulateDispatch(target.id, mode === "errors" || mode === "all" || mode === "selected");
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
