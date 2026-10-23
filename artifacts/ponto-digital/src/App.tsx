import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation } from 'wouter';
import {
  Activity, AlertCircle, Archive, CalendarDays, Check, ChevronRight, Clock3,
  FileCheck2, FileSpreadsheet, FileText, FolderOpen, History, LayoutDashboard, LockKeyhole,
  Mail, Menu, Pencil, Plus, Search, Send, Settings2, ShieldCheck, Trash2, Upload, Users, X,
} from 'lucide-react';
import {
  getGetDashboardQueryKey, getGetLockStateQueryKey, getGetSmtpSettingsQueryKey, getGetTimesheetFileQueryKey,
  getListAuditQueryKey, getListCalendarDatesQueryKey, getListCompetenciesQueryKey, getListDispatchesQueryKey,
  getListEmployeesQueryKey, getListTimesheetsQueryKey,
  useCreateCalendarDate, useCreateEmployee, useDeleteCalendarDate, useDeleteEmployee,
  useGetDashboard, useGetLockState, useGetSmtpSettings, useGetTimesheetFile,
  useHeartbeatLock, useImportCalendar, useImportEmployees, useListAudit, useListCalendarDates,
  useListCompetencies, useListDispatches, useListEmployees, useListTimesheets, usePreviewBatch,
  usePreviewCalendarImport, usePreviewEmployeeImport, useProcessBatch, useReleaseLock,
  useResendDispatch, useReviewTimesheet, useSendDispatch, useSendDispatchBatch,
  useTestSmtpSettings, useUpdateCalendarDate, useUpdateEmployee, useUpdateSmtpSettings,
} from '@workspace/api-client-react';
import type { Employee, CalendarEvent, Timesheet, Dispatch, AuditEvent, SmtpSettingsInput } from '@workspace/api-client-react';

type Page = 'inicio' | 'folhas' | 'servidores' | 'calendario' | 'envios' | 'configuracoes' | 'auditoria';
const paths: Record<Page, string> = { inicio: '/', folhas: '/folhas', servidores: '/servidores', calendario: '/calendario', envios: '/envios', configuracoes: '/configuracoes', auditoria: '/auditoria' };
const titles: Record<Page, string> = { inicio: 'Visão geral', folhas: 'Folhas de ponto', servidores: 'Servidores', calendario: 'Calendário acadêmico', envios: 'Despachos', configuracoes: 'Configurações', auditoria: 'Auditoria' };
const navigation: { page: Page; icon: typeof LayoutDashboard; group: string }[] = [
  { page: 'inicio', icon: LayoutDashboard, group: 'Operação' },
  { page: 'folhas', icon: FileCheck2, group: 'Operação' },
  { page: 'servidores', icon: Users, group: 'Cadastros' },
  { page: 'calendario', icon: CalendarDays, group: 'Cadastros' },
  { page: 'envios', icon: Send, group: 'Comunicação' },
  { page: 'configuracoes', icon: Settings2, group: 'Sistema' },
  { page: 'auditoria', icon: History, group: 'Sistema' },
];
const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 15000, retry: 1 } } });
const monthNow = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const isoDate = (d: Date | string | null | undefined) => {
  if (!d) return '-';
  // Datas puras (AAAA-MM-DD), como as do calendário, não têm fuso: converter
  // para Date e formatar em UTC-3 mostrava 31/12/2026 para 2027-01-01.
  if (typeof d === 'string') {
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
    if (dateOnly) return `${dateOnly[3]}/${dateOnly[2]}/${dateOnly[1]}`;
  }
  const date = new Date(d);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
};
const initials = (s: string) => s.split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0]).join('').toUpperCase();
const LOCK_HELD_MESSAGE = 'Sistema em uso por outro usuário.';
const LOCK_EXPIRED_MESSAGE = 'A sessão de edição expirou. Atualize a página para retomar.';
const errorMessage = (e: unknown) => {
  if (typeof e === 'object' && e !== null) {
    const failure = e as { status?: number; data?: { message?: unknown } | null };
    const detail = typeof failure.data?.message === 'string' && failure.data.message.trim() ? failure.data.message.trim() : '';
    if (failure.status === 423) return detail || LOCK_HELD_MESSAGE;
    if (detail) return detail;
  }
  return e instanceof Error ? e.message : 'Não foi possível concluir a operação.';
};

