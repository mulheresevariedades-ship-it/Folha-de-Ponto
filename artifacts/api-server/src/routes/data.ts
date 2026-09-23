import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Router, type IRouter } from "express";
import multer from "multer";
import * as XLSX from "xlsx";
import { auditEvents, batches, db, dispatches, employees, timesheets } from "@workspace/db";

const router: IRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const uploadDirectory = path.resolve(process.env.PONTO_DATA_DIR ?? "data", "uploads");
mkdirSync(uploadDirectory, { recursive: true });

const statusLabels: Record<string, string> = {
  reconhecida: "Reconhecida",
  arquivada: "Arquivada",
  revisao: "Revisão necessária",
  pendente: "Pendente",
  baixa_confianca: "Baixa confiança",
  rejeitada: "Rejeitada",
  ocr_indisponivel: "OCR indisponível",
};

function maskCpf(lastDigits: string | null) {
  return lastDigits ? `***.***.***-${lastDigits}` : "***.***.***-**";
}

async function audit(action: string, entityType: string, entityId: string, metadata?: Record<string, unknown>) {
  await db.insert(auditEvents).values({ action, entityType, entityId, metadata });
}

router.post("/batches", upload.single("file"), async (req, res, next) => {
  try {
    const { competency } = req.body as { competency?: string };
    const file = req.file;
    if (!file || !competency) {
      res.status(400).json({ message: "file e competency são obrigatórios" });
      return;
    }
    const extension = path.extname(file.originalname).toLowerCase();
    if (!['.pdf', '.png', '.jpg', '.jpeg'].includes(extension)) {
      res.status(415).json({ message: "Formato de arquivo não suportado" });
      return;
    }

    const reference = `F-${Date.now().toString().slice(-7)}`;
    const fileHash = createHash("sha256").update(file.buffer).digest("hex");
    const storedName = `${fileHash}${extension}`;
    writeFileSync(path.join(uploadDirectory, storedName), file.buffer);
    const [batch] = await db.insert(batches).values({
      originalFilename: file.originalname,
      storagePath: path.join(uploadDirectory, storedName),
      fileHash,
      mimeType: file.mimetype,
      pageCount: 1,
    }).returning({ id: batches.id });
    const [sheet] = await db.insert(timesheets).values({
      reference,
      batchId: batch.id,
      competency,
      confidence: 0,
      status: "ocr_indisponivel",
      statusLabel: statusLabels.ocr_indisponivel,
      note: `Lote recebido: ${file.originalname}`,
    }).returning({ id: timesheets.id, reference: timesheets.reference });
    await audit("lote_recebido", "timesheet", sheet.id, { filename: file.originalname, competency });
    res.status(201).json({ id: sheet.reference, batch_id: batch.id });
  } catch (error) {
    next(error);
  }
});

router.post("/employees/import-file", upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) {
      res.status(400).json({ message: "file é obrigatório" });
      return;
    }
    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const records = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
    const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
    const valueFor = (record: Record<string, unknown>, names: string[]) => {
      const key = Object.keys(record).find((candidate) => names.includes(normalize(candidate)));
      return key ? String(record[key]).trim() : "";
    };
    const input = records.map((record) => ({
      name: valueFor(record, ["nome", "name"]),
      matricula: valueFor(record, ["matricula", "registration"]),
      cpfLastDigits: valueFor(record, ["cpf", "ultimos digitos do cpf"]).slice(-2) || undefined,
      email: valueFor(record, ["email", "e-mail"]) || undefined,
      workloadHours: Number(valueFor(record, ["carga horaria", "workload"])) || 40,
      accumulatesRole: ["sim", "true", "1", "yes"].includes(valueFor(record, ["acumula", "acumula cargo", "accumulates"]).toLowerCase()),
    })).filter((employee) => employee.name && employee.matricula);
    if (!input.length) {
      res.status(422).json({ message: "Nenhuma linha válida encontrada. Use as colunas Nome e Matrícula." });
      return;
    }
    const rows = await db.insert(employees).values(input).onConflictDoUpdate({ target: employees.matricula, set: { name: sql`excluded.name`, email: sql`excluded.email`, workloadHours: sql`excluded.workload_hours`, accumulatesRole: sql`excluded.accumulates_role` } }).returning({ id: employees.id });
    await audit("servidores_importados", "employee", randomUUID(), { count: rows.length, filename: req.file.originalname });
    res.status(201).json({ imported: rows.length });
  } catch (error) {
    next(error);
  }
});

