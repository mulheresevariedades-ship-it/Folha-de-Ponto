import cors from "cors";
import express from "express";
import { randomUUID } from "node:crypto";

const app = express();
const port = Number(process.env.PORT ?? 4000);
const now = new Date().toISOString();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

type DemoTimesheet = {
	id: string;
	name: string;
	matricula: string | null;
	competencia: string;
	confidence: number;
	status: string;
	status_label: string;
	reviewed_at: string | null;
	note: string | null;
	file_url: string | null;
};

const employees = [
	{
		id: 1,
		name: "Maria Silva Santos",
		matricula: "2027001",
		cpf: "***.***.***-42",
		email: "maria.santos@undf.edu.br",
		cargo: "Professora",
		carga_horaria: 40,
		acumula: false,
	},
	{
		id: 2,
		name: "Joao Pedro Oliveira",
		matricula: "2027002",
		cpf: "***.***.***-18",
		email: "joao.oliveira@undf.edu.br",
		cargo: "Tecnico Administrativo",
		carga_horaria: 40,
		acumula: true,
	},
];

const timesheets: DemoTimesheet[] = [
	{
		id: "demo-timesheet-1",
		name: employees[0].name,
		matricula: employees[0].matricula,
		competencia: "2026-10",
		confidence: 96,
		status: "reconhecida",
		status_label: "Reconhecida",
		reviewed_at: null,
		note: null,
		file_url: null,
	},
	{
		id: "demo-timesheet-2",
		name: employees[1].name,
		matricula: employees[1].matricula,
		competencia: "2026-10",
		confidence: 78,
		status: "revisao",
		status_label: "Revisao necessaria",
		reviewed_at: null,
		note: "Confira os dados reconhecidos antes de arquivar.",
		file_url: null,
	},
];

const calendar = [
	{ id: 1, date: "2026-10-12", description: "Nossa Senhora Aparecida" },
	{ id: 2, date: "2026-11-02", description: "Finados" },
];

const dispatches = employees.map((employee, index) => ({
	id: index + 1,
	employee_name: employee.name,
	employee_matricula: employee.matricula,
	employee_email: employee.email,
	employee_cpf: employee.cpf,
	status: index === 0 ? "enviado" : "pendente",
	created_at: now,
	authorized_at: index === 0 ? now : null,
	sent_at: index === 0 ? now : null,
	error_message: null,
	delivery_mode: "simulado",
}));

const audit: Array<Record<string, unknown>> = [];
let smtp = {
	host: "",
	port: 587,
	username: "",
	senderEmail: "",
	secure: false,
	passwordSet: false,
	demoOnly: true,
	source: "demo",
};
let lockOwner: string | null = null;
let lockExpiresAt: number | null = null;

function lockState(sessionId: string) {
	const active = Boolean(lockOwner && lockExpiresAt && lockExpiresAt > Date.now());
	return {
		locked: active && lockOwner !== sessionId,
		heldByThisClient: active && lockOwner === sessionId,
		expiresAt: active && lockExpiresAt ? new Date(lockExpiresAt).toISOString() : null,
	};
}

function auditEvent(action: string, name = "", matricula = "", competencia = "") {
	audit.unshift({
		id: randomUUID(),
		name,
		matricula,
		cpf: "",
		action,
		status: "Registrado",
		competencia,
		date: new Date().toISOString(),
	});
}

app.get("/api/healthz", (_req, res) => res.json({ status: "ok-demo" }));
app.get("/api/lock", (req, res) => res.json(lockState(String(req.query.sessionId ?? ""))));
app.post("/api/lock/heartbeat", (req, res) => {
	const sessionId = String(req.body.sessionId ?? "");
	const currentState = lockState(sessionId);
	if (!currentState.locked) {
		lockOwner = sessionId;
		lockExpiresAt = Date.now() + 30_000;
	}
	res.json(lockState(sessionId));
});
app.post("/api/lock/release", (req, res) => {
	if (lockOwner === String(req.body.sessionId ?? "")) {
		lockOwner = null;
		lockExpiresAt = null;
	}
	res.json(lockState(String(req.body.sessionId ?? "")));
});

app.get("/api/dashboard", (_req, res) => res.json({
	total: timesheets.length,
	recognized: 1,
	review: 1,
	low_confidence: 0,
	archived: 0,
	recognition_rate: 50,
	dispatch_pending: 1,
	dispatch_sent: 1,
	dispatch_error: 0,
}));
app.get("/api/timesheets", (req, res) => {
	const query = String(req.query.q ?? "").toLocaleLowerCase();
	const result = timesheets.filter((item) =>
		(!req.query.competency || item.competencia === req.query.competency) &&
		(!req.query.status || item.status === req.query.status) &&
		(!query || `${item.name} ${item.matricula}`.toLocaleLowerCase().includes(query)),
	);
	res.json(result);
});
app.get("/api/timesheets/:id", (req, res) => {
	const item = timesheets.find((sheet) => sheet.id === req.params.id);
	if (!item) return res.status(404).json({ message: "Folha não encontrada." });
	return res.json(item);
});
app.patch("/api/timesheets/:id/review", (req, res) => {
	const item = timesheets.find((sheet) => sheet.id === req.params.id);
	if (!item) return res.status(404).json({ message: "Folha não encontrada." });
	item.status = req.body.action === "confirm" ? "arquivada" : req.body.action === "reject" ? "rejeitada" : "pendente";
	item.status_label = item.status === "arquivada" ? "Arquivada" : item.status === "rejeitada" ? "Rejeitada" : "Pendente";
	item.reviewed_at = new Date().toISOString();
	auditEvent("folha_revisada", item.name, item.matricula ?? "", item.competencia);
	return res.json(item);
});
app.get("/api/timesheets/:id/file", (_req, res) => res.status(404).json({ message: "Arquivo não disponível no modo visual." }));

