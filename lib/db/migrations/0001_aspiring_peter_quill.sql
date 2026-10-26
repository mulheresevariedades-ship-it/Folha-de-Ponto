ALTER TABLE "timesheets" ADD COLUMN "source_fingerprint" text;--> statement-breakpoint
WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY timesheet_id
    ORDER BY (status = 'enviado') DESC, (status = 'pendente') DESC, created_at DESC, id DESC
  ) AS position
  FROM "dispatches"
)
DELETE FROM "dispatches" AS d
USING ranked
WHERE d.id = ranked.id AND ranked.position > 1;--> statement-breakpoint
CREATE UNIQUE INDEX "dispatches_timesheet_unique" ON "dispatches" USING btree ("timesheet_id");--> statement-breakpoint
CREATE UNIQUE INDEX "timesheets_source_fingerprint_unique" ON "timesheets" USING btree ("source_fingerprint") WHERE "timesheets"."source_fingerprint" is not null;