router.patch("/timesheets/:id/review", async (req, res, next) => {
  try {
    const { action, name, matricula, competency, note } = req.body as {
      action?: "confirm" | "pending" | "reject";
      name?: string;
      matricula?: string;
      competency?: string;
      note?: string;
    };
    if (!action || !["confirm", "pending", "reject"].includes(action)) {
      res.status(400).json({ message: "Ação de revisão inválida" });
      return;
    }
    if (action === "confirm" && (!name?.trim() || !matricula?.trim())) {
      res.status(400).json({ message: "Nome e matrícula são obrigatórios para arquivar" });
      return;
    }
    const status = action === "confirm" ? "arquivada" : action === "reject" ? "rejeitada" : "pendente";
    const [current] = await db.select().from(timesheets).where(eq(timesheets.reference, req.params.id));
    if (!current) {
      res.status(404).json({ message: "Folha não encontrada" });
      return;
    }
    let employeeId = current.employeeId;
    if (matricula?.trim()) {
      const [employee] = await db.select().from(employees).where(eq(employees.matricula, matricula.trim()));
      if (employee) {
        employeeId = employee.id;
      } else if (name?.trim()) {
        const [createdEmployee] = await db.insert(employees).values({ name: name.trim(), matricula: matricula.trim() }).returning({ id: employees.id });
        employeeId = createdEmployee.id;
      } else {
        res.status(400).json({ message: "Matrícula não cadastrada e nome não informado" });
        return;
      }
    }
    const [updated] = await db.update(timesheets).set({
      employeeId,
      competency: competency || current.competency,
      status,
      statusLabel: statusLabels[status],
      note: note || null,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(timesheets.reference, req.params.id)).returning();
    await audit(action === "confirm" ? "folha_arquivada" : action === "reject" ? "folha_rejeitada" : "folha_pendente", "timesheet", updated.id, { name, matricula, note, competency: updated.competency, status });
    res.json(updated);
  } catch (error) {
    next(error);
  }
});

router.post("/employees/import", async (req, res, next) => {
  try {
    const input = req.body as { name: string; matricula: string; cpfLastDigits?: string; email?: string; workloadHours?: number; accumulatesRole?: boolean }[];
    if (!Array.isArray(input) || input.length === 0) {
      res.status(400).json({ message: "Envie uma lista de servidores" });
      return;
    }
    const rows = await db.insert(employees).values(input.map((employee) => ({
      name: employee.name,
      matricula: employee.matricula,
      cpfLastDigits: employee.cpfLastDigits,
      email: employee.email,
      workloadHours: employee.workloadHours ?? 40,
      accumulatesRole: employee.accumulatesRole ?? false,
    }))).onConflictDoUpdate({ target: employees.matricula, set: { name: sql`excluded.name`, email: sql`excluded.email`, workloadHours: sql`excluded.workload_hours`, accumulatesRole: sql`excluded.accumulates_role` } }).returning({ id: employees.id });
    await audit("servidores_importados", "employee", randomUUID(), { count: rows.length });
    res.status(201).json({ imported: rows.length });
  } catch (error) {
    next(error);
  }
});

router.patch("/dispatches/:id/authorize", async (req, res, next) => {
  try {
    const [current] = await db.select().from(dispatches).where(eq(dispatches.id, Number(req.params.id)));
    if (!current) {
      res.status(404).json({ message: "Despacho não encontrado" });
      return;
    }
    if (current.status !== "pendente" || current.authorizedAt) {
      res.status(409).json({ message: "Este despacho não está aguardando autorização" });
      return;
    }
    const [updated] = await db.update(dispatches).set({ authorizedAt: new Date() }).where(eq(dispatches.id, current.id)).returning();
    await audit("despacho_autorizado", "dispatch", String(updated.id));
    res.json(updated);
  } catch (error) {
    next(error);
  }
});

router.patch("/dispatches/:id/send", async (req, res, next) => {
  try {
    const [current] = await db.select().from(dispatches).where(eq(dispatches.id, Number(req.params.id)));
    if (!current) {
      res.status(404).json({ message: "Despacho não encontrado" });
      return;
    }
    if (current.status !== "pendente" || !current.authorizedAt) {
      res.status(409).json({ message: "Autorize o despacho antes de simular o envio" });
      return;
    }
    const [updated] = await db.update(dispatches).set({ status: "enviado", sentAt: new Date(), errorMessage: null }).where(eq(dispatches.id, current.id)).returning();
    await audit("despacho_enviado_simulado", "dispatch", String(updated.id));
    res.json(updated);
  } catch (error) {
    next(error);
  }
});

router.patch("/dispatches/:id/resend", async (req, res, next) => {
  try {
    const [current] = await db.select().from(dispatches).where(eq(dispatches.id, Number(req.params.id)));
    if (!current) {
      res.status(404).json({ message: "Despacho não encontrado" });
      return;
    }
    if (current.status !== "erro") {
      res.status(409).json({ message: "Somente despachos com erro podem ser reenviados" });
      return;
    }
    const [updated] = await db.update(dispatches).set({ status: "pendente", authorizedAt: null, sentAt: null, errorMessage: null }).where(eq(dispatches.id, current.id)).returning();
    await audit("despacho_reenviado", "dispatch", String(updated.id));
    res.json(updated);
  } catch (error) {
    next(error);
  }
});

router.get("/timesheets", async (req, res, next) => {
  try {
    const competency = typeof req.query.competency === "string" ? req.query.competency : undefined;
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const search = typeof req.query.q === "string" ? req.query.q.trim() : undefined;
    const filters = [
      competency ? eq(timesheets.competency, competency) : undefined,
      status ? eq(timesheets.status, status as typeof timesheets.status.enumValues[number]) : undefined,
      search ? or(ilike(timesheets.reference, `%${search}%`), ilike(employees.name, `%${search}%`), ilike(employees.matricula, `%${search}%`)) : undefined,
    ].filter(Boolean);

    const rows = await db
      .select({ sheet: timesheets, employee: employees })
      .from(timesheets)
      .leftJoin(employees, eq(timesheets.employeeId, employees.id))
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(timesheets.createdAt));

    res.json(rows.map(({ sheet, employee }) => ({
      id: sheet.reference,
      uuid: sheet.id,
      name: employee?.name ?? "Servidor não identificado",
      matricula: employee?.matricula ?? null,
      competencia: sheet.competency,
      confidence: sheet.confidence,
      status: sheet.status,
      status_label: sheet.statusLabel || statusLabels[sheet.status] || sheet.status,
      reviewed_at: sheet.reviewedAt,
      note: sheet.note,
    })));
  } catch (error) {
    next(error);
  }
});

