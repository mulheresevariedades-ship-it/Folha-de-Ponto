import { eq } from "drizzle-orm";
import { db, smtpSettings } from "@workspace/db";
import { decryptSecret } from "./demo-crypto";

export type SmtpSource = "database" | "environment" | "none";

export type EffectiveSmtpConfig = {
	host: string;
	port: number;
	username: string;
	senderEmail: string;
	secure: boolean;
	password: string | null;
	passwordSet: boolean;
	source: SmtpSource;
	configured: boolean;
};

function clean(value: string | undefined): string {
	return value?.trim() ?? "";
}

function parsePort(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : fallback;
}

function parseBoolean(value: string | undefined): boolean {
	return ["1", "true", "sim", "yes", "ssl", "tls"].includes(clean(value).toLocaleLowerCase("pt-BR"));
}

function isComplete(config: Omit<EffectiveSmtpConfig, "configured" | "source">): boolean {
	if (!config.host || !config.senderEmail) return false;
	// An authenticated server needs a credential; anonymous relays do not.
	return config.username ? Boolean(config.password) : true;
}

function environmentConfig(): EffectiveSmtpConfig | null {
	const host = clean(process.env.SMTP_HOST);
	const senderEmail = clean(process.env.SMTP_FROM ?? process.env.SMTP_SENDER_EMAIL);
	if (!host && !senderEmail) return null;
	const username = clean(process.env.SMTP_USER ?? process.env.SMTP_USERNAME);
	const password = clean(process.env.SMTP_PASSWORD ?? process.env.SMTP_APP_PASSWORD) || null;
	const base = {
		host,
		port: parsePort(process.env.SMTP_PORT, 587),
		username,
		senderEmail,
		secure: parseBoolean(process.env.SMTP_SECURE),
		password,
		passwordSet: Boolean(password),
	};
	return { ...base, source: "environment", configured: isComplete(base) };
}

/**
 * Resolution order:
 * 1. complete settings saved by the SMTP screen (encrypted in the database);
 * 2. complete SMTP_* environment variables (portable/shared deployments);
 * 3. a partially filled database record, so the screen can show what is missing.
 * Secrets are never read from source code.
 */
export async function resolveSmtpConfig(): Promise<EffectiveSmtpConfig> {
	const [row] = await db.select().from(smtpSettings).where(eq(smtpSettings.id, 1)).limit(1);
	let database: EffectiveSmtpConfig | null = null;
	if (row && (row.host || row.senderEmail)) {
		let password: string | null = null;
		try {
			password = decryptSecret(row.passwordEncrypted);
		} catch {
			// A missing/changed SESSION_SECRET must not crash the settings screen.
			password = null;
		}
		const base = {
			host: row.host,
			port: row.port,
			username: row.username,
			senderEmail: row.senderEmail,
			secure: row.secure,
			password,
			passwordSet: Boolean(password),
		};
		database = { ...base, source: "database", configured: isComplete(base) };
	}
	if (database?.configured) return database;
	const environment = environmentConfig();
	if (environment?.configured) return environment;
	if (database) return database;
	if (environment) return environment;
	return {
		host: "",
		port: 587,
		username: "",
		senderEmail: "",
		secure: false,
		password: null,
		passwordSet: false,
		source: "none",
		configured: false,
	};
}