function AppFrame() {
  const [location, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const [menuOpen, setMenuOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [competency, setCompetency] = useState(monthNow());
  const [sessionId] = useState(() => {
    const existing = localStorage.getItem('digep-session-id');
    if (existing) return existing;
    const id = `digep-${crypto.randomUUID()}`;
    localStorage.setItem('digep-session-id', id);
    return id;
  });
  const lockParams = { sessionId };
  const lockKey = getGetLockStateQueryKey(lockParams);
  const lockQuery = useGetLockState(lockParams, { query: { queryKey: lockKey, refetchInterval: 12000 } });
  const heartbeat = useHeartbeatLock();
  const release = useReleaseLock();
  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 3800);
    // Erro 423 da trava: reconsulta o estado para refletir o bloqueio/liberação no banner.
    if (message === LOCK_HELD_MESSAGE || message === LOCK_EXPIRED_MESSAGE) {
      void queryClient.invalidateQueries({ queryKey: lockKey });
    }
  };
  const currentPage = (Object.entries(paths).find(([, path]) => path === location)?.[0] ?? 'inicio') as Page;
  const lock = lockQuery.data;
  const lockPending = lockQuery.isLoading;
  const lockError = lockQuery.isError;
  const readOnly = lockPending || lockError || !lock?.heldByThisClient;

  useEffect(() => {
    const beat = () => {
      void heartbeat.mutateAsync({ data: { sessionId } })
        .then(() => queryClient.invalidateQueries({ queryKey: lockKey }))
        .catch(() => undefined);
    };
    // Ao voltar o foco/visibilidade, renova imediatamente: o navegador throttliza
    // os timers de abas em segundo plano e o lease de 30s expiraria.
    const recover = () => {
      beat();
      void queryClient.invalidateQueries({ queryKey: lockKey });
    };
    const onVisible = () => { if (document.visibilityState === 'visible') recover(); };
    beat();
    const timer = window.setInterval(beat, 10000);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', recover);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', recover);
      void release.mutateAsync({ data: { sessionId } }).catch(() => undefined);
    };
  // one lease per mounted browser session
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const invalidate = async (...keys: readonly (readonly unknown[])[]) => {
    await Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
  };
  const monthParams = { competency };
  const dashboardQuery = useGetDashboard(monthParams);
  const sheetQuery = useListTimesheets(monthParams);
  const dispatchSummaryQuery = useListDispatches();
  const auditSummaryQuery = useListAudit();
  const metrics = dashboardQuery.data;
  const sheetRows = sheetQuery.data?.items ?? [];
  const dispatchRows = dispatchSummaryQuery.data ?? [];
  const activityRows = (auditSummaryQuery.data?.items ?? []).slice(0, 5);
  const pendingSheets = sheetRows.filter((s) => !['arquivada', 'rejeitada'].includes(s.status));
  const header = <header className="masthead">
    <div className="brand">
      <span className="brand-mark" aria-hidden="true"><i/><i/><i/></span>
      <span className="brand-copy"><b>Ponto Digital DIGEP</b><small>UnDF · Mesa de operações</small></span>
    </div>
    <div className="demo-flag" data-testid="status-demo">Demonstração · sem login · sem envio real</div>
  </header>;
  const nav = <aside className={`sidebar ${menuOpen ? 'open' : ''}`} aria-label="Navegação principal">
    <p className="nav-caption">Navegação</p>
    <div className="nav-list">
      {navigation.map(({ page, icon: Icon }) => <Link key={page} href={paths[page]} className={`nav-item ${currentPage === page ? 'active' : ''}`} data-testid={`nav-${page}`} onClick={() => setMenuOpen(false)}>
        <Icon aria-hidden="true"/><span>{titles[page]}</span>{page === 'folhas' && pendingSheets.length > 0 && <span className="panel-number">{pendingSheets.length}</span>}
      </Link>)}
    </div>
    <div className="nav-foot"><strong>UnDF · DIGEP</strong>Ambiente de demonstração. Utilize somente dados sintéticos.</div>
  </aside>;

  return <div className="app">
    {header}
    <div className="shell">
      {nav}
      <main className="main">
        <div className="topline">
          <div className="topline-left"><span>UnDF</span><span> / </span><strong>{titles[currentPage]}</strong></div>
          <button className="mobile-menu" type="button" aria-label="Abrir navegação" data-testid="button-mobile-menu" onClick={() => setMenuOpen((v) => !v)}><Menu size={17}/></button>
          <div className="topline-right" data-testid="status-lock">
            <span className={`lease-dot ${readOnly ? 'blocked' : ''}`}/>
            <span>{lockPending ? 'Consultando edição' : lockError ? 'Sem resposta da trava de edição' : readOnly ? (lock?.locked ? 'Somente leitura · outra sessão ativa' : 'Renovando trava de edição') : 'Edição disponível nesta sessão'}</span>
            {lock?.expiresAt && <span>· expira {new Date(lock.expiresAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>}
          </div>
        </div>
        {!lockPending && lockError && <div className="read-only" role="alert" data-testid="status-readonly"><AlertCircle size={15} style={{ verticalAlign: 'middle', marginRight: 7 }}/>Não foi possível consultar a trava de edição; os botões de gravação ficam desativados até a conexão voltar. <button className="text-action" style={{ textDecoration: 'underline' }} onClick={() => void lockQuery.refetch()}>Tentar novamente</button></div>}
        {!lockPending && !lockError && readOnly && <div className="read-only" data-testid="status-readonly"><LockKeyhole size={15} style={{ verticalAlign: 'middle', marginRight: 7 }}/>{lock?.locked ? 'Sistema em uso por outro usuário. Consulte os registros; a edição será liberada automaticamente quando a outra sessão encerrar.' : 'A trava de edição desta sessão ainda não foi renovada; os botões ficam disponíveis em instantes.'}</div>}
        {currentPage === 'inicio' && <DashboardPage metrics={metrics} loading={dashboardQuery.isLoading} error={dashboardQuery.isError} competency={competency} setCompetency={setCompetency} sheets={sheetRows} sheetLoading={sheetQuery.isLoading} dispatches={dispatchRows} activity={activityRows} onRetry={() => { void dashboardQuery.refetch(); void sheetQuery.refetch(); }} navigate={(p) => setLocation(paths[p])}/>}
        {currentPage === 'folhas' && <TimesheetsPage competency={competency} setCompetency={setCompetency} readOnly={readOnly} notify={notify} invalidate={invalidate}/>}
        {currentPage === 'servidores' && <EmployeesPage readOnly={readOnly} notify={notify} invalidate={invalidate}/>}
        {currentPage === 'calendario' && <CalendarPage readOnly={readOnly} notify={notify} invalidate={invalidate} competency={competency}/>}
        {currentPage === 'envios' && <DispatchPage readOnly={readOnly} notify={notify} invalidate={invalidate}/>}
         {currentPage === 'configuracoes' && <SettingsPage readOnly={readOnly} notify={notify} invalidate={invalidate}/>}
        {currentPage === 'auditoria' && <AuditPage/>}
      </main>
    </div>
    {toast && <div className="toast" role="status" data-testid="status-toast">{toast}</div>}
  </div>;
}

function PageHead({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description: string; actions?: ReactNode }) {
  return <div className="page-head"><div><p className="overline">{eyebrow}</p><h1>{title}</h1><p className="lede">{description}</p></div>{actions && <div className="head-actions">{actions}</div>}</div>;
}
function Notice({ children }: { children: ReactNode }) {
  return <div className="notice" data-testid="notice-demo"><ShieldCheck/><div><strong>Ambiente demonstrativo, sem autenticação</strong>{children}</div></div>;
}
function LoadingTable({ rows = 4 }: { rows?: number }) { return <div aria-label="Carregando dados" data-testid="loading-state">{Array.from({ length: rows }, (_, i) => <div key={i} className="skeleton"/>)}</div>; }
function ErrorState({ onRetry }: { onRetry: () => void }) { return <div className="empty" data-testid="error-state"><AlertCircle/><strong>Não foi possível carregar os dados</strong><p>Confira a conexão com o serviço e tente novamente.</p><button className="button secondary" onClick={onRetry}>Tentar novamente</button></div>; }
function Empty({ icon: Icon = FolderOpen, title, copy }: { icon?: typeof FolderOpen; title: string; copy: string }) {
  return <div className="empty" data-testid="empty-state"><Icon/><strong>{title}</strong><p>{copy}</p></div>;
}
function Pill({ children, tone = '' }: { children: ReactNode; tone?: string }) { return <span className={`pill ${tone}`} data-testid="status-pill">{children}</span>; }
function DataTable({ children, headers, minWidth }: { children: ReactNode; headers: string[]; minWidth?: number }) {
  return <div className="table-card"><div className="table-scroll"><table style={minWidth ? { minWidth } : undefined}><thead><tr>{headers.map((h) => <th key={h}>{h}</th>)}</tr></thead><tbody>{children}</tbody></table></div></div>;
}
function CompetencyControl({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const competencies = useListCompetencies();
  const counts = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const item of competencies.data ?? []) {
    counts.set(item.competency, item.count);
    labels.set(item.competency, competencyLabel(item.competency));
  }
  // Meses recentes continuam disponíveis mesmo antes do primeiro envio; as
  // competências do arquivo (inclusive futuras, como 2027-01) vêm da API.
  for (let back = 0; back < 12; back += 1) {
    const date = new Date();
    date.setDate(1);
    date.setMonth(date.getMonth() - back);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    if (!labels.has(key)) labels.set(key, competencyLabel(key));
  }
  if (value && !labels.has(value)) labels.set(value, competencyLabel(value));
  const options = [...labels.keys()].sort().reverse();
  return <label className="field" style={{ minWidth: 160 }}>Competência
    <select value={value} data-testid="select-competency" onChange={(e) => onChange(e.target.value)}>
      {options.map((key) => <option key={key} value={key}>{labels.get(key)}{counts.has(key) ? ` · ${counts.get(key)} folha(s)` : ' · sem folhas'}</option>)}
    </select>
    {competencies.isError && <small className="footer-note">Não foi possível listar as competências arquivadas.</small>}
  </label>;
}

function DashboardPage({ metrics, loading, error, competency, setCompetency, sheets, sheetLoading, dispatches, activity, onRetry, navigate }: {
  metrics?: { total: number; recognized: number; review: number; low_confidence: number; archived: number; recognition_rate: number; dispatch_pending: number; dispatch_sent: number; dispatch_error: number };
  loading: boolean; error: boolean; competency: string; setCompetency: (v: string) => void; sheets: Timesheet[]; sheetLoading: boolean; dispatches: Dispatch[]; activity: AuditEvent[]; onRetry: () => void; navigate: (page: Page) => void;
}) {
  const pending = sheets.filter((s) => !['arquivada','rejeitada'].includes(s.status));
  return <div className="page">
    <PageHead eyebrow="Acompanhamento mensal" title="Bom dia, equipe." description="Uma leitura clara do que chegou, do que pede conferência e do que segue para despacho." actions={<CompetencyControl value={competency} onChange={setCompetency}/>}/>
    <Notice>Este ambiente não possui login. Os registros exibidos vêm exclusivamente da API; nenhum dado sintético é apresentado como registro real. Despachos são simulados.</Notice>
    {error ? <ErrorState onRetry={onRetry}/> : <>
      <div className="metric-grid">
        {[['Folhas recebidas',metrics?.total,'na competência'],['Reconhecidas',metrics?.recognized,'inclui folhas arquivadas'],['Em conferência',metrics?.review,'requer atenção da equipe'],['Baixa confiança',metrics?.low_confidence,'revisão manual recomendada']].map(([label,value,foot],i)=><div className="metric" key={String(label)} data-testid={`metric-${i}`}><label>{label}</label><b>{loading ? '—' : value ?? '—'}</b><small>{foot}</small></div>)}
      </div>
      {!loading && metrics && metrics.total === 0 && <div className="notice" role="status" data-testid="dashboard-empty"><AlertCircle/><div><strong>Nenhuma folha encontrada para esta competência.</strong><p>Envie PDFs em Folhas de ponto ou escolha outra competência no seletor acima.</p></div></div>}
      <div className="grid overview-grid">
        <section className="panel"><div className="panel-heading"><div><h2>Ritmo da competência</h2><p>Volume e revisão · {competency}</p></div><span className="panel-number">{metrics?.recognition_rate ?? 0}%</span></div>
          {loading ? <LoadingTable rows={2}/> : <><div className="progress-top"><strong>{metrics?.recognition_rate ?? 0}%</strong><span>taxa de reconhecimento</span></div><div className="progress-bar"><span style={{width:`${metrics?.recognition_rate ?? 0}%`}}/></div><div className="summary-list"><div className="summary-item"><strong>{metrics?.archived ?? 0}</strong><small>Arquivadas</small></div><div className="summary-item"><strong>{metrics?.review ?? 0}</strong><small>Em revisão</small></div><div className="summary-item"><strong>{metrics?.total ?? 0}</strong><small>Total recebido</small></div></div></>}
          <button className="button secondary" data-testid="button-open-sheets" onClick={()=>navigate('folhas')}>Abrir fila de folhas <ChevronRight/></button>
        </section>
        <section className="panel"><div className="panel-heading"><div><h2>Despachos</h2><p>Histórico demonstrativo, sem envio de e-mail</p></div><Pill tone="warning">SIMULADO</Pill></div>
          {loading ? <LoadingTable rows={2}/> : <div className="dispatch-stats"><div className="dispatch-stat"><strong>{metrics?.dispatch_pending ?? 0}</strong><span>Pendentes</span></div><div className="dispatch-stat"><strong>{metrics?.dispatch_sent ?? 0}</strong><span>Simulados</span></div><div className="dispatch-stat"><strong>{metrics?.dispatch_error ?? 0}</strong><span>Com erro</span></div></div>}
          <button className="button secondary" data-testid="button-open-dispatch" onClick={()=>navigate('envios')}>Ver histórico <ChevronRight/></button>
        </section>
        <section className="panel"><div className="panel-heading"><div><h2>Fila de trabalho</h2><p>Folhas ainda não arquivadas</p></div><span className="panel-number">{pending.length}</span></div>
          {sheetLoading ? <LoadingTable rows={3}/> : pending.length ? <div className="activity">{pending.slice(0,5).map((row)=><div className="activity-row" key={row.id}><span className="activity-dot"/><div><strong>{row.name}</strong><small>{row.matricula ?? 'Matrícula não identificada'} · {row.id}</small></div><Pill tone={row.status==='baixa_confianca'?'warning':''}>{row.status_label}</Pill></div>)}</div> : <Empty icon={FileCheck2} title="Fila sem pendências" copy="Nenhuma folha aguarda conferência para esta competência."/>}
        </section>
        <section className="panel"><div className="panel-heading"><div><h2>Atividade recente</h2><p>Eventos registrados pela API</p></div><Activity size={16} color="#789187"/></div>
          {activity.length ? <div className="activity">{activity.slice(0,5).map((item)=><div className="activity-row" key={`${item.id}-${item.date}`}><span className="activity-dot"/><div><strong>{item.action}</strong><small>{item.name} · {item.competencia}</small></div><time>{isoDate(item.date)}</time></div>)}</div> : <Empty icon={Clock3} title="Ainda sem atividade" copy="A trilha aparecerá aqui quando houver eventos registrados."/>}
        </section>
      </div>
    </>}
  </div>;
}

/** Rótulo curto de competência: AAAA-MM -> MM/AAAA. */
const competencyLabel = (competency: string) => {
  const [year, month] = competency.split('-');
  return year && month ? `${month}/${year}` : competency;
};

/** Rótulos legíveis dos tipos de data especial (o banco guarda o valor técnico). */
const calendarTypeLabels: Record<string, string> = {
  feriado: 'Feriado',
  recesso: 'Recesso acadêmico',
  ponto_facultativo: 'Ponto facultativo',
  suspensao_expediente: 'Suspensão de expediente',
  outro: 'Outro',
};
const calendarTypeLabel = (type: string | null | undefined) => (type ? calendarTypeLabels[type] ?? type : '-');

const competencySourceLabel: Record<string, string> = {
  'conteudo-pdf': 'Texto do PDF',
  'ocr-conteudo-pdf': 'OCR do PDF',
  fallback: 'Competência de referência',
  'nao-identificada': 'Não identificada',
};

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

const selectedEntrySituation = (entry: { duplicate: boolean; duplicateInUpload: boolean; needsReview: boolean }) =>
  entry.duplicate ? 'Duplicado' : entry.duplicateInUpload ? 'Repetido no lote' : entry.needsReview ? 'Precisa revisão' : 'Conferido';

/**
 * Motivo da revisão derivado dos dados persistidos: confiança, origem da
 * competência, matrícula ausente e observação registrada. A tela de revisão
 * precisa explicar por que o documento pede conferência humana.
 */
const reviewReason = (row: Timesheet) => {
  const reasons: string[] = [];
  if ((row.confidence ?? 0) < 85) reasons.push(`confiança de ${row.confidence}%`);
  if (row.competency_source === 'nao-identificada') reasons.push('competência não identificada no PDF');
  if (row.competency_source === 'fallback') reasons.push('competência assumida pela referência');
  if (row.competency_source === 'ocr-conteudo-pdf') reasons.push('leitura feita por OCR');
  if (!row.matricula) reasons.push('matrícula não reconhecida');
  if (row.note) reasons.push(row.note);
  return reasons.length ? reasons.join(' · ') : 'conferência solicitada pela equipe';
};

/** Extrai o nome do arquivo do Content-Disposition (ASCII ou RFC 5987). */
async function fetchGeneratedPdf(employeeId: number, competency: string): Promise<{ blob: Blob; fileName: string }> {
  const response = await fetch(`/api/timesheets/generate?employeeId=${employeeId}&competency=${encodeURIComponent(competency)}`);
  if (!response.ok) {
    let message = response.status === 404 ? 'Servidor não encontrado para gerar a folha.' : 'Não foi possível gerar a folha em PDF.';
    try {
      const body = (await response.json()) as { message?: unknown };
      if (typeof body.message === 'string' && body.message.trim()) message = body.message.trim();
    } catch {
      // resposta sem JSON: mantém a mensagem padrão
    }
    throw new Error(message);
  }
  const blob = await response.blob();
  const disposition = response.headers.get('content-disposition') ?? '';
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  const ascii = /filename="([^"]+)"/i.exec(disposition);
  let fileName = `folha-${employeeId}-${competency}.pdf`;
  if (encoded?.[1]) {
    try { fileName = decodeURIComponent(encoded[1]); } catch { /* usa o padrão */ }
  } else if (ascii?.[1]) {
    fileName = ascii[1];
  }
  return { blob, fileName };
}

