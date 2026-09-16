const viewNames = {
  dashboard: "Dashboard",
  ocr: "Conferência OCR",
  arquivo: "Arquivo de folhas",
  servidores: "Servidores",
  envios: "Fila de envios",
  auditoria: "Auditoria",
  historico: "Histórico",
  usuarios: "Usuários",
  "novo-lote": "Novo lote",
  configuracoes: "Configurações",
  login: "Acesso ao sistema",
};

let currentUser = null;
let authToken = null;
let queueData = [];
let selectedIndex = 0;
let selectedTimesheetId = null;
let employees = [];
let dispatchesData = [];

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function authHeaders(contentType) {
  const headers = {};
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  if (contentType) headers["Content-Type"] = contentType;
  return headers;
}

async function apiFetch(url, options = {}) {
  const headers = { ...authHeaders(), ...options.headers };
  if (options.body instanceof FormData) {
    delete headers["Content-Type"];
  } else if (!options.headers || !options.headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401) {
    logout();
    throw new Error("Sessão expirada. Faça login novamente.");
  }
  if (response.status === 403) {
    throw new Error("Permissão insuficiente.");
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail || "Não foi possível concluir a operação.");
  return body;
}

function showToast(message, error = false) {
  const toast = $("#toast");
  $("#toastMessage").textContent = message;
  toast.classList.add("visible");
  toast.querySelector(".toast-icon").textContent = error ? "!" : "✓";
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => toast.classList.remove("visible"), 3600);
}

