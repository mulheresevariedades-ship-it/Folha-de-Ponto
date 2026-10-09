import { randomUUID } from "node:crypto";
import { db, auditEvents } from "@workspace/db";

export async function recordAudit(
	action: string,
	entityType: string,
	entityId: string,
	metadata?: Record<string, unknown>,
): Promise<void> {
	await db.insert(auditEvents).values({
		action,
		entityType,
		entityId: entityId || randomUUID(),
		metadata,
	});
}

export function safeString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

export function normalizeSearch(value: string): string {
	return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR").trim();
}
