import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const smtpSettings = pgTable("smtp_settings", {
	id: integer("id").primaryKey().default(1),
	host: text("host").notNull().default(""),
	port: integer("port").notNull().default(587),
	username: text("username").notNull().default(""),
	senderEmail: text("sender_email").notNull().default(""),
	passwordEncrypted: text("password_encrypted"),
	updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