router.get("/timesheets/:id", async (req, res, next) => {
  try {
    const [row] = await db
      .select({ sheet: timesheets, employee: employees })
      .from(timesheets)
      .leftJoin(employees, eq(timesheets.employeeId, employees.id))
      .where(eq(timesheets.reference, req.params.id));

    if (!row) {
      res.status(404).json({ message: "Folha não encontrada" });
      return;
    }

    res.json({ ...row.sheet, employee: row.employee });
  } catch (error) {
    next(error);
  }
});

router.get("/employees", async (_req, res, next) => {
  try {
    const rows = await db.select().from(employees).where(eq(employees.active, true)).orderBy(employees.name);
    res.json(rows.map((employee) => ({
      id: employee.id,
      name: employee.name,
      matricula: employee.matricula,
      cpf: maskCpf(employee.cpfLastDigits),
      email: employee.email,
      carga_horaria: employee.workloadHours,
      acumula: employee.accumulatesRole,
    })));
  } catch (error) {
    next(error);
  }
});

router.get("/dispatches", async (req, res, next) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const rows = await db
      .select({ dispatch: dispatches, employee: employees })
      .from(dispatches)
      .innerJoin(employees, eq(dispatches.employeeId, employees.id))
      .where(status ? eq(dispatches.status, status as typeof dispatches.status.enumValues[number]) : undefined)
      .orderBy(desc(dispatches.createdAt));

    res.json(rows.map(({ dispatch, employee }) => ({
      id: dispatch.id,
      employee_name: employee.name,
      employee_matricula: employee.matricula,
      status: dispatch.status,
      created_at: dispatch.createdAt,
      authorized_at: dispatch.authorizedAt,
      sent_at: dispatch.sentAt,
      error_message: dispatch.errorMessage,
    })));
  } catch (error) {
    next(error);
  }
});

router.get("/audit", async (_req, res, next) => {
  try {
    const rows = await db.select().from(auditEvents).orderBy(desc(auditEvents.createdAt)).limit(100);
    res.json(rows.map((row) => {
      const metadata = row.metadata ?? {};
      const actionLabels: Record<string, string> = {
        folha_arquivada: "Folha arquivada",
        folha_rejeitada: "Processamento rejeitado",
        folha_pendente: "Folha encaminhada para pendência",
        lote_recebido: "Lote recebido",
        despacho_autorizado: "Despacho autorizado",
        despacho_enviado_simulado: "Despacho enviado (simulado)",
        despacho_reenviado: "Despacho reenviado",
        servidores_importados: "Servidores importados",
      };
      return {
        id: row.entityId,
        name: typeof metadata.name === "string" ? metadata.name : "Sistema",
        action: actionLabels[row.action] ?? row.action,
        status: typeof metadata.status === "string" ? metadata.status : "reconhecida",
        competencia: typeof metadata.competency === "string" ? metadata.competency : "",
        date: row.createdAt,
      };
    }));
  } catch (error) {
    next(error);
  }
});

router.get("/dashboard", async (req, res, next) => {
  try {
    const competency = typeof req.query.competency === "string" ? req.query.competency : undefined;
    const rows = await db.select().from(timesheets).where(competency ? eq(timesheets.competency, competency) : undefined);
    const recognized = rows.filter((row) => ["reconhecida", "arquivada"].includes(row.status)).length;
    const review = rows.filter((row) => ["revisao", "pendente", "ocr_indisponivel"].includes(row.status)).length;
    const lowConfidence = rows.filter((row) => row.status === "baixa_confianca").length;
    const archived = rows.filter((row) => row.status === "arquivada").length;
    const dispatchRows = await db.select().from(dispatches);

    res.json({
      total: rows.length,
      recognized,
      review,
      low_confidence: lowConfidence,
      archived,
      recognition_rate: rows.length ? Math.round((recognized / rows.length) * 100) : 0,
      dispatch_pending: dispatchRows.filter((row) => row.status === "pendente").length,
      dispatch_sent: dispatchRows.filter((row) => row.status === "enviado").length,
      dispatch_error: dispatchRows.filter((row) => row.status === "erro").length,
    });
  } catch (error) {
    next(error);
  }
});

export default router;