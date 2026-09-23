import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { auditEvents, batches, db, dispatches, employees, timesheets } from "@workspace/db";

const router: IRouter = Router();

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

router.post("/batches", async (req, res, next) => {
  try {
    const { filename, competency } = req.body as { filename?: string; competency?: string };
    if (!filename || !competency) {
      res.status(400).json({ message: "filename e competency são obrigatórios" });
      return;
    }

    const reference = `F-${Date.now().toString().slice(-7)}`;
    const fileHash = `${filename}-${Date.now()}`;
    const [batch] = await db.insert(batches).values({
      originalFilename: filename,
      storagePath: `pending/${fileHash}`,
      fileHash,
      mimeType: "application/octet-stream",
      pageCount: 1,
    }).returning({ id: batches.id });
    const [sheet] = await db.insert(timesheets).values({
      reference,
      batchId: batch.id,
      competency,
      confidence: 0,
      status: "ocr_indisponivel",
      statusLabel: statusLabels.ocr_indisponivel,
      note: `Lote recebido: ${filename}`,
    }).returning({ id: timesheets.id, reference: timesheets.reference });
    await audit("lote_recebido", "timesheet", sheet.id, { filename, competency });
    res.status(201).json({ id: sheet.reference, batch_id: batch.id });
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