function showView(view) {
  const isLogin = view === "login";
  $(".app-shell").classList.toggle("hidden", isLogin);
  $("#loginView").classList.toggle("hidden", !isLogin);
  if (isLogin) return;
  const mainViews = ["dashboard", "ocr", "arquivo", "envios", "servidores", "auditoria", "novo-lote"];
  mainViews.forEach((v) => {
    const el = $(`#${v}View`);
    if (el) el.classList.toggle("hidden", v !== view);
  });
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  $("#breadcrumbCurrent").textContent = viewNames[view] || "Módulo";
  $("#sidebar").classList.remove("open");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function statusClass(status) {
  return {
    reconhecida: "status-green",
    arquivada: "status-green",
    revisao: "status-yellow",
    pendente: "status-yellow",
    baixa_confianca: "status-red",
    rejeitada: "status-red",
    nao_identificado: "status-gray",
    ocr_indisponivel: "status-gray",
  }[status] || "status-gray";
}

function statusLabel(status) {
  return {
    reconhecida: "Reconhecida",
    arquivada: "Arquivada",
    revisao: "Revisão necessária",
    pendente: "Pendente",
    baixa_confianca: "Baixa confiança",
    rejeitada: "Rejeitada",
    nao_identificado: "Não identificado",
    ocr_indisponivel: "OCR indisponível",
  }[status] || status;
}

function updateUserInfo() {
  if (!currentUser) return;
  const initials = (currentUser.full_name || currentUser.username || "?")
    .split(" ").map((w) => w[0]).join("").substring(0, 2).toUpperCase();
  $$(".sidebar-user strong").forEach((el) => { el.textContent = currentUser.full_name || currentUser.username; });
  $$(".sidebar-user span").forEach((el) => {
    if (el.classList.contains("more-icon")) return;
    if (el.closest(".sidebar-user")) {
      const roleMap = { admin: "Administrador", operador: "Operador DIGEP", consulta: "Consulta" };
      el.textContent = roleMap[currentUser.role] || currentUser.role;
    }
  });
  $$(".sidebar-user .avatar").forEach((el) => { el.textContent = initials; });
  $$(".topbar-user-copy strong").forEach((el) => { el.textContent = currentUser.full_name || currentUser.username; });
  $$(".topbar-user-copy span").forEach((el) => {
    const roleMap = { admin: "Administrador", operador: "Operador DIGEP", consulta: "Consulta" };
    el.textContent = roleMap[currentUser.role] || currentUser.role;
  });
  $$(".topbar-user .avatar").forEach((el) => { el.textContent = initials; });
  const isAdmin = currentUser.role === "admin";
  $$("[data-admin-only]").forEach((el) => el.classList.toggle("hidden", !isAdmin));
}

function updateNavCounts(dashboardData) {
  const ocrCount = $$(".nav-item[data-view='ocr'] .nav-count");
  if (ocrCount.length && dashboardData) {
    ocrCount[0].textContent = String(dashboardData.review + dashboardData.low_confidence).padStart(2, "0");
  }
  const enviosCount = $$(".nav-item[data-view='envios'] .nav-count");
  if (enviosCount.length && dashboardData) {
    enviosCount[0].textContent = String(dashboardData.dispatch_pending || 0).padStart(2, "0");
  }
}

async function loadDashboard() {
  const competency = $("#competencySelect").value;
  const data = await apiFetch(`/api/dashboard?competency=${encodeURIComponent(competency)}`);
  const values = [data.total, data.recognized, data.review, data.low_confidence];
  $$(".metric-number").forEach((node, index) => { node.textContent = values[index] ?? 0; });
  const percent = data.recognition_rate || 0;
  $(".progress-summary strong").textContent = `${percent}%`;
  $(".progress-track.large span").style.width = `${percent}%`;
  $(".progress-summary span").textContent = `${data.recognized} de ${data.total} folhas reconhecidas automaticamente`;
  const legendValues = [data.recognized, data.review, data.low_confidence];
  $$(".legend-grid strong").forEach((node, index) => { node.textContent = legendValues[index] ?? 0; });
  const miniValues = $$(".mini-stat-row strong");
  if (miniValues[0]) miniValues[0].textContent = data.average_processing_seconds > 0 ? `${data.average_processing_seconds}s` : "—";
  if (miniValues[1]) miniValues[1].textContent = data.archived;
  updateNavCounts(data);
  const dp = data.dispatch_pending || 0;
  const ds = data.dispatch_sent || 0;
  const de = data.dispatch_error || 0;
  const dt = dp + ds + de;
  $(".dispatch-donut strong").textContent = dt;
  $$(".dispatch-copy strong")[0].textContent = ds;
  $$(".dispatch-copy strong")[1].textContent = dp + de;
  const badge = $(".dispatch-panel .small-badge");
  if (badge) badge.textContent = `${dp} pendente${dp !== 1 ? "s" : ""}`;
  loadAttentionTable();
  loadActivityList();
  return data;
}

async function loadAttentionTable() {
  const competency = $("#competencySelect").value;
  try {
    const rows = await apiFetch(`/api/timesheets?competency=${encodeURIComponent(competency)}&status=revisao`);
    const lowConf = await apiFetch(`/api/timesheets?competency=${encodeURIComponent(competency)}&status=baixa_confianca`);
    const all = [...rows, ...lowConf];
    const tbody = $("#attentionRows");
    if (!all.length) {
      tbody.innerHTML = '<tr><td colspan="5"><div class="empty-inline">Nenhuma folha precisa de atenção nesta competência.</div></td></tr>';
      return;
    }
    tbody.innerHTML = all.slice(0, 6).map((t) => {
      const initials = (t.name || "??").split(" ").map((w) => w[0]).join("").substring(0, 2).toUpperCase();
      const confBarClass = t.confidence < 70 ? "" : "yellow-bar";
      return `<tr>
        <td><div class="person-cell"><div class="avatar-table avatar ${t.confidence < 70 ? "orange-bg" : "purple-bg"}">${initials}</div><span>${t.name}</span></div></td>
        <td>${t.matricula || "—"}</td>
        <td><div class="confidence"><div class="confidence-bar"><i class="${confBarClass}" style="width:${t.confidence}%"></i></div><strong>${t.confidence}%</strong></div></td>
        <td><span class="status-pill ${statusClass(t.status)}">${t.status_label || statusLabel(t.status)}</span></td>
        <td><button class="row-action" onclick="showView('ocr')">Revisar →</button></td>
      </tr>`;
    }).join("");
  } catch (e) {
    const tbody = $("#attentionRows");
    tbody.innerHTML = '<tr><td colspan="5"><div class="empty-inline">Erro ao carregar dados.</div></td></tr>';
  }
}

async function loadActivityList() {
  try {
    const competency = $("#competencySelect").value;
    const allSheets = await apiFetch(`/api/timesheets?competency=${encodeURIComponent(competency)}`);
    const list = $("#activityList");
    if (!allSheets.length) {
      list.innerHTML = '<div class="empty-inline">Nenhuma atividade registrada nesta competência.</div>';
      return;
    }
    const recent = allSheets.filter((t) => t.reviewed_at || t.archived_at).slice(-5).reverse();
    if (!recent.length) {
      list.innerHTML = '<div class="empty-inline">Nenhuma atividade registrada nesta competência.</div>';
      return;
    }
    list.innerHTML = recent.map((t) => {
      const bulletClass = t.status === "arquivada" ? "green" : t.status === "revisao" ? "yellow" : "blue";
      const action = t.status === "arquivada" ? "Folha arquivada" : t.status === "revisao" ? "Em conferência" : "Processada";
      const time = t.reviewed_at || t.updated_at || "";
      const timeStr = time ? new Date(time).toLocaleDateString("pt-BR") : "";
      return `<div class="activity-item">
        <span class="activity-bullet ${bulletClass}"></span>
        <div><strong>${t.name}</strong><span>${action} · ${t.competencia}</span></div>
        <time>${timeStr}</time>
      </div>`;
    }).join("");
  } catch (e) {
    const list = $("#activityList");
    list.innerHTML = '<div class="empty-inline">Erro ao carregar atividade.</div>';
  }
}

function updateEmployeeSelect() {
  const select = $("#employeeSelect");
  select.innerHTML = '<option value="">Selecione um servidor</option>';
  employees.forEach((employee) => {
    const option = document.createElement("option");
    option.value = employee.id;
    option.textContent = `${employee.name} · ${employee.matricula}`;
    select.appendChild(option);
  });
}

function selectQueue(index) {
  const item = queueData[index];
  if (!item) return;
  selectedIndex = index;
  selectedTimesheetId = item.id;
  $$(".queue-item").forEach((queueItem, itemIndex) => queueItem.classList.toggle("selected", itemIndex === index));
  $("#queueProgress").textContent = index + 1;
  $("#reviewTitle").textContent = item.name;
  $("#reviewSubtitle").textContent = `Matrícula ${item.matricula || "não encontrada"} · Referência ${item.competencia}`;
  $("#reviewStatus").textContent = item.status_label || statusLabel(item.status);
  $("#reviewStatus").className = `status-pill ${statusClass(item.status)}`;
  $("#confidenceValue").textContent = `${item.confidence}%`;
  $("#confidenceProgress").style.width = `${item.confidence}%`;
  $("#confidenceProgress").style.background = item.confidence < 70 ? "var(--red)" : "#eab13e";
  $("#confidenceMessage").textContent = item.confidence < 70
    ? "Revise os campos destacados antes de associar."
    : "Alguns campos podem precisar de revisão.";
  $("#matriculaInput").value = item.matricula || "";
  $("#nameInput").value = item.name === "Servidor não identificado" ? "" : item.name;
  $("#employeeSelect").value = item.employee_id ? String(item.employee_id) : "";
  $("#paperMatricula").textContent = item.matricula || "—";
  $("#paperName").textContent = (item.name || "").toUpperCase();
  $("#noteInput").value = item.note || "";
}

function renderQueueList() {
  const container = $("#queueList");
  container.innerHTML = "";
  queueData.forEach((item, index) => {
    const pillClass = statusClass(item.status);
    const pillLabel = item.status_label || statusLabel(item.status);
    const btn = document.createElement("button");
    btn.className = `queue-item${index === selectedIndex ? " selected" : ""}`;
    btn.dataset.queueIndex = index;
    btn.type = "button";
    btn.innerHTML = `
      <div class="queue-thumb"><span>REGISTRO<br>DE<br>FREQUÊNCIA</span></div>
      <div class="queue-item-copy">
        <strong>${item.name}</strong>
        <span>Mat. ${item.matricula || "não encontrada"} · ${item.competencia}</span>
        <div><span class="status-pill ${pillClass}">${pillLabel}</span><span class="queue-confidence">${item.confidence}%</span></div>
      </div>
      <span class="queue-chevron">›</span>`;
    btn.addEventListener("click", () => selectQueue(index));
    container.appendChild(btn);
  });
  const count = queueData.length;
  $("#queueProgress").textContent = count ? Math.min(selectedIndex + 1, count) : 0;
  $(".queue-count").textContent = String(count).padStart(2, "0");
  const pendingText = $(".ocr-toolbar-copy strong");
  if (pendingText) pendingText.textContent = `${count} folha${count !== 1 ? "s" : ""} aguardando conferência`;
}

async function loadQueue() {
  const competency = $("#competencySelect").value;
  const allRows = await apiFetch(`/api/timesheets?competency=${encodeURIComponent(competency)}`);
  queueData = allRows.filter((row) => !["arquivada", "rejeitada"].includes(row.status));
  selectedIndex = 0;
  renderQueueList();
  if (queueData.length) selectQueue(0);
}

async function loadData() {
  try {
    const empResult = await apiFetch("/api/employees");
    employees = Array.isArray(empResult) ? empResult : [];
    updateEmployeeSelect();
    await loadDashboard();
    await loadQueue();
  } catch (error) {
    showToast(`Erro ao carregar dados: ${error.message}`, true);
  }
}

async function reviewAction(action) {
  if (!selectedTimesheetId) return showToast("Selecione uma folha para continuar.", true);
  try {
    let result;
    const currentCompetency = $("#competencySelect").value;
    if (action === "confirm") {
      const employeeId = $("#employeeSelect").value ? Number($("#employeeSelect").value) : null;
      result = await apiFetch(`/api/timesheets/${selectedTimesheetId}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: $("#nameInput").value.trim() || "Servidor não identificado",
          matricula: $("#matriculaInput").value.trim() || null,
          competencia: currentCompetency,
          employee_id: employeeId,
          note: $("#noteInput").value.trim(),
        }),
      });
    } else if (action === "pending") {
      const note = encodeURIComponent($("#noteInput").value.trim());
      result = await apiFetch(`/api/timesheets/${selectedTimesheetId}/pending?note=${note}`, { method: "POST" });
    } else {
      result = await apiFetch(`/api/timesheets/${selectedTimesheetId}/reject`, { method: "POST" });
    }
    showToast(`${result.name} atualizado: ${result.status_label}.`);
    await Promise.all([loadDashboard(), loadQueue()]);
  } catch (error) {
    showToast(error.message, true);
  }
}

async function uploadBatch() {
  const input = $("#batchFileInput");
  const file = input.files[0];
  if (!file) return;
  const form = new FormData();
  form.append("file", file);
  try {
    const result = await apiFetch("/api/batches", { method: "POST", body: form });
    showToast(`Lote processado: ${result.pages} página(s) em modo ${result.mode}.`);
    showView("ocr");
    await Promise.all([loadDashboard(), loadQueue()]);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    input.value = "";
  }
}

async function loadArchive() {
  const statusFilter = $("#archiveStatusFilter").value;
  const q = ($("#archiveSearchInput")?.value || "").trim();
  const competency = $("#competencySelect").value;
  const params = new URLSearchParams({ competency });
  if (statusFilter && statusFilter !== "todos") params.set("status", statusFilter);
  if (q) params.set("q", q);
  try {
    const rows = await apiFetch(`/api/timesheets?${params}`);
    const tbody = $("#archiveTableBody");
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="6"><div class="empty-inline">Nenhuma folha encontrada.</div></td></tr>';
      return;
    }
    tbody.innerHTML = rows.map((t) => {
      const confBarClass = t.confidence < 70 ? "" : "yellow-bar";
      return `<tr>
        <td>${t.id}</td>
        <td><div class="person-cell"><span>${t.name}</span></div></td>
        <td>${t.matricula || "—"}</td>
        <td>${t.competencia}</td>
        <td><span class="status-pill ${statusClass(t.status)}">${t.status_label || statusLabel(t.status)}</span></td>
        <td><div class="confidence"><div class="confidence-bar"><i class="${confBarClass}" style="width:${t.confidence}%"></i></div><strong>${t.confidence}%</strong></div></td>
      </tr>`;
    }).join("");
  } catch (error) {
    showToast(error.message, true);
  }
}

async function loadDispatches() {
  const statusFilter = $("#dispatchStatusFilter").value;
  const params = new URLSearchParams();
  if (statusFilter && statusFilter !== "todos") params.set("status", statusFilter);
  try {
    dispatchesData = await apiFetch(`/api/dispatches?${params}`);
    const tbody = $("#dispatchesTableBody");
    if (!dispatchesData.length) {
      tbody.innerHTML = '<tr><td colspan="7"><div class="empty-inline">Nenhum despacho encontrado.</div></td></tr>';
      return;
    }
    tbody.innerHTML = dispatchesData.map((d) => {
      const dateStr = d.sent_at
        ? new Date(d.sent_at).toLocaleDateString("pt-BR")
        : d.authorized_at
          ? new Date(d.authorized_at).toLocaleDateString("pt-BR")
          : new Date(d.created_at).toLocaleDateString("pt-BR");
      let actions = "";
      if (d.status === "pendente" && currentUser && currentUser.role === "admin") {
        actions += `<button class="row-action" onclick="authorizeDispatch(${d.id})">Autorizar</button> `;
      }
      if (d.status === "pendente" && d.authorized_at) {
        actions += `<button class="row-action" onclick="simulateSendDispatch(${d.id})">Simular envio</button> `;
      }
      if (d.status === "erro") {
        actions += `<button class="row-action" onclick="resendDispatch(${d.id})">Reenviar</button> `;
      }
      return `<tr>
        <td>${d.id}</td>
        <td>${d.employee_name || "—"}</td>
        <td>${d.employee_matricula || "—"}</td>
        <td><span class="status-pill ${d.status === "enviado" ? "status-green" : d.status === "erro" ? "status-red" : "status-yellow"}">${d.status === "enviado" ? "Enviado" : d.status === "erro" ? "Erro" : "Pendente"}</span></td>
        <td>${dateStr}</td>
        <td>${d.error_message || "—"}</td>
        <td>${actions}</td>
      </tr>`;
    }).join("");
  } catch (error) {
    showToast(error.message, true);
  }
}

async function authorizeDispatch(id) {
  try {
    await apiFetch(`/api/dispatches/${id}/authorize`, { method: "POST" });
    showToast("Despacho autorizado com sucesso.");
    await loadDispatches();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function simulateSendDispatch(id) {
  try {
    await apiFetch(`/api/dispatches/${id}/simulate-send`, { method: "POST" });
    showToast("Envio simulado com sucesso.");
    await loadDispatches();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function resendDispatch(id) {
  try {
    await apiFetch(`/api/dispatches/${id}/resend`, { method: "POST" });
    showToast("Despacho reenviado para a fila.");
    await loadDispatches();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function loadEmployees() {
  try {
    employees = await apiFetch("/api/employees");
    const tbody = $("#employeesTableBody");
    if (!employees.length) {
      tbody.innerHTML = '<tr><td colspan="6"><div class="empty-inline">Nenhum servidor cadastrado.</div></td></tr>';
      return;
    }
    tbody.innerHTML = employees.map((e) => `<tr>
      <td>${e.id}</td>
      <td>${e.name}</td>
      <td>${e.matricula}</td>
      <td>${e.cpf}</td>
      <td>${e.email || "—"}</td>
      <td>${e.carga_horaria}h</td>
    </tr>`).join("");
    updateEmployeeSelect();
  } catch (error) {
    showToast(error.message, true);
  }
}

function handleImportPreview(event) {
  event.preventDefault();
  const fileInput = $("#employeeImportFile");
  const file = fileInput.files[0];
  if (!file) return;
  const form = new FormData();
  form.append("file", file);
  apiFetch("/api/employees/import/preview", { method: "POST", body: form })
    .then((result) => {
      const summary = $("#employeeImportSummary");
      const errorsDiv = $("#employeeImportErrors");
      const confirmBtn = $("#confirmEmployeeImport");
      summary.innerHTML = `<p>${result.valid_rows} linha(s) válida(s) de ${result.total_rows} total</p>`;
      if (result.errors.length) {
        errorsDiv.innerHTML = `<p>${result.errors.length} linha(s) com erro:</p><ul>${
          result.errors.map((e) => `<li>Linha ${e.line}: ${e.errors.join(", ")}</li>`).join("")
        }</ul>`;
      } else {
        errorsDiv.innerHTML = "";
      }
      if (result.valid_rows > 0) {
        let rowsHtml = '<table><thead><tr><th>Nome</th><th>Matrícula</th><th>CPF</th><th>E-mail</th><th>Carga Horária</th><th>Ação</th></tr></thead><tbody>';
        result.rows.forEach((r) => {
          rowsHtml += `<tr><td>${r.name}</td><td>${r.matricula}</td><td>${r.cpf}</td><td>${r.email || "—"}</td><td>${r.carga_horaria}h</td><td>${r.action === "update" ? "Atualizar" : "Inserir"}</td></tr>`;
        });
        rowsHtml += "</tbody></table>";
        summary.innerHTML += rowsHtml;
        confirmBtn.classList.remove("hidden");
        confirmBtn.onclick = () => confirmImport(result.preview_id);
      } else {
        confirmBtn.classList.add("hidden");
      }
      $("#employeeImportResult").classList.remove("hidden");
      showToast(`Prévia: ${result.valid_rows} válida(s), ${result.invalid_rows} com erro.`);
    })
    .catch((error) => {
      showToast(error.message, true);
    });
}

function confirmImport(previewId) {
  apiFetch("/api/employees/import/confirm", {
    method: "POST",
    body: JSON.stringify({ preview_id: previewId }),
  })
    .then((result) => {
      showToast(`Importação concluída: ${result.inserted} inserido(s), ${result.updated} atualizado(s).`);
      $("#employeeImportResult").classList.add("hidden");
      $("#confirmEmployeeImport").classList.add("hidden");
      loadEmployees();
    })
    .catch((error) => {
      showToast(error.message, true);
    });
}

async function loadAuditoria() {
  const competency = $("#competencySelect").value;
  try {
    const rows = await apiFetch(`/api/timesheets?competency=${encodeURIComponent(competency)}`);
    const tbody = $("#auditoriaTableBody");
    const audited = rows.filter((t) => t.reviewed_at);
    if (!audited.length) {
      tbody.innerHTML = '<tr><td colspan="5"><div class="empty-inline">Nenhum registro de auditoria nesta competência.</div></td></tr>';
      return;
    }
    tbody.innerHTML = audited.map((t) => {
      const dateStr = t.reviewed_at ? new Date(t.reviewed_at).toLocaleDateString("pt-BR") : "—";
      return `<tr>
        <td>${t.id}</td>
        <td>${t.name}</td>
        <td><span class="status-pill ${statusClass(t.status)}">${t.status_label || statusLabel(t.status)}</span></td>
        <td>${t.competencia}</td>
        <td>${dateStr}</td>
      </tr>`;
    }).join("");
  } catch (error) {
    showToast(error.message, true);
  }
}

async function login(username, password) {
  try {
    const result = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    authToken = result.access_token;
    currentUser = result.user;
    localStorage.setItem("authToken", authToken);
    localStorage.setItem("currentUser", JSON.stringify(currentUser));
    updateUserInfo();
    showView("dashboard");
    await loadData();
    showToast(`Bem-vindo, ${currentUser.full_name || currentUser.username}!`);
  } catch (error) {
    const errEl = $("#loginError");
    errEl.textContent = error.message;
    errEl.classList.remove("hidden");
  }
}

async function logout() {
  if (authToken) {
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
    } catch (e) {}
  }
  authToken = null;
  currentUser = null;
  localStorage.removeItem("authToken");
  localStorage.removeItem("currentUser");
  showView("login");
}

function initApp() {
  const storedToken = localStorage.getItem("authToken");
  const storedUser = localStorage.getItem("currentUser");
  if (storedToken && storedUser) {
    authToken = storedToken;
    try {
      currentUser = JSON.parse(storedUser);
    } catch (e) {
      currentUser = null;
      authToken = null;
      localStorage.removeItem("authToken");
      localStorage.removeItem("currentUser");
    }
  }

  if (currentUser && authToken) {
    updateUserInfo();
    showView("dashboard");
    loadData();
  } else {
    showView("login");
  }

  $$("[data-view]").forEach((item) => item.addEventListener("click", () => {
    const view = item.dataset.view;
    if (view === "arquivo") loadArchive();
    if (view === "envios") loadDispatches();
    if (view === "servidores") loadEmployees();
    if (view === "auditoria") loadAuditoria();
    if (view === "novo-lote") showView("novo-lote");
    showView(view);
  }));
  $$("[data-view-target]").forEach((item) => item.addEventListener("click", () => {
    const view = item.dataset.viewTarget;
    if (view === "arquivo") loadArchive();
    if (view === "envios") loadDispatches();
    if (view === "servidores") loadEmployees();
    if (view === "auditoria") loadAuditoria();
    showView(view);
  }));

  $("#confirmButton").addEventListener("click", () => reviewAction("confirm"));
  $("#pendingButton").addEventListener("click", () => reviewAction("pending"));
  $("#rejectButton").addEventListener("click", () => reviewAction("reject"));
  $("#mobileMenu").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
  $("#backToDashboard").addEventListener("click", () => showView("dashboard"));
  $("#newBatchButton").addEventListener("click", () => showView("novo-lote"));
  $("#uploadOcrButton").addEventListener("click", () => showView("novo-lote"));
  $("#batchFileInput").addEventListener("change", uploadBatch);
  $("#newBatchModuleButton").addEventListener("click", () => $("#batchFileInput").click());
  $(".notice-close").addEventListener("click", (event) => event.currentTarget.closest(".demo-notice").remove());

  $("#competencySelect").addEventListener("change", async (event) => {
    showToast(`Competência alterada para ${event.target.value}.`);
    await Promise.all([loadDashboard(), loadQueue()]);
  });

  $("#ocrForm").addEventListener("submit", (event) => event.preventDefault());
  $("#aboutButton").addEventListener("click", () => $("#aboutModal").classList.remove("hidden"));
  $("#aboutClose").addEventListener("click", () => $("#aboutModal").classList.add("hidden"));
  $("#aboutModal").addEventListener("click", (event) => {
    if (event.target.id === "aboutModal") $("#aboutModal").classList.add("hidden");
  });

  $("#logoutButton").addEventListener("click", async () => {
    await logout();
    showToast("Você saiu do sistema.");
  });

  $("#togglePassword").addEventListener("click", () => {
    const password = $("#loginPassword");
    const visible = password.type === "text";
    password.type = visible ? "password" : "text";
    $("#togglePassword").textContent = visible ? "Mostrar" : "Ocultar";
  });

  $("#loginForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const username = $("#loginUser").value.trim();
    const password = $("#loginPassword").value.trim();
    if (!username || !password) {
      $("#loginError").classList.remove("hidden");
      return;
    }
    $("#loginError").classList.add("hidden");
    login(username, password);
  });

  $("#archiveStatusFilter").addEventListener("change", () => loadArchive());
  if ($("#archiveSearchInput")) {
    let archiveSearchTimeout;
    $("#archiveSearchInput").addEventListener("input", () => {
      clearTimeout(archiveSearchTimeout);
      archiveSearchTimeout = setTimeout(() => loadArchive(), 300);
    });
  }

  $("#dispatchStatusFilter").addEventListener("change", () => loadDispatches());

  $("#employeeImportForm").addEventListener("submit", handleImportPreview);

  document.addEventListener("keydown", (event) => {
    if ($("#ocrView").classList.contains("hidden")) return;
    if (event.key === "ArrowDown") { event.preventDefault(); selectQueue(Math.min(selectedIndex + 1, queueData.length - 1)); }
    if (event.key === "ArrowUp") { event.preventDefault(); selectQueue(Math.max(selectedIndex - 1, 0)); }
  });
}

initApp();
