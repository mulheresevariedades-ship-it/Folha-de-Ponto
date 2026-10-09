import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const operationLocks = pgTable("operation_locks", {
	id: integer("id").primaryKey().default(1),
	ownerSessionId: text("owner_session_id"),
	expiresAt: timestamp("expires_at", { withTimezone: true }),
	updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
