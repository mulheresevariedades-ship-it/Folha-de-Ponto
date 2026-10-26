import { createInsertSchema } from "drizzle-zod";
import { relations, sql } from "drizzle-orm";
import {
	boolean,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	serial,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";
export * from "./calendar";
export * from "./operation-locks";
export * from "./smtp-settings";

export const userRole = pgEnum("user_role", ["admin", "operador", "consulta"]);
export const timesheetStatus = pgEnum("timesheet_status", [
	"reconhecida",
	"arquivada",
	"revisao",
	"pendente",
	"baixa_confianca",
	"rejeitada",
	"ocr_indisponivel",
]);
export const dispatchStatus = pgEnum("dispatch_status", ["pendente", "enviado", "erro"]);

export const users = pgTable("users", {
	id: uuid("id").defaultRandom().primaryKey(),
	name: text("name").notNull(),
	email: text("email").notNull().unique(),
	passwordHash: text("password_hash").notNull(),
	role: userRole("role").notNull().default("consulta"),
	active: boolean("active").notNull().default(true),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const employees = pgTable("employees", {
	id: serial("id").primaryKey(),
	name: text("name").notNull(),
	matricula: text("matricula").notNull().unique(),
	cpfEncrypted: text("cpf_encrypted"),
	cpfLastDigits: text("cpf_last_digits"),
	cpfSearchHash: text("cpf_search_hash"),
	email: text("email"),
	cargo: text("cargo").notNull().default(""),
	workloadHours: integer("workload_hours").notNull().default(40),
	accumulatesRole: boolean("accumulates_role").notNull().default(false),
	active: boolean("active").notNull().default(true),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const batches = pgTable("batches", {
	id: uuid("id").defaultRandom().primaryKey(),
	originalFilename: text("original_filename").notNull(),
	storagePath: text("storage_path").notNull(),
	fileHash: text("file_hash").notNull().unique(),
	mimeType: text("mime_type").notNull(),
	pageCount: integer("page_count").notNull().default(1),
	uploadedBy: uuid("uploaded_by").references(() => users.id),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const timesheets = pgTable(
	"timesheets",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		reference: text("reference").notNull().unique(),
		employeeId: integer("employee_id").references(() => employees.id),
		batchId: uuid("batch_id").references(() => batches.id),
		competency: text("competency").notNull(),
		confidence: integer("confidence").notNull().default(0),
		status: timesheetStatus("status").notNull().default("pendente"),
		statusLabel: text("status_label").notNull().default("Pendente"),
		note: text("note"),
		extractedData: jsonb("extracted_data").$type<Record<string, unknown>>(),
		originalFilePath: text("original_file_path"),
		personCompetencyKey: text("person_competency_key"),
		// Identidade estável da página: hash do PDF de origem + número da página.
		// Não muda quando o arquivo é renomeado, reenviado ou revisado.
		sourceFingerprint: text("source_fingerprint"),
		reviewedBy: uuid("reviewed_by").references(() => users.id),
		reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => ({
		employeeCompetencyUnique: uniqueIndex("timesheets_employee_competency_unique").on(
			table.employeeId,
			table.competency,
		),
		personCompetencyUnique: uniqueIndex("timesheets_person_competency_unique").on(
			table.personCompetencyKey,
			table.competency,
		),
		sourceFingerprintUnique: uniqueIndex("timesheets_source_fingerprint_unique")
			.on(table.sourceFingerprint)
			.where(sql`${table.sourceFingerprint} is not null`),
	}),
);

export const dispatches = pgTable("dispatches", {
	id: serial("id").primaryKey(),
	timesheetId: uuid("timesheet_id").notNull().references(() => timesheets.id),
	employeeId: integer("employee_id").notNull().references(() => employees.id),
	status: dispatchStatus("status").notNull().default("pendente"),
	errorMessage: text("error_message"),
	deliveryMode: text("delivery_mode").notNull().default("simulado"),
	attemptCount: integer("attempt_count").notNull().default(0),
	lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
	authorizedBy: uuid("authorized_by").references(() => users.id),
	authorizedAt: timestamp("authorized_at", { withTimezone: true }),
	sentAt: timestamp("sent_at", { withTimezone: true }),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
	// Um despacho por folha: o histórico é atualizado em vez de duplicado.
	timesheetUnique: uniqueIndex("dispatches_timesheet_unique").on(table.timesheetId),
}));

export const auditEvents = pgTable("audit_events", {
	id: serial("id").primaryKey(),
	userId: uuid("user_id").references(() => users.id),
	entityType: text("entity_type").notNull(),
	entityId: text("entity_id").notNull(),
	action: text("action").notNull(),
	metadata: jsonb("metadata").$type<Record<string, unknown>>(),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const employeeRelations = relations(employees, ({ many }) => ({
	timesheets: many(timesheets),
	dispatches: many(dispatches),
}));

export const timesheetRelations = relations(timesheets, ({ one, many }) => ({
	employee: one(employees, { fields: [timesheets.employeeId], references: [employees.id] }),
	batch: one(batches, { fields: [timesheets.batchId], references: [batches.id] }),
	dispatches: many(dispatches),
}));

export const batchRelations = relations(batches, ({ many }) => ({ timesheets: many(timesheets) }));
export const dispatchRelations = relations(dispatches, ({ one }) => ({
	employee: one(employees, { fields: [dispatches.employeeId], references: [employees.id] }),
	timesheet: one(timesheets, { fields: [dispatches.timesheetId], references: [timesheets.id] }),
}));

export const insertEmployeeSchema = createInsertSchema(employees).omit({ id: true, createdAt: true, updatedAt: true });
export const insertTimesheetSchema = createInsertSchema(timesheets).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertEmployee = z.infer<typeof insertEmployeeSchema>;
export type Employee = typeof employees.$inferSelect;
export type Timesheet = typeof timesheets.$inferSelect;