/** Visualização embutida do PDF: carrega o arquivo, mostra no iframe e permite baixar. */
function PdfPane({ id, title, fileName }: { id: string; title: string; fileName?: string | null }) {
  const fileQuery = useGetTimesheetFile(id, { query: { queryKey: getGetTimesheetFileQueryKey(id), enabled: Boolean(id), retry: false } });
  const [url, setUrl] = useState('');
  const status = (fileQuery.error as { status?: number } | null)?.status;
  useEffect(() => {
    if (!fileQuery.data) return;
    const objectUrl = URL.createObjectURL(fileQuery.data);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [fileQuery.data]);
  const name = fileName || `folha-${id}.pdf`;
  const download = () => {
    if (!url) return;
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
  };
  return <div className="pdf-pane" data-testid={`pdf-pane-${id}`}>
    <div className="pdf-toolbar">
      <span className="pdf-meta">{name}</span>
      {url && <div className="row-actions">
        <a className="text-action" href={url} target="_blank" rel="noopener noreferrer">Abrir em nova aba</a>
        <button type="button" className="button secondary" onClick={download} data-testid={`button-download-pdf-${id}`}>Baixar PDF</button>
      </div>}
    </div>
    {fileQuery.isLoading && <LoadingTable rows={5}/>}
    {fileQuery.isError && <div className="empty" role="alert" data-testid="pdf-error">
      <AlertCircle/>
      <strong>Não foi possível localizar o PDF deste registro.</strong>
      <p>{errorMessage(fileQuery.error)}</p>
      {status === 404 && <p>O arquivo pode ter sido movido ou removido do armazenamento. Confira os dados na revisão e tente novamente.</p>}
      <button type="button" className="button secondary" onClick={() => void fileQuery.refetch()}>Tentar novamente</button>
    </div>}
    {url && <iframe title={`PDF de ${title}`} src={url} className="pdf-frame" data-testid="pdf-frame"/>}
    {!fileQuery.isLoading && !fileQuery.isError && !url && <p className="footer-note">Preparando a visualização…</p>}
  </div>;
}

function PdfViewerModal({ id, title, fileName, onClose }: { id: string; title: string; fileName?: string | null; onClose: () => void }) {
  return <Modal title="PDF da folha" intro={`${title} · ${fileName || id}`} wide onClose={onClose}>
    <PdfPane id={id} title={title} fileName={fileName}/>
    <div className="modal-actions">
      <button type="button" className="button ghost" onClick={onClose}>Fechar</button>
    </div>
  </Modal>;
}

function GeneratedPdfModal({ url, fileName, employee, competency, onClose }: { url: string; fileName: string; employee: string; competency: string; onClose: () => void }) {
  const download = () => {
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
  };
  return <Modal title="Folha gerada em PDF" intro={`${employee} · ${competencyLabel(competency)} · ${fileName}`} wide onClose={onClose}>
    <iframe title={`PDF de ${employee}`} src={url} className="pdf-frame" data-testid="generated-pdf-frame"/>
    <div className="modal-actions">
      <a className="button secondary" href={url} target="_blank" rel="noopener noreferrer">Abrir em nova aba</a>
      <button type="button" className="button" onClick={download} data-testid="button-download-generated">Baixar PDF</button>
      <button type="button" className="button ghost" onClick={onClose}>Fechar</button>
    </div>
  </Modal>;
}

/**
 * Geração real de PDF (não DOCX), reaproveitada em Folhas de Ponto e no
 * Calendário. A competência é escolhida pelo operador e o calendário daquela
 * competência entra no documento. O resultado abre no visualizador e pode ser
 * baixado com o nome oficial.
 */
function GenerateTimesheetPanel({ readOnly, notify, competency }: { readOnly: boolean; notify: (s: string) => void; competency: string }) {
  const employeesQuery = useListEmployees();
  const employeesList = employeesQuery.data?.items ?? [];
  const [employeeId, setEmployeeId] = useState('');
  const [month, setMonth] = useState(competency);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [generated, setGenerated] = useState<{ url: string; fileName: string; employee: string; competency: string } | null>(null);
  useEffect(() => setMonth(competency), [competency]);
  useEffect(() => () => { if (generated) URL.revokeObjectURL(generated.url); }, [generated]);
  const generate = async () => {
    if (readOnly) return;
    if (!employeeId) { setError('Selecione um servidor cadastrado para gerar a folha.'); return; }
    if (!MONTH_PATTERN.test(month)) { setError('Informe a competência no formato AAAA-MM (mês entre 01 e 12).'); return; }
    const employee = employeesList.find((item) => String(item.id) === employeeId);
    if (!employee) { setError('Selecione um servidor da lista.'); return; }
    setGenerating(true);
    setError('');
    try {
      const { blob, fileName } = await fetchGeneratedPdf(employee.id, month);
      const url = URL.createObjectURL(blob);
      if (generated) URL.revokeObjectURL(generated.url);
      setGenerated({ url, fileName, employee: employee.name, competency: month });
      notify(`Folha gerada em PDF: ${fileName}.`);
    } catch (err) {
      const message = errorMessage(err);
      setError(message);
      notify(message);
    } finally {
      setGenerating(false);
    }
  };
  return <>
    <section className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-heading"><div><h2>Gerar folha em PDF</h2><p>Gera o PDF da competência com o calendário acadêmico aplicado. O arquivo abre para visualização e pode ser baixado.</p></div><FileText size={17} color="#739282"/></div>
      <div className="tools">
        <label className="field" style={{ minWidth: 240 }}>Servidor
          <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} data-testid="select-generate-employee">
            <option value="">{employeesQuery.isLoading ? 'Carregando servidores…' : 'Selecione um cadastro'}</option>
            {employeesList.map((employee) => <option key={employee.id} value={employee.id}>{employee.name} · {employee.matricula}</option>)}
          </select>
        </label>
        <label className="field" style={{ minWidth: 150 }}>Competência
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} data-testid="input-generate-competency"/>
        </label>
        <button type="button" className="button" disabled={readOnly || generating || !employeeId} onClick={() => void generate()} data-testid="button-generate-timesheet">{generating ? 'Gerando PDF…' : 'Gerar PDF'}</button>
      </div>
      {employeesQuery.isError && <p className="footer-note">Não foi possível carregar os servidores. <button type="button" className="text-action" onClick={() => void employeesQuery.refetch()}>Tentar novamente</button></p>}
      {employeesQuery.isSuccess && employeesList.length === 0 && <p className="footer-note">Nenhum servidor cadastrado. Cadastre um servidor em <Link href="/servidores">Servidores</Link> para gerar a folha.</p>}
      {error && <p className="footer-note" role="alert" data-testid="generate-error">{error}</p>}
    </section>
    {generated && <GeneratedPdfModal url={generated.url} fileName={generated.fileName} employee={generated.employee} competency={generated.competency} onClose={() => { URL.revokeObjectURL(generated.url); setGenerated(null); }}/>}
  </>;
}