const demoPreviewEntry = {
	sourceFilename: "exemplo-folha.pdf",
	pageNumber: 1,
	name: employees[0].name,
	matricula: employees[0].matricula,
	competency: "2026-10",
	competencyDetected: true,
	competencySource: "conteudo-pdf",
	confidence: 96,
	duplicate: false,
	duplicateInUpload: false,
	duplicateReason: null,
	needsReview: false,
};
const demoFileResults = [{ sourceFilename: "exemplo-folha.pdf", pages: 1, status: "processado", message: null }];
app.post("/api/batches/preview", (_req, res) => res.json({
	entries: [demoPreviewEntry],
	newCount: 1,
	duplicateCount: 0,
	reviewCount: 0,
	unidentifiedCount: 0,
	errors: [],
	fileResults: demoFileResults,
}));
app.post("/api/batches", (_req, res) => res.status(201).json({
	created: 1,
	updated: 0,
	skipped: 0,
	entries: [demoPreviewEntry],
	errors: [],
	skippedDetails: [],
	duplicatesInBatch: 0,
	fileResults: demoFileResults,
}));

app.get("/api/employees", (req, res) => {
	const query = String(req.query.q ?? "").toLocaleLowerCase();
	res.json(employees.filter((employee) => !query || `${employee.name} ${employee.matricula} ${employee.cpf}`.toLocaleLowerCase().includes(query)));
});
app.post("/api/employees", (req, res) => {
	const employee = { id: employees.length + 1, name: req.body.name, matricula: req.body.matricula, cpf: "***.***.***-00", email: req.body.email ?? "", cargo: req.body.cargo ?? "", carga_horaria: req.body.workloadHours ?? 40, acumula: req.body.accumulatesRole ?? false };
	employees.push(employee);
	auditEvent("servidor_criado", employee.name, employee.matricula);
	res.status(201).json(employee);
});
app.patch("/api/employees/:id", (req, res) => {
	const employee = employees.find((item) => item.id === Number(req.params.id));
	if (!employee) return res.status(404).json({ message: "Servidor não encontrado." });
	Object.assign(employee, { name: req.body.name ?? employee.name, matricula: req.body.matricula ?? employee.matricula, email: req.body.email ?? employee.email, cargo: req.body.cargo ?? employee.cargo, carga_horaria: req.body.workloadHours ?? employee.carga_horaria, acumula: req.body.accumulatesRole ?? employee.acumula });
	return res.json(employee);
});
app.delete("/api/employees/:id", (_req, res) => res.status(204).end());
app.post("/api/employees/import/preview", (_req, res) => res.json({ newCount: 0, updatedCount: 0, skippedCount: 0, rows: [] }));
app.post("/api/employees/import", (_req, res) => res.json({ imported: 0, updated: 0, skipped: 0 }));

app.get("/api/calendar", (_req, res) => res.json(calendar));
app.post("/api/calendar", (req, res) => {
	const event = { id: calendar.length + 1, date: req.body.date, description: req.body.description };
	calendar.push(event);
	res.status(201).json(event);
});
app.patch("/api/calendar/:id", (req, res) => {
	const event = calendar.find((item) => item.id === Number(req.params.id));
	if (!event) return res.status(404).json({ message: "Data especial não encontrada." });
	Object.assign(event, req.body);
	return res.json(event);
});
app.delete("/api/calendar/:id", (_req, res) => res.status(204).end());
app.post("/api/calendar/import/preview", (_req, res) => res.json({ newCount: 0, updatedCount: 0, skippedCount: 0, rows: [] }));
app.post("/api/calendar/import", (_req, res) => res.json({ imported: 0, updated: 0, skipped: 0 }));

app.get("/api/dispatches", (req, res) => {
	const query = String(req.query.q ?? "").toLocaleLowerCase();
	const status = String(req.query.status ?? "");
	const from = String(req.query.from ?? "");
	const to = String(req.query.to ?? "");
	res.json(
		dispatches.filter((row) => {
			const record = row as Record<string, unknown>;
			if (status && row.status !== status) return false;
			if (query && !`${row.employee_name} ${row.employee_matricula} ${row.employee_email}`.toLocaleLowerCase().includes(query)) return false;
			const reference = String(record.sent_at ?? record.created_at ?? "");
			if (from && (!reference || reference.slice(0, 10) < from)) return false;
			if (to && (!reference || reference.slice(0, 10) > to)) return false;
			return true;
		}),
	);
});
app.patch("/api/dispatches/:id/send", (_req, res) => res.json({ ...dispatches[0], status: "enviado", sent_at: new Date().toISOString() }));
app.patch("/api/dispatches/:id/resend", (_req, res) => res.json({ ...dispatches[0], status: "enviado", sent_at: new Date().toISOString() }));
app.post("/api/dispatches/send-batch", (_req, res) => res.json({ processed: dispatches.length, results: dispatches.map((item) => ({ id: item.id, status: "enviado", message: "Simulado com sucesso." })) }));

app.get("/api/settings/smtp", (_req, res) => res.json(smtp));
app.put("/api/settings/smtp", (req, res) => {
	smtp = { ...smtp, host: req.body.host, port: Number(req.body.port), username: req.body.username ?? "", senderEmail: req.body.senderEmail, passwordSet: Boolean(req.body.appPassword) || smtp.passwordSet };
	res.json(smtp);
});
app.post("/api/settings/smtp/test", (_req, res) => res.json({ valid: true, message: "Campos válidos. Nenhum e-mail real será enviado no modo demo.", demoOnly: true }));
app.get("/api/audit", (_req, res) => res.json(audit));

app.listen(port, () => {
	console.log(`Demo API listening on http://localhost:${port}`);
});
