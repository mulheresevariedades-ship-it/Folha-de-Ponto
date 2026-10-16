import { eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { UpdateSmtpSettingsBody } from "@workspace/api-zod";
import { db, smtpSettings } from "@workspace/db";
import { recordAudit } from "../lib/audit";
import { decryptSecret, encryptSecret } from "../lib/demo-crypto";
import nodemailer from "nodemailer";

const router: IRouter = Router();

function safeSettings(row?: typeof smtpSettings.$inferSelect) {
	return {
		host: row?.host ?? "",
		port: row?.port ?? 587,
		username: row?.username ?? "",
		senderEmail: row?.senderEmail ?? "",
		secure: row?.secure ?? false,
		passwordSet: Boolean(row?.passwordEncrypted),
		demoOnly: false,
	};
}

router.get("/settings/smtp", async (_req, res, next): Promise<void> => {
	try {
		const [row] = await db.select().from(smtpSettings).where(eq(smtpSettings.id, 1)).limit(1);
		res.json(safeSettings(row));
	} catch (error) {
		next(error);
	}
});

router.put("/settings/smtp", async (req, res, next): Promise<void> => {
	try {
		const parsed = UpdateSmtpSettingsBody.safeParse(req.body);
		if (!parsed.success) {
			res.status(400).json({ message: "Revise os dados SMTP.", issues: parsed.error.issues });
			return;
		}
		const input = parsed.data;
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.senderEmail)) {
			res.status(400).json({ message: "Informe um e-mail remetente válido." });
			return;
		}
		if (input.username && input.username.length > 320) {
			res.status(400).json({ message: "Usuário SMTP inválido." });
			return;
		}
		const [current] = await db.select().from(smtpSettings).where(eq(smtpSettings.id, 1)).limit(1);
		const [updated] = await db
			.insert(smtpSettings)
			.values({
				id: 1,
				host: input.host.trim(),
				port: input.port,
				username: input.username?.trim() ?? "",
				senderEmail: input.senderEmail.trim(),
				secure: input.secure,
				passwordEncrypted: input.appPassword ? encryptSecret(input.appPassword) : (current?.passwordEncrypted ?? null),
				updatedAt: new Date(),
			})
			.onConflictDoUpdate({
				target: smtpSettings.id,
				set: {
					host: input.host.trim(),
					port: input.port,
					username: input.username?.trim() ?? "",
					senderEmail: input.senderEmail.trim(),
					secure: input.secure,
					passwordEncrypted: input.appPassword ? encryptSecret(input.appPassword) : (current?.passwordEncrypted ?? null),
					updatedAt: new Date(),
				},
			})
			.returning();
		await recordAudit("configuracao_smtp_salva", "settings", "smtp", {
			host: updated.host,
			senderEmail: updated.senderEmail,
		});
		res.json(safeSettings(updated));
	} catch (error) {
		next(error);
	}
});

router.post("/settings/smtp/test", async (_req, res, next): Promise<void> => {
	try {
		const [row] = await db.select().from(smtpSettings).where(eq(smtpSettings.id, 1)).limit(1);
		const valid = Boolean(row?.host && row?.port && row?.senderEmail && row?.passwordEncrypted);
		if (!valid) {
			res.json({ valid: false, message: "Preencha host, porta, remetente e credencial SMTP.", demoOnly: false });
			return;
		}
		const password = decryptSecret(row.passwordEncrypted);
		const transporter = nodemailer.createTransport({
			host: row.host,
			port: row.port,
			secure: row.secure,
			auth: row.username && password ? { user: row.username, pass: password } : undefined,
			connectionTimeout: 10_000,
		});
		await transporter.verify();
		const message = "Conexão SMTP validada com sucesso.";
		await recordAudit("configuracao_smtp_validada_localmente", "settings", "smtp", { valid });
		res.json({ valid: true, message, demoOnly: false });
	} catch (error) {
		next(error);
	}
});

export default router;