function TimesheetsPage({ competency, setCompetency, readOnly, notify, invalidate }: { competency: string; setCompetency: (v: string) => void; readOnly: boolean; notify: (s:string)=>void; invalidate: (...keys: readonly (readonly unknown[])[])=>Promise<void> }) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('todos');
  const [files, setFiles] = useState<File[]>([]);
  const [preview, setPreview] = useState<Awaited<ReturnType<ReturnType<typeof usePreviewBatch>['mutateAsync']>> | null>(null);
  const [result, setResult] = useState<Awaited<ReturnType<ReturnType<typeof useProcessBatch>['mutateAsync']>> | null>(null);
  const [selected, setSelected] = useState<Timesheet | null>(null);
  const [reviewName, setReviewName] = useState('');
  const [reviewMatricula, setReviewMatricula] = useState('');
  const [reviewCompetency, setReviewCompetency] = useState('');
  const [reviewNote, setReviewNote] = useState('');
  const [reviewError, setReviewError] = useState('');
  const [pdfSheet, setPdfSheet] = useState<{ id: string; title: string; fileName?: string | null } | null>(null);
  const [downloadingId, setDownloadingId] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const query = useListTimesheets({ competency, q: search || undefined, status: status === 'todos' ? undefined : status });
  const previewBatch = usePreviewBatch();
  const processBatch = useProcessBatch();
  const review = useReviewTimesheet();
  const rows = query.data?.items ?? [];
  const previewErrors = preview && 'errors' in preview && Array.isArray(preview.errors)
    ? preview.errors as Array<{ sourceFilename: string; message: string }>
    : [];
  const openReview = (sheet: Timesheet) => {
    setSelected(sheet);
    setReviewName(sheet.name);
    setReviewMatricula(sheet.matricula ?? '');
    setReviewCompetency(sheet.competencia);
    setReviewNote(sheet.note ?? '');
    setReviewError('');
  };
  const closeReview = () => { setSelected(null); setReviewError(''); };
  const chooseFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(e.target.files ?? []);
    if (selectedFiles.some((file) => file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf'))) {
      notify('Somente arquivos PDF são aceitos para folhas de ponto.'); e.target.value = ''; return;
    }
    setFiles(selectedFiles); setPreview(null); setResult(null);
  };
  const doPreview = async () => {
    if (readOnly) return;
    if (!files.length) { notify('Selecione ao menos um arquivo PDF.'); return; }
    try {
      setResult(null);
      const outcome = await previewBatch.mutateAsync({ data: { files, fallbackCompetency: competency } });
      setPreview(outcome);
    } catch (e) { notify(errorMessage(e)); }
  };
  const doProcess = async () => {
    if (readOnly || !files.length) return;
    const commit = (replaceDuplicates = false, confirmFallback = false) => processBatch.mutateAsync({
      data: {
        files,
        fallbackCompetency: competency,
        ...(replaceDuplicates ? { replaceDuplicates: true } : {}),
        ...(confirmFallback ? { confirmFallback: true } : {}),
      },
    });
    try {
      let outcome;
      try {
        outcome = await commit();
      } catch (error) {
        const failure = typeof error === 'object' && error !== null
          ? (error as { status?: number; data?: { requiresFallbackConfirmation?: boolean; unidentifiedCount?: number } | null })
          : {};
        if (failure.status === 409 && window.confirm('Há folhas repetidas para a mesma pessoa e competência. Substituir as anteriores e guardá-las como OLD?')) {
          outcome = await commit(true);
        } else if (failure.status === 422 && failure.data?.requiresFallbackConfirmation
          && window.confirm(`${failure.data.unidentifiedCount ?? 0} página(s) sem competência identificada no PDF. Arquivar usando a competência de referência ${competency}?`)) {
          // Confirmação explícita do operador para arquivar sem competência identificada.
          outcome = await commit(false, true);
        } else {
          throw error;
        }
      }
      // Se o lote pertence a outro mês, acompanha o mês predominante para que o
      // operador veja imediatamente as folhas recém-arquivadas.
      const tally = new Map<string, number>();
      for (const entry of outcome.entries) tally.set(entry.competency, (tally.get(entry.competency) ?? 0) + 1);
      const detected = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (detected && detected !== competency) setCompetency(detected);
      setResult(outcome);
      setPreview(null);
      setFiles([]);
      if (inputRef.current) inputRef.current.value = '';
      await invalidate(getListTimesheetsQueryKey(), getGetDashboardQueryKey(), getListCompetenciesQueryKey(), getListAuditQueryKey(), getListDispatchesQueryKey());
      notify(`Lote processado: ${outcome.created} novos, ${outcome.updated} atualizados e ${outcome.skipped} ignorados.${outcome.duplicatesInBatch ? ` ${outcome.duplicatesInBatch} repetida(s) dentro do lote.` : ''}${detected && detected !== competency ? ` Competência alterada para ${competencyLabel(detected)}.` : ''}`);
    } catch (e) { notify(errorMessage(e)); }
  };
  const reviewAction = async (action: 'confirm'|'pending'|'reject') => {
    if (!selected || readOnly) return;
    const competencyValue = reviewCompetency.trim();
    if (!MONTH_PATTERN.test(competencyValue)) { setReviewError('Informe a competência no formato AAAA-MM (mês entre 01 e 12).'); return; }
    if (!reviewName.trim()) { setReviewError('O nome do servidor não pode ficar vazio.'); return; }
    setReviewError('');
    try {
      await review.mutateAsync({ id: selected.id, data: { action, name: reviewName.trim(), matricula: reviewMatricula.trim(), competency: competencyValue, note: reviewNote.trim() || undefined } });
      await invalidate(getListTimesheetsQueryKey(), getGetDashboardQueryKey(), getListCompetenciesQueryKey(), getListAuditQueryKey());
      if (competencyValue !== competency) setCompetency(competencyValue);
      notify(action === 'confirm'
        ? `Documento confirmado e arquivado${reviewName.trim() !== selected.name || competencyValue !== selected.competencia ? ' com os dados corrigidos' : ''}.`
        : action === 'pending' ? 'Correção salva; a folha continua em revisão.' : 'Folha rejeitada.');
      closeReview();
    } catch (e) {
      const message = errorMessage(e);
      setReviewError(message);
      notify(message);
    }
  };
  const downloadPdf = async (row: Timesheet) => {
    if (!row.file_url) { notify('Não foi possível localizar o PDF deste registro.'); return; }
    setDownloadingId(row.id);
    try {
      const response = await fetch(`/api/timesheets/${encodeURIComponent(row.id)}/file?download=1`);
      if (!response.ok) throw new Error(response.status === 404 ? 'Não foi possível localizar o PDF deste registro.' : 'Não foi possível baixar o PDF desta folha.');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = row.file_name || `folha-${row.id}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30000);
      notify(`Download iniciado: ${row.file_name || `folha-${row.id}.pdf`}.`);
    } catch (e) {
      notify(errorMessage(e));
    } finally {
      setDownloadingId('');
    }
  };
  return <div className="page">
    <PageHead eyebrow="Recepção · OCR · arquivo" title="Folhas de ponto" description="Receba PDFs, confira o reconhecimento e consulte o arquivo por competência. A fila reflete apenas registros existentes na API." actions={<CompetencyControl value={competency} onChange={setCompetency}/>}/>
    <Notice>Envio estritamente PDF. A leitura OCR é uma sugestão para revisão humana; nenhum arquivo de exemplo ou servidor fictício é criado.</Notice>
    <GenerateTimesheetPanel readOnly={readOnly} notify={notify} competency={competency}/>
    <section className="panel" style={{marginBottom:16}}>
      <div className="panel-heading"><div><h2>Entrada de lote</h2><p>Pré-visualize o reconhecimento antes de gravar as folhas.</p></div><Pill>PDF somente</Pill></div>
      <input ref={inputRef} type="file" accept="application/pdf,.pdf" multiple hidden data-testid="input-timesheet-pdf" onChange={chooseFiles}/>
      <div className="upload-zone"><Upload/><strong>Selecionar PDFs para conferência</strong><p>Arquivos PDF, um ou vários · competência de referência {competencyLabel(competency)}</p><div className="head-actions" style={{justifyContent:'center'}}><button type="button" className="button secondary" disabled={readOnly} onClick={()=>inputRef.current?.click()} data-testid="button-select-pdf">Escolher PDFs</button><button type="button" className="button" disabled={readOnly || !files.length || previewBatch.isPending} onClick={()=>void doPreview()} data-testid="button-preview-batch">{previewBatch.isPending?'Analisando…':'Analisar lote'}</button></div>{files.length>0&&<div className="selected-file" data-testid="selected-pdf-files">{files.map(f=>f.name).join(' · ')} ({files.length})</div>}</div>
      {preview&&<div style={{marginTop:16}} data-testid="batch-preview"><div className="panel-heading"><div><h2>Prévia de reconhecimento</h2><p>{preview.entries.length} página(s) analisada(s) · {preview.reviewCount} requer(em) revisão · {preview.duplicateCount} duplicada(s)</p></div><div className="head-actions"><Pill>{preview.newCount} novas</Pill><Pill tone="warning">{preview.duplicateCount} duplicadas</Pill>{preview.unidentifiedCount>0&&<Pill tone="error">{preview.unidentifiedCount} sem competência identificada</Pill>}</div></div>
        {preview.unidentifiedCount>0&&<div className="notice" role="alert" data-testid="notice-unidentified-competency"><AlertCircle/><div><strong>Competência não identificada</strong><p>{preview.unidentifiedCount} página(s) não trazem a competência no PDF. Confirme o uso da competência de referência {competencyLabel(competency)} para arquivar.</p></div></div>}
        {previewErrors.length>0&&<div className="notice" role="alert"><AlertCircle/><div><strong>Arquivos não processados</strong>{previewErrors.map((error)=><p key={error.sourceFilename}>{error.sourceFilename}: {error.message}</p>)}</div></div>}
        {(preview.fileResults ?? []).length>0&&<DataTable headers={['Arquivo','Páginas','Leitura','Detalhe']}><>{(preview.fileResults ?? []).map((file)=><tr key={file.sourceFilename}><td>{file.sourceFilename}</td><td>{file.pages}</td><td><Pill tone={file.status==='erro'?'error':'success'}>{file.status==='erro'?'Erro de leitura':'Processado'}</Pill></td><td>{file.message||'—'}</td></tr>)}</></DataTable>}
        {preview.entries.length>0
          ? <DataTable headers={['Arquivo / página','Servidor reconhecido','Matrícula','Competência','Confiança','Origem','Situação']}><>{preview.entries.map((entry,i)=><tr key={`${entry.sourceFilename}-${entry.pageNumber}-${i}`} data-testid={`preview-entry-${i}`}><td>{entry.sourceFilename} · p. {entry.pageNumber}</td><td>{entry.name}</td><td className="mono">{entry.matricula??'—'}</td><td>{competencyLabel(entry.competency)}{!entry.competencyDetected&&<small className="footer-note"> · referência</small>}</td><td>{entry.confidence}%</td><td>{competencySourceLabel[entry.competencySource]??entry.competencySource}{entry.ocrApplied&&<small className="footer-note"> · OCR</small>}{entry.ocrUnavailable&&<small className="footer-note"> · OCR indisponível</small>}</td><td><Pill tone={entry.duplicate||entry.duplicateInUpload||entry.needsReview?'warning':'success'}>{selectedEntrySituation(entry)}</Pill>{entry.duplicateReason&&<small className="footer-note"> {entry.duplicateReason}</small>}</td></tr>)}</></DataTable>
          : <Empty icon={FileText} title="Nenhuma página pôde ser lida" copy="Os arquivos selecionados não produziram texto reconhecível. Confira se os PDFs estão íntegros ou se são digitalizações que dependem de OCR."/>}
        <div className="modal-actions"><button type="button" className="button secondary" onClick={()=>{setPreview(null);setFiles([]);if(inputRef.current)inputRef.current.value='';}}>Cancelar</button><button type="button" className="button" disabled={readOnly||processBatch.isPending||!preview.entries.length} onClick={()=>void doProcess()} data-testid="button-confirm-batch">{processBatch.isPending?'Arquivando…':'Confirmar e arquivar lote'}</button></div>
      </div>}
      {result&&<section className="panel" style={{marginTop:16}} data-testid="batch-result">
        <div className="panel-heading"><div><h2>Resultado do processamento</h2><p>{result.created} novo(s) · {result.updated} atualizado(s) · {result.skipped} ignorado(s) · {result.duplicatesInBatch} repetido(s) dentro do lote</p></div><div className="head-actions"><button type="button" className="button secondary" onClick={()=>{setStatus('revisao');setResult(null);}} data-testid="button-result-review">Ver folhas para revisão</button><button type="button" className="button ghost" onClick={()=>setResult(null)}>Fechar resumo</button></div></div>
        {(result.fileResults ?? []).length>0&&<DataTable headers={['Arquivo','Páginas','Resultado','Detalhe']}><>{(result.fileResults ?? []).map((file)=><tr key={`file-${file.sourceFilename}`}><td>{file.sourceFilename}</td><td>{file.pages}</td><td><Pill tone={file.status==='erro'?'error':'success'}>{file.status==='erro'?'Com erro':'Processado'}</Pill></td><td>{file.message||'—'}</td></tr>)}</></DataTable>}
        {result.entries.length>0&&<DataTable headers={['Arquivo / página','Servidor','Competência','Situação']}><>{result.entries.map((entry,i)=><tr key={`result-${entry.sourceFilename}-${entry.pageNumber}-${i}`}><td>{entry.sourceFilename} · p. {entry.pageNumber}</td><td>{entry.name}</td><td>{competencyLabel(entry.competency)}</td><td><Pill tone={entry.duplicate||entry.duplicateInUpload?'warning':entry.needsReview?'warning':'success'}>{selectedEntrySituation(entry)}</Pill></td></tr>)}</></DataTable>}
        {(result.skippedDetails ?? []).length>0&&<div style={{marginTop:10}}><p className="footer-note"><strong>Itens ignorados</strong></p><DataTable headers={['Arquivo / página','Servidor','Competência','Motivo']}><>{(result.skippedDetails ?? []).map((item,index)=><tr key={`skip-${item.sourceFilename}-${item.pageNumber}-${index}`}><td>{item.sourceFilename} · p. {item.pageNumber}</td><td>{item.name}</td><td>{competencyLabel(item.competency)}</td><td>{item.reason}</td></tr>)}</></DataTable></div>}
        {result.errors.length>0&&<div className="notice" role="alert" style={{marginTop:10}}><AlertCircle/><div><strong>Erros no processamento</strong>{result.errors.map((error)=><p key={error.sourceFilename}>{error.sourceFilename}: {error.message}</p>)}</div></div>}
      </section>}
    </section>
    <div className="toolbar"><p><strong>Arquivo e revisão</strong> · {rows.length} folha(s) nesta consulta · {competencyLabel(competency)}</p><div className="tools"><label className="field"><span className="sr-only">Buscar folhas</span><input className="search" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Buscar nome, matrícula, CPF ou ID" data-testid="search-timesheets"/></label><select className="field-control" value={status} onChange={e=>setStatus(e.target.value)} data-testid="filter-timesheet-status"><option value="todos">Todos os status</option><option value="revisao">Revisão necessária</option><option value="pendente">Pendente</option><option value="baixa_confianca">Baixa confiança</option><option value="reconhecida">Reconhecida</option><option value="arquivada">Arquivada</option><option value="rejeitada">Rejeitada</option></select>{(search||status!=='todos')&&<button type="button" className="button ghost" onClick={()=>{setSearch('');setStatus('todos');}} data-testid="button-clear-timesheet-filters">Limpar filtros</button>}</div></div>
    {query.isError?<ErrorState onRetry={()=>void query.refetch()}/>:query.isLoading?<LoadingTable/>:rows.length?<DataTable headers={['Folha','Servidor reconhecido','Matrícula','Confiança OCR','Status','Conferida em','Ações']}><>{rows.map(row=><tr key={row.id} data-testid={`timesheet-row-${row.id}`}><td className="mono">{row.id}<br/><span style={{fontFamily:'var(--font-sans)',color:'#899690'}}>{competencyLabel(row.competencia)}<br/>{row.file_name ?? ''}</span></td><td><div className="person"><span className="person-mark">{initials(row.name)}</span>{row.name}</div></td><td className="mono">{row.matricula??'—'}</td><td>{row.confidence}%</td><td><Pill tone={row.status==='arquivada'||row.status==='reconhecida'?'success':row.status==='rejeitada'?'error':'warning'}>{row.status_label}</Pill></td><td>{isoDate(row.reviewed_at)}</td><td><div className="row-actions"><button type="button" className="text-action" onClick={()=>setPdfSheet({id:row.id,title:row.name,fileName:row.file_name})} disabled={!row.file_url} data-testid={`button-pdf-${row.id}`}>Visualizar</button><button type="button" className="text-action" onClick={()=>void downloadPdf(row)} disabled={!row.file_url||downloadingId===row.id} data-testid={`button-download-${row.id}`}>{downloadingId===row.id?'Baixando…':'Baixar'}</button><button type="button" className="text-action" onClick={()=>openReview(row)} data-testid={`button-review-${row.id}`}>Revisar</button></div></td></tr>)}</></DataTable>:<Empty icon={Archive} title="Nenhuma folha encontrada para esta competência." copy={`Não há folhas para ${competencyLabel(competency)} com os filtros atuais. Envie PDFs para análise ou escolha outra competência.`}/>}
    {pdfSheet&&<PdfViewerModal id={pdfSheet.id} title={pdfSheet.title} fileName={pdfSheet.fileName} onClose={()=>setPdfSheet(null)}/>}
    {selected&&<Modal title="Revisar documento" intro={`${selected.id} · ${competencyLabel(selected.competencia)} · confiança ${selected.confidence}%`} wide onClose={closeReview}>
      <div className="review-layout">
        <PdfPane id={selected.id} title={selected.name} fileName={selected.file_name}/>
        <form onSubmit={(e)=>{e.preventDefault();void reviewAction('confirm');}}>
          <p className="footer-note" data-testid="review-detection"><strong>Origem da competência:</strong> {competencySourceLabel[selected.competency_source ?? ''] ?? 'não registrada'} · <strong>Confiança:</strong> {selected.confidence}%</p>
          <p className="footer-note" data-testid="review-reason"><strong>Motivo da revisão:</strong> {reviewReason(selected)}</p>
          <div className="form-grid" style={{marginTop:12}}>
            <label className="field span-2">Nome reconhecido<input value={reviewName} onChange={e=>setReviewName(e.target.value)} data-testid="input-review-name"/></label>
            <label className="field">Matrícula<input value={reviewMatricula} onChange={e=>setReviewMatricula(e.target.value)} data-testid="input-review-matricula"/></label>
            <label className="field">Competência<input type="month" value={reviewCompetency} onChange={e=>setReviewCompetency(e.target.value)} data-testid="input-review-competency"/></label>
            <label className="field span-2">Observação<textarea value={reviewNote} onChange={e=>setReviewNote(e.target.value)} placeholder="Anotações da conferência" data-testid="input-review-note"/></label>
          </div>
          <p className="footer-note">Ao confirmar, o arquivo é renomeado para o padrão oficial ({`Nome_do_servidor-AAAA-MM.pdf`}) e movido para a pasta da competência corrigida.</p>
          {reviewError&&<p className="footer-note" role="alert" data-testid="review-error">{reviewError}</p>}
          <div className="modal-actions"><button type="button" className="button danger" disabled={readOnly||review.isPending} onClick={()=>void reviewAction('reject')}>Rejeitar</button><button type="button" className="button secondary" disabled={readOnly||review.isPending} onClick={()=>void reviewAction('pending')} data-testid="button-save-review">{review.isPending?'Salvando…':'Salvar correção'}</button><button type="submit" className="button" disabled={readOnly||review.isPending} data-testid="button-confirm-review"><Check size={14}/> {review.isPending?'Confirmando…':'Confirmar documento'}</button></div>
        </form>
      </div>
    </Modal>}
  </div>;
}

function Modal({ title, intro, children, onClose, wide = false }: { title:string; intro:string; children:ReactNode; onClose:()=>void; wide?:boolean }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><section className={`modal ${wide ? 'wide-modal' : ''}`} role="dialog" aria-modal="true" aria-labelledby="modal-title"><button className="text-action" style={{float:'right'}} aria-label="Fechar" onClick={onClose}><X size={18}/></button><h2 id="modal-title">{title}</h2><p className="modal-intro">{intro}</p>{children}</section></div>;
}

function EmployeesPage({ readOnly, notify, invalidate }: {readOnly:boolean;notify:(s:string)=>void;invalidate:(...keys:readonly (readonly unknown[])[])=>Promise<void>}) {
  const [search,setSearch]=useState('');
  const [editing,setEditing]=useState<Employee|null|false>(false);
  const [form,setForm]=useState({name:'',matricula:'',cpf:'',email:'',cargo:'',workloadHours:'40',accumulatesRole:false});
  const [file,setFile]=useState<File|null>(null);
  const [importPreview,setImportPreview]=useState<Awaited<ReturnType<ReturnType<typeof usePreviewEmployeeImport>['mutateAsync']>>|null>(null);
  const inputRef=useRef<HTMLInputElement>(null);
  const query=useListEmployees({q:search||undefined});
  const create=useCreateEmployee(); const update=useUpdateEmployee(); const remove=useDeleteEmployee();
  const previewImport=usePreviewEmployeeImport(); const importEmployees=useImportEmployees();
  const rows=query.data?.items??[];
  const openNew=()=>{setForm({name:'',matricula:'',cpf:'',email:'',cargo:'',workloadHours:'40',accumulatesRole:false});setEditing(null);};
  const openEdit=(e:Employee)=>{setForm({name:e.name,matricula:e.matricula,cpf:'',email:e.email,cargo:e.cargo,workloadHours:String(e.carga_horaria),accumulatesRole:e.acumula});setEditing(e);};
  const save=async(e:FormEvent)=>{e.preventDefault();if(readOnly)return;const base={name:form.name,matricula:form.matricula,email:form.email,cargo:form.cargo,workloadHours:Number(form.workloadHours),accumulatesRole:form.accumulatesRole};const data=editing?{...base,...(form.cpf.trim()?{cpf:form.cpf}: {})}:{...base,cpf:form.cpf};try{if(editing){await update.mutateAsync({id:editing.id,data});notify('Cadastro atualizado.');}else{await create.mutateAsync({data});notify('Servidor cadastrado.');}await invalidate(getListEmployeesQueryKey());setEditing(false);}catch(err){notify(errorMessage(err));}};
  const stageFile=(e:React.ChangeEvent<HTMLInputElement>)=>{const next=e.target.files?.[0]??null;if(next&&!/\.(xlsx|xls)$/i.test(next.name)){notify('Selecione uma planilha .xlsx ou .xls.');e.target.value='';return;}setFile(next);setImportPreview(null);};
  const validateImport=async()=>{if(!file)return notify('Selecione uma planilha.');if(readOnly)return;try{setImportPreview(await previewImport.mutateAsync({data:{file}}));}catch(err){notify(errorMessage(err));}};
  const confirmImport=async()=>{if(!file||readOnly)return;try{const result=await importEmployees.mutateAsync({data:{file}});await invalidate(getListEmployeesQueryKey());notify(`Importação concluída: ${result.imported} novos, ${result.updated} atualizados, ${result.skipped} ignorados.`);setImportPreview(null);setFile(null);if(inputRef.current)inputRef.current.value='';}catch(err){notify(errorMessage(err));}};
  const deleteRow=async(row:Employee)=>{if(readOnly)return;if(!window.confirm(`Desativar o cadastro de ${row.name}?`))return;try{await remove.mutateAsync({id:row.id});await invalidate(getListEmployeesQueryKey());notify('Cadastro desativado.');}catch(err){notify(errorMessage(err));}};
  return <div className="page">
    <PageHead eyebrow="Base cadastral" title="Servidores" description="Pesquise os cadastros retornados pela API, registre alterações ou valide uma planilha antes da importação." actions={<button className="button" disabled={readOnly} onClick={openNew} data-testid="button-new-employee"><Plus/>Novo cadastro</button>}/>
    <Notice>Cadastros podem conter dados pessoais. Trabalhe somente com registros sintéticos de demonstração; nenhum servidor é pré-carregado.</Notice>
    <section className="panel" style={{marginBottom:15}}><div className="panel-heading"><div><h2>Importação de planilha</h2><p>Validação e resumo antes de gravar. Os dados vêm do arquivo selecionado.</p></div><FileSpreadsheet size={17} color="#739282"/></div><div className="tools"><input ref={inputRef} type="file" hidden accept=".xlsx,.xls" onChange={stageFile} data-testid="input-employee-import"/><button className="button secondary" disabled={readOnly} onClick={()=>inputRef.current?.click()} data-testid="button-choose-employee-import"><Upload/>Escolher planilha</button><span className="selected-file" style={{margin:0}}>{file?.name??'Nenhum arquivo selecionado · .xlsx ou .xls'}</span><button className="button" disabled={!file||readOnly||previewImport.isPending} onClick={()=>void validateImport()} data-testid="button-preview-employee-import">{previewImport.isPending?'Validando…':'Validar arquivo'}</button></div>
      {importPreview&&<div className="summary-list" data-testid="employee-import-preview"><div className="summary-item"><strong>{importPreview.newCount}</strong><small>Novos</small></div><div className="summary-item"><strong>{importPreview.updatedCount}</strong><small>Atualizações</small></div><div className="summary-item"><strong>{importPreview.skippedCount}</strong><small>Duplicados</small></div><div className="summary-item"><strong>{importPreview.errorCount}</strong><small>Com erro</small></div><button className="button" disabled={readOnly||importEmployees.isPending} onClick={()=>void confirmImport()}>{importEmployees.isPending?'Importando…':'Confirmar importação'}</button><button className="button secondary" onClick={()=>setImportPreview(null)}>Cancelar</button></div>}
    </section>
    <div className="toolbar"><p><strong>Cadastros retornados</strong> · {rows.length} registro(s)</p><div className="tools"><Search size={15} color="#8a9991"/><input className="search" placeholder="Nome, matrícula ou CPF" value={search} onChange={e=>setSearch(e.target.value)} data-testid="search-employees"/></div></div>
    {query.isError?<ErrorState onRetry={()=>void query.refetch()}/>:query.isLoading?<LoadingTable/>:rows.length?<DataTable headers={['Matrícula','Servidor','Cargo','Carga horária','Acumula','E-mail','Ações']}><>{rows.map(row=><tr key={row.id} data-testid={`employee-row-${row.id}`}><td className="mono">{row.matricula}</td><td><div className="person"><span className="person-mark">{initials(row.name)}</span>{row.name}</div><small style={{color:'#8b9690',marginLeft:37}}>{row.cpf}</small></td><td>{row.cargo||'—'}</td><td>{row.carga_horaria} h</td><td>{row.acumula?<Pill tone="success">Sim</Pill>:<Pill>Não</Pill>}</td><td>{row.email||'—'}</td><td><div className="row-actions"><button className="text-action" disabled={readOnly} onClick={()=>openEdit(row)} data-testid={`button-edit-employee-${row.id}`}><Pencil size={13}/> Editar</button><button className="text-action" disabled={readOnly} onClick={()=>void deleteRow(row)} data-testid={`button-delete-employee-${row.id}`}><Trash2 size={13}/> Desativar</button></div></td></tr>)}</></DataTable>:<Empty icon={Users} title="Nenhum servidor cadastrado" copy="A base da demonstração está vazia. Cadastre um registro sintético ou importe uma planilha autorizada."/>}
    {editing!==false&&<Modal title={editing?'Editar cadastro':'Novo servidor'} intro="As informações serão enviadas à API e não são armazenadas localmente." onClose={()=>setEditing(false)}><form onSubmit={save}><div className="form-grid"><label className="field span-2">Nome completo<input required value={form.name} onChange={e=>setForm({...form,name:e.target.value})} data-testid="input-employee-name"/></label><label className="field">Matrícula<input required value={form.matricula} onChange={e=>setForm({...form,matricula:e.target.value})} data-testid="input-employee-matricula"/></label><label className="field">CPF{editing&&<small> deixe em branco para manter o CPF já salvo</small>}<input value={form.cpf} onChange={e=>setForm({...form,cpf:e.target.value})} data-testid="input-employee-cpf"/></label><label className="field">E-mail<input type="email" value={form.email} onChange={e=>setForm({...form,email:e.target.value})} data-testid="input-employee-email"/></label><label className="field">Cargo<input value={form.cargo} onChange={e=>setForm({...form,cargo:e.target.value})} data-testid="input-employee-role"/></label><label className="field">Carga horária<input type="number" min="1" max="100" value={form.workloadHours} onChange={e=>setForm({...form,workloadHours:e.target.value})} data-testid="input-employee-hours"/></label><label className="field" style={{display:'flex',alignItems:'center',gap:8,paddingTop:20}}><input type="checkbox" checked={form.accumulatesRole} onChange={e=>setForm({...form,accumulatesRole:e.target.checked})} data-testid="input-employee-accumulates"/>Acumula cargo</label></div><div className="modal-actions"><button type="button" className="button secondary" onClick={()=>setEditing(false)}>Cancelar</button><button className="button" disabled={readOnly||create.isPending||update.isPending} data-testid="button-save-employee">Salvar cadastro</button></div></form></Modal>}
  </div>;
}

function CalendarPage({ readOnly, notify, invalidate, competency }: {readOnly:boolean;notify:(s:string)=>void;invalidate:(...keys:readonly (readonly unknown[])[])=>Promise<void>;competency:string}) {
  const [editing,setEditing]=useState<CalendarEvent|null|false>(false);
  const [form,setForm]=useState<{date:string;description:string;type:CalendarEvent['type']}>({date:'',description:'',type:'outro'});
  const [file,setFile]=useState<File|null>(null);
  const [preview,setPreview]=useState<Awaited<ReturnType<ReturnType<typeof usePreviewCalendarImport>['mutateAsync']>>|null>(null);
  const calendar=useListCalendarDates();
  const create=useCreateCalendarDate();
  const update=useUpdateCalendarDate();
  const remove=useDeleteCalendarDate();
  const previewImport=usePreviewCalendarImport();
  const importDates=useImportCalendar();
  const rows=calendar.data??[];
  const openNew=()=>{setForm({date:'',description:'',type:'outro'});setEditing(null);};
  const openEdit=(row:CalendarEvent)=>{setForm({date:row.date.slice(0,10),description:row.description,type:row.type});setEditing(row);};
  const save=async(event:FormEvent)=>{event.preventDefault();if(readOnly)return;try{if(editing){await update.mutateAsync({id:editing.id,data:form});notify('Data especial atualizada.');}else{await create.mutateAsync({data:form});notify('Data especial cadastrada.');}await invalidate(getListCalendarDatesQueryKey());setEditing(false);}catch(error){notify(errorMessage(error));}};
  const stageFile=(event:React.ChangeEvent<HTMLInputElement>)=>{const next=event.target.files?.[0]??null;if(next&&!/\.(xlsx|xls)$/i.test(next.name)){notify('Selecione uma planilha .xlsx ou .xls.');event.target.value='';return;}setFile(next);setPreview(null);};
  const validateImport=async()=>{if(!file||readOnly)return;try{setPreview(await previewImport.mutateAsync({data:{file}}));}catch(error){notify(errorMessage(error));}};
  const confirmImport=async()=>{if(!file||readOnly)return;try{const result=await importDates.mutateAsync({data:{file}});await invalidate(getListCalendarDatesQueryKey());notify(`Calendário importado: ${result.imported} incluídos, ${result.updated} atualizados e ${result.skipped} ignorados.`);setFile(null);setPreview(null);}catch(error){notify(errorMessage(error));}};
  const deleteRow=async(row:CalendarEvent)=>{if(readOnly||!window.confirm(`Excluir a data ${isoDate(row.date)} — ${row.description}?`))return;try{await remove.mutateAsync({id:row.id});await invalidate(getListCalendarDatesQueryKey());notify('Data especial excluída.');}catch(error){notify(errorMessage(error));}};
  return <div className="page">
    <PageHead eyebrow="Datas especiais · folhas em PDF" title="Calendário acadêmico" description="Mantenha o calendário aplicado às folhas e gere a folha em PDF de um servidor cadastrado, com as datas especiais da competência." actions={<button className="button" disabled={readOnly} onClick={openNew} data-testid="button-new-calendar-date"><Plus/>Nova data</button>}/>
    <Notice>Use datas de demonstração. A planilha deve conter as colunas Data e Especificação (a coluna Tipo é opcional e, quando ausente, o tipo é inferido da especificação); confira a prévia antes de importar.</Notice>
    <section className="panel" style={{marginBottom:16}}>
      <div className="panel-heading"><div><h2>Importar calendário</h2><p>Validação e resumo antes de gravar os eventos.</p></div><FileSpreadsheet size={17} color="#739282"/></div>
      <div className="tools"><input type="file" hidden accept=".xlsx,.xls" onChange={stageFile} data-testid="input-calendar-import"/><button type="button" className="button secondary" disabled={readOnly} onClick={e=>{const input=e.currentTarget.parentElement?.querySelector<HTMLInputElement>('input[type=file]');input?.click();}} data-testid="button-choose-calendar-import"><Upload/>Escolher planilha</button><span className="selected-file" style={{margin:0}}>{file?.name??'Nenhum arquivo selecionado · .xlsx ou .xls'}</span><button type="button" className="button" disabled={!file||readOnly||previewImport.isPending} onClick={()=>void validateImport()} data-testid="button-preview-calendar-import">{previewImport.isPending?'Validando…':'Validar arquivo'}</button></div>
      {preview&&<><div className="summary-list" data-testid="calendar-import-preview"><div className="summary-item"><strong>{preview.newCount}</strong><small>Novos</small></div><div className="summary-item"><strong>{preview.updatedCount}</strong><small>Atualizações</small></div><div className="summary-item"><strong>{preview.skippedCount}</strong><small>Ignorados/erros</small></div></div><DataTable headers={['Data','Especificação','Tipo','Resultado']}><>{preview.rows.slice(0,8).map((row,index)=><tr key={`${row.date}-${index}`}><td>{row.date??'—'}</td><td>{row.description??'—'}</td><td>{(row as { type?: CalendarEvent['type'] }).type ? calendarTypeLabel((row as { type?: CalendarEvent['type'] }).type) : '-'}</td><td>{row.action}</td></tr>)}</></DataTable>{preview.rows.length>8&&<p className="footer-note">Mostrando as 8 primeiras linhas de {preview.rows.length}.</p>}<div className="modal-actions"><button type="button" className="button secondary" onClick={()=>setPreview(null)}>Cancelar</button><button type="button" className="button" disabled={readOnly||importDates.isPending} onClick={()=>void confirmImport()} data-testid="button-confirm-calendar-import">{importDates.isPending?'Importando…':'Confirmar importação'}</button></div></>}
    </section>
    <div className="toolbar"><p><strong>Datas cadastradas</strong> · {rows.length} evento(s)</p></div>
    {calendar.isError?<ErrorState onRetry={()=>void calendar.refetch()}/>:calendar.isLoading?<LoadingTable/>:rows.length?<DataTable headers={['Data','Especificação','Tipo','Ações']}><>{rows.map(row=><tr key={row.id} data-testid={`calendar-row-${row.id}`}><td>{isoDate(row.date)}</td><td>{row.description}</td><td>{calendarTypeLabel((row as { type?: CalendarEvent['type'] }).type ?? 'outro')}</td><td><div className="row-actions"><button type="button" className="text-action" disabled={readOnly} onClick={()=>openEdit(row)} data-testid={`button-edit-calendar-${row.id}`}><Pencil size={13}/> Editar</button><button type="button" className="text-action" disabled={readOnly} onClick={()=>void deleteRow(row)} data-testid={`button-delete-calendar-${row.id}`}><Trash2 size={13}/> Excluir</button></div></td></tr>)}</></DataTable>:<Empty icon={CalendarDays} title="Calendário sem datas especiais" copy="Adicione um evento ou importe uma planilha para usá-lo nas folhas geradas."/>}
    <div style={{marginTop:16}}>
      <GenerateTimesheetPanel readOnly={readOnly} notify={notify} competency={competency}/>
    </div>
    {editing!==false&&<Modal title={editing?'Editar data especial':'Nova data especial'} intro="A data será considerada na composição das folhas geradas." onClose={()=>setEditing(false)}><form onSubmit={save}><div className="form-grid"><label className="field">Data<input type="date" required value={form.date} onChange={e=>setForm({...form,date:e.target.value})} data-testid="input-calendar-date"/></label><label className="field">Tipo<select value={form.type} onChange={e=>setForm({...form,type:e.target.value as CalendarEvent['type']})} data-testid="input-calendar-type"><option value="feriado">Feriado</option><option value="recesso">Recesso Acadêmico</option><option value="ponto_facultativo">Ponto Facultativo</option><option value="suspensao_expediente">Suspensão de expediente</option><option value="outro">Outro</option></select></label><label className="field span-2">Especificação<input required value={form.description} onChange={e=>setForm({...form,description:e.target.value})} data-testid="input-calendar-description"/></label></div><div className="modal-actions"><button type="button" className="button secondary" onClick={()=>setEditing(false)}>Cancelar</button><button type="submit" className="button" disabled={readOnly||create.isPending||update.isPending} data-testid="button-save-calendar-date">Salvar data</button></div></form></Modal>}
  </div>;
}

function DispatchPage({ readOnly, notify, invalidate }: {readOnly:boolean;notify:(s:string)=>void;invalidate:(...keys:readonly (readonly unknown[])[])=>Promise<void>}) {
  const [search,setSearch]=useState('');
  const [status,setStatus]=useState('todos');
  const [selected,setSelected]=useState<number[]>([]);
  const [from,setFrom]=useState('');
  const [to,setTo]=useState('');
  const [sendingId,setSendingId]=useState<number|null>(null);
  const [batchMode,setBatchMode]=useState<'selected'|'pending'|'errors'|'all'|null>(null);
  const query=useListDispatches({q:search||undefined,status:status==='todos'?undefined:status,from:from||undefined,to:to||undefined});
  const send=useSendDispatch();
  const resend=useResendDispatch();
  const sendBatch=useSendDispatchBatch();
  const rows=query.data??[];
  const pendingCount=rows.filter(row=>row.status==='pendente').length;
  const errorCount=rows.filter(row=>row.status==='erro').length;
  const openCount=rows.filter(row=>row.status!=='enviado').length;
  const selectable=rows.filter(row=>row.status!=='enviado');
  // Invalida o prefixo do dashboard: a página usa a competência selecionada,
  // não o mês corrente (o histórico pode ser de 2027, por exemplo).
  const refresh=()=>invalidate(getListDispatchesQueryKey(),getGetDashboardQueryKey(),getListAuditQueryKey());
  const sendOne=async(row:Dispatch)=>{
    if(readOnly||sendingId!==null)return;
    setSendingId(row.id);
    try{
      const result=row.status==='erro'?await resend.mutateAsync({id:row.id}):await send.mutateAsync({id:row.id});
      await refresh();
      notify(result.delivery_mode==='simulado'?'Despacho simulado com sucesso. Nenhum e-mail foi enviado.':'Despacho processado.');
    }catch(error){notify(errorMessage(error));}
    finally{setSendingId(null);}
  };
  const sendGroup=async(mode:'selected'|'pending'|'errors'|'all')=>{
    if(readOnly||batchMode!==null)return;
    if(mode==='selected'&&!selected.length){notify('Selecione ao menos um despacho.');return;}
    const message=mode==='selected'?`Enviar ${selected.length} despacho(s) selecionado(s)?`:mode==='errors'?'Tentar novamente todos os despachos com erro?':mode==='pending'?'Enviar todos os despachos pendentes?':'Enviar todos os despachos pendentes ou com erro?';
    if(!window.confirm(`${message} O envio será real quando o SMTP estiver configurado e validado.`))return;
    setBatchMode(mode);
    try{
      const result=await sendBatch.mutateAsync({data:{mode,...(mode==='selected'?{ids:selected}:{})}});
      await refresh();
      setSelected([]);
      const errors=result.results.filter(item=>item.status==='erro').length;
      notify(errors?`${result.processed} despacho(s) processado(s), ${errors} com erro. Veja o histórico.`:`${result.processed} despacho(s) processado(s). Verifique o histórico para detalhes.`);
    }catch(error){notify(errorMessage(error));}
    finally{setBatchMode(null);}
  };
  const toggle=(id:number)=>setSelected(current=>current.includes(id)?current.filter(value=>value!==id):[...current,id]);
  return <div className="page">
    <PageHead eyebrow="Comunicação · histórico" title="Despachos" description="Acompanhe tentativas por servidor, pesquise o histórico e envie individualmente ou em lote." actions={<Pill tone="warning">SMTP CONFIGURÁVEL</Pill>}/>
    <Notice>O envio será real somente quando o SMTP estiver configurado e validado. Sem SMTP, o registro permanece com erro e nenhuma mensagem é enviada.</Notice>
    <section className="panel" style={{marginBottom:15}}><div className="panel-heading"><div><h2>Ações em lote</h2><p>Escolha os registros conforme o status ou trabalhe com a seleção.</p></div><Send size={17} color="#739282"/></div><div className="tools"><button type="button" className="button secondary" disabled={readOnly||batchMode!==null||!selected.length} onClick={()=>void sendGroup('selected')} data-testid="button-send-selected">{batchMode==='selected'?'Enviando…':`Enviar selecionados (${selected.length})`}</button><button type="button" className="button secondary" disabled={readOnly||batchMode!==null||!pendingCount} onClick={()=>void sendGroup('pending')} data-testid="button-send-pending">{batchMode==='pending'?'Enviando…':'Enviar pendentes'}</button><button type="button" className="button secondary" disabled={readOnly||batchMode!==null||!errorCount} onClick={()=>void sendGroup('errors')} data-testid="button-retry-errors">{batchMode==='errors'?'Tentando…':'Repetir com erro'}</button><button type="button" className="button" disabled={readOnly||batchMode!==null||!openCount} onClick={()=>void sendGroup('all')} data-testid="button-send-all">{batchMode==='all'?'Enviando…':'Enviar pendentes e erros'}</button></div></section>
    <div className="toolbar"><p><strong>Histórico de despachos</strong> · {rows.length} registro(s)</p><div className="tools"><input className="search" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Nome, matrícula ou CPF" aria-label="Buscar despachos" data-testid="search-dispatches"/><select className="field-control" value={status} onChange={e=>setStatus(e.target.value)} aria-label="Filtrar por status" data-testid="filter-dispatch-status"><option value="todos">Todos os status</option><option value="pendente">Pendente</option><option value="enviado">Simulado</option><option value="erro">Com erro</option></select><label className="field" style={{minWidth:140}}>De<input type="date" value={from} onChange={e=>setFrom(e.target.value)} data-testid="filter-dispatch-from"/></label><label className="field" style={{minWidth:140}}>Até<input type="date" value={to} onChange={e=>setTo(e.target.value)} data-testid="filter-dispatch-to"/></label>{(search||status!=='todos'||from||to)&&<button type="button" className="button ghost" onClick={()=>{setSearch('');setStatus('todos');setFrom('');setTo('');}} data-testid="button-clear-dispatch-filters">Limpar filtros</button>}</div></div>
    {query.isError?<ErrorState onRetry={()=>void query.refetch()}/>:query.isLoading?<LoadingTable/>:rows.length?<DataTable headers={['','Servidor','Matrícula','E-mail','Arquivo','Status','Última tentativa','Ações']}><>{rows.map(row=><tr key={row.id} data-testid={`dispatch-row-${row.id}`}><td><input type="checkbox" aria-label={`Selecionar despacho ${row.employee_name}`} checked={selected.includes(row.id)} disabled={readOnly||row.status==='enviado'} onChange={()=>toggle(row.id)} data-testid={`checkbox-dispatch-${row.id}`}/></td><td><div className="person"><span className="person-mark">{initials(row.employee_name)}</span>{row.employee_name}<small>{row.employee_cpf}</small></div></td><td className="mono">{row.employee_matricula}</td><td>{row.employee_email||'—'}</td><td className="mono">{row.file_name||'—'}</td><td><Pill tone={row.status==='enviado'?'success':row.status==='erro'?'error':'warning'}>{row.status==='enviado'?(row.delivery_mode==='real'?'Enviado':'Simulado'):row.status==='erro'?'Erro':'Pendente'}</Pill>{row.error_message&&<small className="footer-note">{row.error_message}</small>}</td><td>{isoDate(row.sent_at??row.authorized_at??row.created_at)}</td><td><button type="button" className="text-action" disabled={readOnly||row.status==='enviado'||sendingId!==null||batchMode!==null} onClick={()=>void sendOne(row)} data-testid={`button-send-dispatch-${row.id}`}>{sendingId===row.id?'Enviando…':row.status==='erro'?'Tentar novamente':'Enviar'}</button></td></tr>)}</></DataTable>:<Empty icon={Send} title="Nenhum despacho encontrado" copy="Ajuste a busca, o status ou o período. Folhas conferidas que acumulam cargo aparecem aqui para envio."/>}
    {rows.length>0&&<div className="tools" style={{justifyContent:'flex-end',marginTop:10}}><button type="button" className="button ghost" disabled={!selectable.length||selected.length===selectable.length} onClick={()=>setSelected(selectable.map(row=>row.id))} data-testid="button-select-all-dispatches">Selecionar disponíveis</button><button type="button" className="button ghost" disabled={!selected.length} onClick={()=>setSelected([])} data-testid="button-clear-dispatch-selection">Limpar seleção</button></div>}
  </div>;
}

function SettingsPage({ readOnly, notify, invalidate }: {readOnly:boolean;notify:(s:string)=>void;invalidate:(...keys:readonly (readonly unknown[])[])=>Promise<void>}) {
  const query=useGetSmtpSettings();
  const saveSettings=useUpdateSmtpSettings();
  const testSettings=useTestSmtpSettings();
  const [form,setForm]=useState({host:'',port:'587',username:'',senderEmail:'',appPassword:'',secure:false});
  const [result,setResult]=useState('');
  const sourceLabel = query.data?.source === 'database' ? 'salva no banco de dados' : query.data?.source === 'environment' ? 'definida por variáveis de ambiente' : query.data?.source === 'demo' ? 'modo demonstrativo, sem envio real' : 'nenhuma configuração ativa';
  useEffect(()=>{if(query.data)setForm(current=>({...current,host:query.data.host,port:String(query.data.port),username:query.data.username,senderEmail:query.data.senderEmail,secure:query.data.secure,appPassword:''}));},[query.data]);
  const payload=():SmtpSettingsInput=>({host:form.host.trim(),port:Number(form.port),username:form.username.trim()||undefined,senderEmail:form.senderEmail.trim(),secure:form.secure,...(form.appPassword?{appPassword:form.appPassword}:{})});
  const save=async(event:FormEvent)=>{event.preventDefault();if(readOnly)return;try{await saveSettings.mutateAsync({data:payload()});await invalidate(getGetSmtpSettingsQueryKey());setForm(current=>({...current,appPassword:''}));notify('Configuração SMTP salva.');}catch(error){notify(errorMessage(error));}};
  const test=async()=>{if(readOnly)return;try{if(form.host.trim()&&form.senderEmail.trim()){await saveSettings.mutateAsync({data:payload()});await invalidate(getGetSmtpSettingsQueryKey());setForm(current=>({...current,appPassword:''}));}const response=await testSettings.mutateAsync();setResult(response.message);notify(response.message);}catch(error){setResult(errorMessage(error));notify(errorMessage(error));}};
  return <div className="page">
    <PageHead eyebrow="Ambiente · SMTP" title="Configurações" description="Registre os parâmetros de exemplo e valide campos sem conectar a um servidor de e-mail."/>
    <Notice>Configurações SMTP são salvas com a senha criptografada no banco. O teste tenta validar conexão com o servidor configurado.</Notice>
    {query.isError?<ErrorState onRetry={()=>void query.refetch()}/>:<section className="panel"><div className="panel-heading"><div><h2>Configuração SMTP</h2><p>Origem: {sourceLabel}. {query.data?.passwordSet?'Uma senha de aplicação está registrada.':'Nenhuma senha está registrada.'} O campo de senha permanece vazio por segurança.</p></div><Mail size={17} color="#739282"/></div><form onSubmit={save}><div className="form-grid"><label className="field">Servidor SMTP<input value={form.host} onChange={e=>setForm({...form,host:e.target.value})} placeholder="smtp.exemplo.gov.br" data-testid="input-smtp-host"/></label><label className="field">Porta<input type="number" min="1" max="65535" value={form.port} onChange={e=>setForm({...form,port:e.target.value})} data-testid="input-smtp-port"/></label><label className="field">Usuário<input value={form.username} onChange={e=>setForm({...form,username:e.target.value})} data-testid="input-smtp-username"/></label><label className="field">E-mail remetente<input type="email" required value={form.senderEmail} onChange={e=>setForm({...form,senderEmail:e.target.value})} data-testid="input-smtp-sender"/></label><label className="field">TLS/SSL<select value={String(form.secure)} onChange={e=>setForm({...form,secure:e.target.value==='true'})} data-testid="input-smtp-secure"><option value="false">Desativado</option><option value="true">Ativado</option></select></label><label className="field span-2">Senha de aplicação<input type="password" value={form.appPassword} onChange={e=>setForm({...form,appPassword:e.target.value})} autoComplete="new-password" placeholder={query.data?.passwordSet?'•••••••• (já configurada)':'Não preencha com uma senha real'} data-testid="input-smtp-password"/></label></div><div className="modal-actions"><button className="button secondary" type="button" disabled={readOnly||testSettings.isPending||saveSettings.isPending} onClick={()=>void test()} data-testid="button-test-smtp">{testSettings.isPending?'Validando…':'Validar conexão'}</button><button className="button" disabled={readOnly||saveSettings.isPending} data-testid="button-save-smtp">{saveSettings.isPending?'Salvando…':'Salvar configuração'}</button></div></form>{result&&<p className="footer-note" role="status" data-testid="smtp-test-result">{result}</p>}</section>}
  </div>;
}

function AuditPage() {
  const [search,setSearch]=useState('');
  const query=useListAudit({q:search||undefined});
  const rows=query.data?.items??[];
  return <div className="page">
    <PageHead eyebrow="Rastreabilidade" title="Auditoria" description="Consulte os eventos registrados nas operações de cadastro, folhas, calendário e despachos."/>
    <Notice>Os dados exibidos vêm da API. CPF é apresentado mascarado; a busca pode localizar registros pelo CPF informado.</Notice>
    <div className="toolbar"><p><strong>Eventos registrados</strong> · {rows.length}</p><div className="tools"><Search size={15} color="#8a9991"/><input className="search" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Buscar nome, matrícula ou CPF" data-testid="search-audit"/></div></div>
    {query.isError?<ErrorState onRetry={()=>void query.refetch()}/>:query.isLoading?<LoadingTable/>:rows.length?<DataTable headers={['Data','Pessoa','Matrícula','CPF','Ação','Status','Competência']}><>{rows.map(row=><tr key={`${row.id}-${row.date}`} data-testid={`audit-row-${row.id}`}><td>{isoDate(row.date)}</td><td>{row.name||'—'}</td><td className="mono">{row.matricula||'—'}</td><td className="mono">{row.cpf||'—'}</td><td>{row.action}</td><td><Pill>{row.status||'Registrado'}</Pill></td><td>{row.competencia||'—'}</td></tr>)}</></DataTable>:<Empty icon={History} title="Nenhuma operação registrada" copy="A trilha de auditoria será preenchida pelas próximas operações realizadas."/>}
  </div>;
}

function App() {
  return <QueryClientProvider client={queryClient}><AppFrame/></QueryClientProvider>;
}

export default App;
