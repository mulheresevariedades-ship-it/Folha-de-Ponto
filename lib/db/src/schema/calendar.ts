import { createInsertSchema } from "drizzle-zod";
import { date, pgEnum, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const calendarEventType = pgEnum("calendar_event_type", [
	"feriado",
	"recesso",
	"ponto_facultativo",
	"suspensao_expediente",
	"outro",
]);

export const calendarEvents = pgTable(
	"calendar_events",
	{
		id: serial("id").primaryKey(),
		date: date("date", { mode: "string" }).notNull(),
		description: text("description").notNull(),
		type: calendarEventType("type").notNull().default("outro"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => ({
		calendarDateUnique: uniqueIndex("calendar_events_date_unique").on(table.date),
	}),
);

export const insertCalendarEventSchema = createInsertSchema(calendarEvents).omit({
	id: true,
	createdAt: true,
	updatedAt: true,
});

export type CalendarEvent = typeof calendarEvents.$inferSelect;
export type InsertCalendarEvent = z.infer<typeof insertCalendarEventSchema>;
