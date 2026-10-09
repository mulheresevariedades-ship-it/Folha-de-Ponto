import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Link, Route, Switch, useLocation } from 'wouter';
import {
  Activity, AlertCircle, Archive, CalendarDays, Check, ChevronRight, CircleHelp, Clock3,
  FileCheck2, FileSpreadsheet, FileText, FolderOpen, History, LayoutDashboard, LockKeyhole,
  Mail, Menu, Pencil, Plus, Search, Send, Settings2, ShieldCheck, Trash2, Upload, Users, X,
} from 'lucide-react';
import {
  getGetDashboardQueryKey, getGetLockStateQueryKey, getGetSmtpSettingsQueryKey,
  getListAuditQueryKey, getListCalendarDatesQueryKey, getListDispatchesQueryKey,
  getListEmployeesQueryKey, getListTimesheetsQueryKey,
  useCreateCalendarDate, useCreateEmployee, useDeleteCalendarDate, useDeleteEmployee,
  useGetDashboard, useGetLockState, useGetSmtpSettings, useGetTimesheetFile, useGenerateTimesheet,
  useHeartbeatLock, useImportCalendar, useImportEmployees, useListAudit, useListCalendarDates,
  useListDispatches, useListEmployees, useListTimesheets, usePreviewBatch,
  usePreviewCalendarImport, usePreviewEmployeeImport, useProcessBatch, useReleaseLock,
  useResendDispatch, useReviewTimesheet, useSendDispatch, useSendDispatchBatch,
  useTestSmtpSettings, useUpdateCalendarDate, useUpdateEmployee, useUpdateSmtpSettings,
} from '@workspace/api-client-react';
import type { Employee, CalendarEvent, Timesheet, Dispatch, AuditEvent, SmtpSettingsInput } from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';

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
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
};
const isoDate = (d: Date | string | null | undefined) => {
  if (!d) return '—';
  const date = new Date(d);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
};
const initials = (s: string) => s.split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0]).join('').toUpperCase();
const errorMessage = (e: unknown) => e instanceof Error ? e.message : 'Não foi possível concluir a operação.';

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
  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(''), 3800); };
  const currentPage = (Object.entries(paths).find(([, path]) => path === location)?.[0] ?? 'inicio') as Page;
  const lockParams = { sessionId };
  const lockKey = getGetLockStateQueryKey(lockParams);
  const lockQuery = useGetLockState(lockParams, { query: { queryKey: lockKey, refetchInterval: 12000 } });
  const heartbeat = useHeartbeatLock();
  const release = useReleaseLock();
  const lock = lockQuery.data;
  const readOnly = Boolean(lock?.locked && !lock.heldByThisClient);
  const activePage = currentPage !== 'configuracoes';

  useEffect(() => {
    void heartbeat.mutateAsync({ data: { sessionId } }).then(() => queryClient.invalidateQueries({ queryKey: lockKey })).catch(() => undefined);
    const timer = window.setInterval(() => {
      void heartbeat.mutateAsync({ data: { sessionId } }).then(() => queryClient.invalidateQueries({ queryKey: lockKey })).catch(() => undefined);
    }, 30000);
    return () => {
      window.clearInterval(timer);
      void release.mutateAsync({ data: { sessionId } }).catch(() => undefined);
    };
  // one lease per mounted browser session
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const invalidate = async (...keys: readonly unknown[][]) => {
    await Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
  };
  const monthParams = { competency };
  const dashboardQuery = useGetDashboard(monthParams);
  const sheetQuery = useListTimesheets(monthParams);
  const dispatchSummaryQuery = useListDispatches();
  const auditSummaryQuery = useListAudit();
  const metrics = dashboardQuery.data;
  const sheetRows = sheetQuery.data ?? [];
  const dispatchRows = dispatchSummaryQuery.data ?? [];
  const activityRows = (auditSummaryQuery.data ?? []).slice(0, 5);
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
            <span>{lockQuery.isLoading ? 'Consultando edição' : readOnly ? 'Somente leitura · outra sessão ativa' : 'Edição disponível nesta sessão'}</span>
            {lock?.expiresAt && <span>· expira {new Date(lock.expiresAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>}
          </div>
        </div>
        {readOnly && <div className="read-only" data-testid="status-readonly"><LockKeyhole size={15} style={{ verticalAlign: 'middle', marginRight: 7 }}/>Edição bloqueada por outra sessão. Consulte os registros, mas aguarde a liberação antes de alterar dados.</div>}
        {currentPage === 'inicio' && <DashboardPage metrics={metrics} loading={dashboardQuery.isLoading} error={dashboardQuery.isError} competency={competency} setCompetency={setCompetency} sheets={sheetRows} sheetLoading={sheetQuery.isLoading} dispatches={dispatchRows} activity={activityRows} onRetry={() => { void dashboardQuery.refetch(); void sheetQuery.refetch(); }} navigate={(p) => setLocation(paths[p])}/>}
        {currentPage === 'folhas' && <TimesheetsPage competency={competency} setCompetency={setCompetency} readOnly={readOnly} notify={notify} invalidate={invalidate}/>}
        {currentPage === 'servidores' && <EmployeesPage readOnly={readOnly} notify={notify} invalidate={invalidate}/>}
        {currentPage === 'calendario' && <CalendarPage readOnly={readOnly} notify={notify} invalidate={invalidate}/>}
        {currentPage === 'envios' && <DispatchPage readOnly={readOnly} notify={notify} invalidate={invalidate}/>}
        {currentPage === 'configuracoes' && <SettingsPage notify={notify}/>}
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
  return <label className="field" style={{ minWidth: 130 }}>Competência<select value={value} data-testid="select-competency" onChange={(e) => onChange(e.target.value)}>{[0,1,2,3,4,5,6,7,8,9,10,11].map((back) => { const d = new Date(); d.setMonth(d.getMonth() - back); const v = `${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`; return <option key={v}>{v}</option>; })}</select></label>;
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

function TimesheetsPage({ competency, setCompetency, readOnly, notify, invalidate }: { competency: string; setCompetency: (v: string) => void; readOnly: boolean; notify: (s:string)=>void; invalidate: (...keys: readonly unknown[][])=>Promise<void> }) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('todos');
  const [files, setFiles] = useState<File[]>([]);
  const [preview, setPreview] = useState<Awaited<ReturnType<ReturnType<typeof usePreviewBatch>['mutateAsync']>> | null>(null);
  const [selected, setSelected] = useState<Timesheet | null>(null);
  const [reviewName, setReviewName] = useState('');
  const [reviewMatricula, setReviewMatricula] = useState('');
  const [reviewNote, setReviewNote] = useState('');
  const [fileToOpen, setFileToOpen] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const query = useListTimesheets({ competency, q: search || undefined, status: status === 'todos' ? undefined : status });
  const previewBatch = usePreviewBatch();
  const processBatch = useProcessBatch();
  const review = useReviewTimesheet();
  const fileQuery = useGetTimesheetFile(fileToOpen, { query: { enabled: !!fileToOpen, queryKey: getGetTimesheetFileQueryKey(fileToOpen) } });
  useEffect(() => {
    if (fileQuery.data && fileToOpen) {
      const url = URL.createObjectURL(fileQuery.data);
      window.open(url, '_blank', 'noopener');
      window.setTimeout(() => URL.revokeObjectURL(url), 60000);
      setFileToOpen('');
    }
  }, [fileQuery.data, fileToOpen]);
  const rows = query.data ?? [];
  const openReview = (sheet: Timesheet) => { setSelected(sheet); setReviewName(sheet.name); setReviewMatricula(sheet.matricula ?? ''); setReviewNote(sheet.note ?? ''); };
  const chooseFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(e.target.files ?? []);
    if (selectedFiles.some((file) => file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf'))) {
      notify('Somente arquivos PDF são aceitos para folhas de ponto.'); e.target.value = ''; return;
    }
    setFiles(selectedFiles); setPreview(null);
  };
  const doPreview = async () => {
    if (readOnly) return;
    if (!files.length) { notify('Selecione ao menos um arquivo PDF.'); return; }
    try { const result = await previewBatch.mutateAsync({ data: { files, fallbackCompetency: competency } }); setPreview(result); }
    catch(e) { notify(errorMessage(e)); }
  };
  const doProcess = async () => {
    try {
      const result = await processBatch.mutateAsync({ data: { files, fallbackCompetency: competency } });
      await invalidate(getListTimesheetsQueryKey({ competency }), getGetDashboardQueryKey({ competency }));
      notify(`Lote processado: ${result.created} novos, ${result.updated} atualizados e ${result.skipped} ignorados.`);
      setFiles([]); setPreview(null); if (inputRef.current) inputRef.current.value = '';
    } catch(e) { notify(errorMessage(e)); }
  };
  const reviewAction = async (action: 'confirm'|'pending'|'reject') => {
    if (!selected || readOnly) return;
    try {
      await review.mutateAsync({ id: selected.id, data: { action, name: reviewName, matricula: reviewMatricula, competency: selected.competencia, note: reviewNote } });
      await invalidate(getListTimesheetsQueryKey({ competency }), getGetDashboardQueryKey({ competency }), getListAuditQueryKey());
      notify(action === 'confirm' ? 'Folha revisada e arquivada.' : action === 'pending' ? 'Folha encaminhada para pendência.' : 'Folha rejeitada.');
      setSelected(null);
    } catch(e) { notify(errorMessage(e)); }
  };
  const openPdf = (id: string) => { setFileToOpen(id); };
  return <div className="page">
    <PageHead eyebrow="Recepção · OCR · arquivo" title="Folhas de ponto" description="Receba PDFs, confira o reconhecimento e consulte o arquivo por competência. A fila reflete apenas registros existentes na API." actions={<CompetencyControl value={competency} onChange={setCompetency}/>}/>
    <Notice>Envio estritamente PDF. A leitura OCR é uma sugestão para revisão humana; nenhum arquivo de exemplo ou servidor fictício é criado.</Notice>
    <section className="panel" style={{marginBottom:16}}>
      <div className="panel-heading"><div><h2>Entrada de lote</h2><p>Pré-visualize o reconhecimento antes de gravar as folhas.</p></div><Pill>PDF somente</Pill></div>
      <input ref={inputRef} type="file" accept="application/pdf,.pdf" multiple hidden data-testid="input-timesheet-pdf" onChange={chooseFiles}/>
      <div className="upload-zone"><Upload/><strong>Selecionar PDFs para conferência</strong><p>Arquivos PDF, um ou vários · competência de referência {competency}</p><div className="head-actions" style={{justifyContent:'center'}}><button className="button secondary" disabled={readOnly} onClick={()=>inputRef.current?.click()} data-testid="button-select-pdf">Escolher PDFs</button><button className="button" disabled={readOnly || !files.length || previewBatch.isPending} onClick={()=>void doPreview()} data-testid="button-preview-batch">{previewBatch.isPending?'Analisando…':'Analisar lote'}</button></div>{files.length>0&&<div className="selected-file" data-testid="selected-pdf-files">{files.map(f=>f.name).join(' · ')} ({files.length})</div>}</div>
      {preview&&<div style={{marginTop:16}} data-testid="batch-preview"><div className="panel-heading"><div><h2>Prévia de reconhecimento</h2><p>{preview.entries.length} página(s) analisada(s) · {preview.reviewCount} requer(em) revisão</p></div><div className="head-actions"><Pill>{preview.newCount} novas</Pill><Pill tone="warning">{preview.duplicateCount} duplicadas</Pill></div></div>{preview.entries.length>0&&<DataTable headers={['Arquivo / página','Servidor reconhecido','Matrícula','Competência','Confiança','Leitura']}><>{preview.entries.map((entry,i)=><tr key={`${entry.sourceFilename}-${entry.pageNumber}-${i}`}><td>{entry.sourceFilename} · p. {entry.pageNumber}</td><td>{entry.name}</td><td className="mono">{entry.matricula??'—'}</td><td>{entry.competency}</td><td>{entry.confidence}%</td><td><Pill tone={entry.needsReview?'warning':'success'}>{entry.needsReview?'Revisar':'Conferida'}</Pill></td></tr>)}</></DataTable>}<div className="modal-actions"><button className="button secondary" onClick={()=>setPreview(null)}>Cancelar</button><button className="button" disabled={readOnly||processBatch.isPending} onClick={()=>void doProcess()} data-testid="button-process-batch">{processBatch.isPending?'Gravando…':'Confirmar e arquivar lote'}</button></div></div>}
    </section>
    <div className="toolbar"><p><strong>Arquivo e revisão</strong> · {rows.length} folha(s) nesta consulta</p><div className="tools"><label className="field"><span className="sr-only">Buscar folhas</span><input className="search" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Buscar nome, matrícula ou ID" data-testid="search-timesheets"/></label><select className="field-control" value={status} onChange={e=>setStatus(e.target.value)} data-testid="filter-timesheet-status"><option value="todos">Todos os status</option><option value="revisao">Revisão necessária</option><option value="pendente">Pendente</option><option value="baixa_confianca">Baixa confiança</option><option value="reconhecida">Reconhecida</option><option value="arquivada">Arquivada</option><option value="rejeitada">Rejeitada</option></select></div></div>
    {query.isError?<ErrorState onRetry={()=>void query.refetch()}/>:query.isLoading?<LoadingTable/>:rows.length?<DataTable headers={['Folha','Servidor reconhecido','Matrícula','Confiança OCR','Status','Conferida em','Ações']}><>{rows.map(row=><tr key={row.id} data-testid={`timesheet-row-${row.id}`}><td className="mono">{row.id}<br/><span style={{fontFamily:'var(--font-sans)',color:'#899690'}}>{row.competencia}</span></td><td><div className="person"><span className="person-mark">{initials(row.name)}</span>{row.name}</div></td><td className="mono">{row.matricula??'—'}</td><td>{row.confidence}%</td><td><Pill tone={row.status==='arquivada'||row.status==='reconhecida'?'success':row.status==='rejeitada'?'error':'warning'}>{row.status_label}</Pill></td><td>{isoDate(row.reviewed_at)}</td><td><div className="row-actions"><button className="text-action" onClick={()=>openReview(row)} data-testid={`button-review-${row.id}`}>Conferir</button><button className="text-action" onClick={()=>openPdf(row.id)} disabled={!row.file_url} data-testid={`button-pdf-${row.id}`}>PDF</button></div></td></tr>)}</></DataTable>:<Empty icon={Archive} title="Arquivo vazio nesta competência" copy="Não há folhas correspondentes. Envie PDFs para análise ou altere a busca."/ >}
    {fileQuery.isError&&<p role="alert" className="footer-note">O arquivo PDF não pôde ser aberto. {errorMessage(fileQuery.error)}</p>}
    {selected&&<Modal title="Conferência da folha" intro={`${selected.id} · ${selected.competencia} · OCR ${selected.confidence}%`} onClose={()=>setSelected(null)}><div className="form-grid"><label className="field span-2">Nome reconhecido<input value={reviewName} onChange={e=>setReviewName(e.target.value)} data-testid="input-review-name"/></label><label className="field">Matrícula<input value={reviewMatricula} onChange={e=>setReviewMatricula(e.target.value)} data-testid="input-review-matricula"/></label><label className="field">Competência<input value={selected.competencia} readOnly/></label><label className="field span-2">Observação<textarea value={reviewNote} onChange={e=>setReviewNote(e.target.value)} placeholder="Anotações da conferência" data-testid="input-review-note"/></label></div><div className="modal-actions"><button className="button danger" disabled={readOnly||review.isPending} onClick={()=>void reviewAction('reject')}>Rejeitar</button><button className="button secondary" disabled={readOnly||review.isPending} onClick={()=>void reviewAction('pending')}>Manter pendente</button><button className="button" disabled={readOnly||review.isPending} onClick={()=>void reviewAction('confirm')}><Check size={14}/> Confirmar revisão</button></div></Modal>}
  </div>;
}

function Modal({ title, intro, children, onClose }: { title:string; intro:string; children:ReactNode; onClose:()=>void }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><button className="text-action" style={{float:'right'}} aria-label="Fechar" onClick={onClose}><X size={18}/></button><h2 id="modal-title">{title}</h2><p className="modal-intro">{intro}</p>{children}</section></div>;
}

function EmployeesPage({ readOnly, notify, invalidate }: {readOnly:boolean;notify:(s:string)=>void;invalidate:(...keys:readonly unknown[][])=>Promise<void>}) {
  const queryClient=useQueryClient();
  const [search,setSearch]=useState('');
  const [editing,setEditing]=useState<Employee|null|false>(false);
  const [form,setForm]=useState({name:'',matricula:'',cpf:'',email:'',cargo:'',workloadHours:'40',accumulatesRole:false});
  const [file,setFile]=useState<File|null>(null);
  const [importPreview,setImportPreview]=useState<Awaited<ReturnType<ReturnType<typeof usePreviewEmployeeImport>['mutateAsync']>>|null>(null);
  const inputRef=useRef<HTMLInputElement>(null);
  const query=useListEmployees({q:search||undefined});
  const create=useCreateEmployee(); const update=useUpdateEmployee(); const remove=useDeleteEmployee();
  const previewImport=usePreviewEmployeeImport(); const importEmployees=useImportEmployees();
  const rows=query.data??[];
  const openNew=()=>{setForm({name:'',matricula:'',cpf:'',email:'',cargo:'',workloadHours:'40',accumulatesRole:false});setEditing(null);};
  const openEdit=(e:Employee)=>{setForm({name:e.name,matricula:e.matricula,cpf:e.cpf,email:e.email,cargo:e.cargo,workloadHours:String(e.carga_horaria),accumulatesRole:e.acumula});setEditing(e);};
  const save=async(e:FormEvent)=>{e.preventDefault();if(readOnly)return;const data={name:form.name,matricula:form.matricula,cpf:form.cpf,email:form.email,cargo:form.cargo,workloadHours:Number(form.workloadHours),accumulatesRole:form.accumulatesRole};try{if(editing){await update.mutateAsync({id:editing.id,data});notify('Cadastro atualizado.');}else{await create.mutateAsync({data});notify('Servidor cadastrado.');}await invalidate(getListEmployeesQueryKey());setEditing(false);}catch(err){notify(errorMessage(err));}};
  const stageFile=(e:React.ChangeEvent<HTMLInputElement>)=>{const next=e.target.files?.[0]??null;if(next&&!/\.(xlsx|xls|csv)$/i.test(next.name)){notify('Selecione uma planilha .xlsx, .xls ou .csv.');e.target.value='';return;}setFile(next);setImportPreview(null);};
  const validateImport=async()=>{if(!file)return notify('Selecione uma planilha.');if(readOnly)return;try{setImportPreview(await previewImport.mutateAsync({data:{file}}));}catch(err){notify(errorMessage(err));}};
  const confirmImport=async()=>{if(!file||readOnly)return;try{const result=await importEmployees.mutateAsync({data:{file}});await invalidate(getListEmployeesQueryKey());notify(`Importação concluída: ${result.imported} novos, ${result.updated} atualizados, ${result.skipped} ignorados.`);setImportPreview(null);setFile(null);if(inputRef.current)inputRef.current.value='';}catch(err){notify(errorMessage(err));}};
  const deleteRow=async(row:Employee)=>{if(readOnly)return;if(!window.confirm(`Desativar o cadastro de ${row.name}?`))return;try{await remove.mutateAsync({id:row.id});await invalidate(getListEmployeesQueryKey());notify('Cadastro desativado.');}catch(err){notify(errorMessage(err));}};
  return <div className="page">
    <PageHead eyebrow="Base cadastral" title="Servidores" description="Pesquise os cadastros retornados pela API, registre alterações ou valide uma planilha antes da importação." actions={<button className="button" disabled={readOnly} onClick={openNew} data-testid="button-new-employee"><Plus/>Novo cadastro</button>}/>
    <Notice>Cadastros podem conter dados pessoais. Trabalhe somente com registros sintéticos de demonstração; nenhum servidor é pré-carregado.</Notice>
    <section className="panel" style={{marginBottom:15}}><div className="panel-heading"><div><h2>Importação de planilha</h2><p>Validação e resumo antes de gravar. Os dados vêm do arquivo selecionado.</p></div><FileSpreadsheet size={17} color="#739282"/></div><div className="tools"><input ref={inputRef} type="file" hidden accept=".xlsx,.xls,.csv" onChange={stageFile} data-testid="input-employee-import"/><button className="button secondary" disabled={readOnly} onClick={()=>inputRef.current?.click()} data-testid="button-choose-employee-import"><Upload/>Escolher planilha</button><span className="selected-file" style={{margin:0}}>{file?.name??'Nenhum arquivo selecionado · .xlsx, .xls ou .csv'}</span><button className="button" disabled={!file||readOnly||previewImport.isPending} onClick={()=>void validateImport()} data-testid="button-preview-employee-import">{previewImport.isPending?'Validando…':'Validar arquivo'}</button></div>
      {importPreview&&<div className="summary-list" data-testid="employee-import-preview"><div className="summary-item"><strong>{importPreview.newCount}</strong><small>Novos</small></div><div className="summary-item"><strong>{importPreview.updatedCount}</strong><small>Atualizações</small></div><div className="summary-item"><strong>{importPreview.skippedCount}</strong><small>Ignorados</small></div><button className="button" disabled={readOnly||importEmployees.isPending} onClick={()=>void confirmImport()}>{importEmployees.isPending?'Importando…':'Confirmar importação'}</button><button className="button secondary" onClick={()=>setImportPreview(null)}>Cancelar</button></div>}
    </section>
    <div className="toolbar"><p><strong>Cadastros retornados</strong> · {rows.length} registro(s)</p><div className="tools"><Search size={15} color="#8a9991"/><input className="search" placeholder="Nome, matrícula ou CPF" value={search} onChange={e=>setSearch(e.target.value)} data-testid="search-employees"/></div></div>
    {query.isError?<ErrorState onRetry={()=>void query.refetch()}/>:query.isLoading?<LoadingTable/>:rows.length?<DataTable headers={['Matrícula','Servidor','Cargo','Carga horária','Acumula','E-mail','Ações']}><>{rows.map(row=><tr key={row.id} data-testid={`employee-row-${row.id}`}><td className="mono">{row.matricula}</td><td><div className="person"><span className="person-mark">{initials(row.name)}</span>{row.name}</div><small style={{color:'#8b9690',marginLeft:37}}>{row.cpf}</small></td><td>{row.cargo||'—'}</td><td>{row.carga_horaria} h</td><td>{row.acumula?<Pill tone="success">Sim</Pill>:<Pill>Não</Pill>}</td><td>{row.email||'—'}</td><td><div className="row-actions"><button className="text-action" disabled={readOnly} onClick={()=>openEdit(row)} data-testid={`button-edit-employee-${row.id}`}><Pencil size={13}/> Editar</button><button className="text-action" disabled={readOnly} onClick={()=>void deleteRow(row)} data-testid={`button-delete-employee-${row.id}`}><Trash2 size={13}/> Desativar</button></div></td></tr>)}</></DataTable>:<Empty icon={Users} title="Nenhum servidor cadastrado" copy="A base da demonstração está vazia. Cadastre um registro sintético ou importe uma planilha autorizada."/>}
    {editing!==false&&<Modal title={editing?'Editar cadastro':'Novo servidor'} intro="As informações serão enviadas à API e não são armazenadas localmente." onClose={()=>setEditing(false)}><form onSubmit={save}><div className="form-grid"><label className="field span-2">Nome completo<input required value={form.name} onChange={e=>setForm({...form,name:e.target.value})} data-testid="input-employee-name"/></label><label className="field">Matrícula<input required value={form.matricula} onChange={e=>setForm({...form,matricula:e.target.value})} data-testid="input-employee-matricula"/></label><label className="field">CPF<input value={form.cpf} onChange={e=>setForm({...form,cpf:e.target.value})} data-testid="input-employee-cpf"/></label><label className="field">E-mail<input type="email" value={form.email} onChange={e=>setForm({...form,email:e.target.value})} data-testid="input-employee-email"/></label><label className="field">Cargo<input value={form.cargo} onChange={e=>setForm({...form,cargo:e.target.value})} data-testid="input-employee-role"/></label><label className="field">Carga horária<input type="number" min="1" max="100" value={form.workloadHours} onChange={e=>setForm({...form,workloadHours:e.target.value})} data-testid="input-employee-hours"/></label><label className="field" style={{display:'flex',alignItems:'center',gap:8,paddingTop:20}}><input type="checkbox" checked={form.accumulatesRole} onChange={e=>setForm({...form,accumulatesRole:e.target.checked})} data-testid="input-employee-accumulates"/>Acumula cargo</label></div><div className="modal-actions"><button type="button" className="button secondary" onClick={()=>setEditing(false)}>Cancelar</button><button className="button" disabled={readOnly||create.isPending||update.isPending} data-testid="button-save-employee">Salvar cadastro</button></div></form></Modal>}
  </div>;
}
