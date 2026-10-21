import { eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { UpdateSmtpSettingsBody } from "@workspace/api-zod";
import { db, smtpSettings } from "@workspace/db";
import { recordAudit } from "../lib/audit";
import { encryptSecret } from "../lib/demo-crypto";
import { resolveSmtpConfig, type EffectiveSmtpConfig } from "../lib/smtp-config";
import nodemailer from "nodemailer";

const router: IRouter = Router();

function publicSettings(config: EffectiveSmtpConfig) {
	return {
		host: config.host,
		port: config.port,
		username: config.username,
		senderEmail: config.senderEmail,
		secure: config.secure,
		passwordSet: config.passwordSet,
		demoOnly: false,
		source: config.source,
	};
}

router.get("/settings/smtp", async (_req, res, next): Promise<void> => {
	try {
		res.json(publicSettings(await resolveSmtpConfig()));
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
		res.json(publicSettings(await resolveSmtpConfig()));
	} catch (error) {
		next(error);
	}
});

router.post("/settings/smtp/test", async (_req, res, next): Promise<void> => {
	let testedHost = "";
	let testedSource = "";
	try {
		const config = await resolveSmtpConfig();
		testedHost = config.host;
		testedSource = config.source;
		if (!config.configured) {
			const missing = [
				!config.host ? "servidor" : "",
				!config.senderEmail ? "remetente" : "",
				config.username && !config.password ? "credencial" : "",
			].filter(Boolean);
			res.json({
				valid: false,
				message: `Preencha a configuração SMTP${missing.length ? ` (${missing.join(", ")})` : ""} ou defina SMTP_HOST/SMTP_FROM/SMTP_PASSWORD.`,
				demoOnly: false,
			});
			return;
		}
		const transporter = nodemailer.createTransport({
			host: config.host,
			port: config.port,
			secure: config.secure,
			auth: config.username && config.password ? { user: config.username, pass: config.password } : undefined,
			connectionTimeout: 10_000,
		});
		await transporter.verify();
		const message = "Conexão SMTP validada com sucesso.";
		await recordAudit("configuracao_smtp_validada", "settings", "smtp", {
			valid: true,
			source: config.source,
			host: config.host,
		});
		res.json({ valid: true, message, demoOnly: false });
	} catch (error) {
		// Falha de conexão (host inexistente, porta fechada, credencial recusada)
		// é um resultado da validação, não um erro do servidor: devolve 200 com
		// `valid: false` e a mensagem real, em vez de um HTML de stack trace.
		const reason = error instanceof Error ? error.message : "erro desconhecido";
		const message = `Não foi possível conectar ao servidor SMTP: ${reason}`;
		await recordAudit("configuracao_smtp_rejeitada", "settings", "smtp", {
			valid: false,
			source: testedSource,
			host: testedHost,
			reason,
		});
		res.json({ valid: false, message, demoOnly: false });
	}
});

export default router;
