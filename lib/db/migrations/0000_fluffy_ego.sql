CREATE TYPE "public"."dispatch_status" AS ENUM('pendente', 'enviado', 'erro');--> statement-breakpoint
CREATE TYPE "public"."timesheet_status" AS ENUM('reconhecida', 'arquivada', 'revisao', 'pendente', 'baixa_confianca', 'rejeitada', 'ocr_indisponivel');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'operador', 'consulta');--> statement-breakpoint
CREATE TYPE "public"."calendar_event_type" AS ENUM('feriado', 'recesso', 'ponto_facultativo', 'suspensao_expediente', 'outro');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"action" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"original_filename" text NOT NULL,
	"storage_path" text NOT NULL,
	"file_hash" text NOT NULL,
	"mime_type" text NOT NULL,
	"page_count" integer DEFAULT 1 NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "batches_file_hash_unique" UNIQUE("file_hash")
);
--> statement-breakpoint
CREATE TABLE "dispatches" (
	"id" serial PRIMARY KEY NOT NULL,
	"timesheet_id" uuid NOT NULL,
	"employee_id" integer NOT NULL,
	"status" "dispatch_status" DEFAULT 'pendente' NOT NULL,
	"error_message" text,
	"delivery_mode" text DEFAULT 'simulado' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"authorized_by" uuid,
	"authorized_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employees" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"matricula" text NOT NULL,
	"cpf_encrypted" text,
	"cpf_last_digits" text,
	"cpf_search_hash" text,
	"email" text,
	"cargo" text DEFAULT '' NOT NULL,
	"workload_hours" integer DEFAULT 40 NOT NULL,
	"accumulates_role" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employees_matricula_unique" UNIQUE("matricula")
);
--> statement-breakpoint
CREATE TABLE "timesheets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" text NOT NULL,
	"employee_id" integer,
	"batch_id" uuid,
	"competency" text NOT NULL,
	"confidence" integer DEFAULT 0 NOT NULL,
	"status" timesheet_status DEFAULT 'pendente' NOT NULL,
	"status_label" text DEFAULT 'Pendente' NOT NULL,
	"note" text,
	"extracted_data" jsonb,
	"original_file_path" text,
	"person_competency_key" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "timesheets_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'consulta' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "calendar_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"description" text NOT NULL,
	"type" "calendar_event_type" DEFAULT 'outro' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operation_locks" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"owner_session_id" text,
	"expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "smtp_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"host" text DEFAULT '' NOT NULL,
	"port" integer DEFAULT 587 NOT NULL,
	"username" text DEFAULT '' NOT NULL,
	"sender_email" text DEFAULT '' NOT NULL,
	"secure" boolean DEFAULT false NOT NULL,
	"password_encrypted" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_timesheet_id_timesheets_id_fk" FOREIGN KEY ("timesheet_id") REFERENCES "public"."timesheets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_authorized_by_users_id_fk" FOREIGN KEY ("authorized_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "timesheets_employee_competency_unique" ON "timesheets" USING btree ("employee_id","competency");--> statement-breakpoint
CREATE UNIQUE INDEX "timesheets_person_competency_unique" ON "timesheets" USING btree ("person_competency_key","competency");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_events_date_unique" ON "calendar_events" USING btree ("date");