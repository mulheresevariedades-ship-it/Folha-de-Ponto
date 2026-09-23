import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import type * as React from 'react';
import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  ArrowRight,
  Bell,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  ClipboardCheck,
  Clock3,
  FileArchive,
  FileCheck2,
  FileSpreadsheet,
  FileText,
  FolderSearch,
  History,
  Info,
  LayoutDashboard,
  LogOut,
  MailCheck,
  Menu,
  MoreHorizontal,
  PackageOpen,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  ShieldCheck,
  Upload,
  Users,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';

type View = 'dashboard' | 'ocr' | 'arquivo' | 'servidores' | 'envios' | 'auditoria' | 'novo-lote';
type Status = 'reconhecida' | 'arquivada' | 'revisao' | 'pendente' | 'baixa_confianca' | 'rejeitada' | 'ocr_indisponivel';
type DispatchStatus = 'pendente' | 'enviado' | 'erro';

interface Timesheet {
  id: string;
  name: string;
  matricula: string | null;
  competencia: string;
  confidence: number;
  status: Status;
  status_label: string;
  reviewed_at: string | null;
  note?: string;
}

interface Employee {
  id: number;
  name: string;
  matricula: string;
  cpf: string;
  email: string;
  carga_horaria: number;
  acumula: boolean;
}

interface Dispatch {
  id: number;
  employee_name: string;
  employee_matricula: string;
  status: DispatchStatus;
  created_at: string;
  authorized_at: string | null;
  sent_at: string | null;
  error_message: string | null;
}

interface AuditItem {
  id: string;
  name: string;
  action: string;
  status: Status;
  competencia: string;
  date: string;
}

interface User {
  name: string;
  role: string;
}

const queryClient = new QueryClient();

async function apiRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { message?: string };
    throw new Error(body.message ?? `Falha na API (${response.status})`);
  }
  return response.json() as Promise<T>;
}

const statusLabels: Record<Status, string> = {
  reconhecida: 'Reconhecida',
  arquivada: 'Arquivada',
  revisao: 'Revisão necessária',
  pendente: 'Pendente',
  baixa_confianca: 'Baixa confiança',
  rejeitada: 'Rejeitada',
  ocr_indisponivel: 'OCR indisponível',
};

const viewLabels: Record<View, string> = {
  dashboard: 'Dashboard',
  ocr: 'Conferência OCR',
  arquivo: 'Arquivo de folhas',
  servidores: 'Servidores',
  envios: 'Fila de envios',
  auditoria: 'Auditoria',
  'novo-lote': 'Novo lote',
};

const competencies = ['07/2026', '06/2026', '05/2026'];

const initialTimesheets: Timesheet[] = [
  { id: 'F-1042', name: 'Ana Beatriz de Souza', matricula: '2024187', competencia: '07/2026', confidence: 64, status: 'revisao', status_label: statusLabels.revisao, reviewed_at: null },
  { id: 'F-1043', name: 'Paulo Henrique Lima', matricula: '2022074', competencia: '07/2026', confidence: 48, status: 'baixa_confianca', status_label: statusLabels.baixa_confianca, reviewed_at: null },
  { id: 'F-1044', name: 'Mirela Santos Rocha', matricula: '2023119', competencia: '07/2026', confidence: 95, status: 'reconhecida', status_label: statusLabels.reconhecida, reviewed_at: '2026-07-27T10:18:00' },
  { id: 'F-1045', name: 'Davi Cardoso', matricula: '2021052', competencia: '07/2026', confidence: 98, status: 'arquivada', status_label: statusLabels.arquivada, reviewed_at: '2026-07-26T16:42:00' },
  { id: 'F-1046', name: 'Joana Martins Alves', matricula: '2020198', competencia: '07/2026', confidence: 71, status: 'pendente', status_label: statusLabels.pendente, reviewed_at: null, note: 'Aguardando correção do período de férias.' },
  { id: 'F-1047', name: 'Lia Cristina Nunes', matricula: '2024086', competencia: '07/2026', confidence: 92, status: 'arquivada', status_label: statusLabels.arquivada, reviewed_at: '2026-07-26T14:07:00' },
  { id: 'F-1048', name: 'Omar Ferreira', matricula: '2023014', competencia: '07/2026', confidence: 91, status: 'reconhecida', status_label: statusLabels.reconhecida, reviewed_at: '2026-07-25T11:28:00' },
  { id: 'F-1049', name: 'Servidor não identificado', matricula: null, competencia: '07/2026', confidence: 0, status: 'ocr_indisponivel', status_label: statusLabels.ocr_indisponivel, reviewed_at: null },
  { id: 'F-0991', name: 'Carlos Eduardo Reis', matricula: '2022174', competencia: '06/2026', confidence: 97, status: 'arquivada', status_label: statusLabels.arquivada, reviewed_at: '2026-06-29T15:02:00' },
  { id: 'F-0992', name: 'Helena Costa', matricula: '2023260', competencia: '06/2026', confidence: 78, status: 'reconhecida', status_label: statusLabels.reconhecida, reviewed_at: '2026-06-29T12:11:00' },
  { id: 'F-0993', name: 'Tereza Moura', matricula: '2022111', competencia: '06/2026', confidence: 58, status: 'revisao', status_label: statusLabels.revisao, reviewed_at: null },
  { id: 'F-0912', name: 'Ricardo Azevedo', matricula: '2021157', competencia: '05/2026', confidence: 94, status: 'arquivada', status_label: statusLabels.arquivada, reviewed_at: '2026-05-28T16:20:00' },
];

const initialEmployees: Employee[] = [
  { id: 11, name: 'Ana Beatriz de Souza', matricula: '2024187', cpf: '***.***.***-04', email: 'ana.souza@undf.edu.br', carga_horaria: 40, acumula: true },
  { id: 12, name: 'Davi Cardoso', matricula: '2021052', cpf: '***.***.***-19', email: 'davi.cardoso@undf.edu.br', carga_horaria: 40, acumula: false },
  { id: 13, name: 'Joana Martins Alves', matricula: '2020198', cpf: '***.***.***-72', email: 'joana.alves@undf.edu.br', carga_horaria: 30, acumula: true },
  { id: 14, name: 'Mirela Santos Rocha', matricula: '2023119', cpf: '***.***.***-48', email: 'mirela.rocha@undf.edu.br', carga_horaria: 40, acumula: false },
  { id: 15, name: 'Paulo Henrique Lima', matricula: '2022074', cpf: '***.***.***-31', email: 'paulo.lima@undf.edu.br', carga_horaria: 40, acumula: true },
];

const initialDispatches: Dispatch[] = [
  { id: 701, employee_name: 'Ana Beatriz de Souza', employee_matricula: '2024187', status: 'pendente', created_at: '2026-07-27T09:10:00', authorized_at: null, sent_at: null, error_message: null },
  { id: 702, employee_name: 'Paulo Henrique Lima', employee_matricula: '2022074', status: 'pendente', created_at: '2026-07-27T08:44:00', authorized_at: '2026-07-27T09:15:00', sent_at: null, error_message: null },
  { id: 703, employee_name: 'Joana Martins Alves', employee_matricula: '2020198', status: 'erro', created_at: '2026-07-26T15:04:00', authorized_at: '2026-07-26T15:20:00', sent_at: null, error_message: 'Endereço de destino não confirmado' },
  { id: 704, employee_name: 'Mirela Santos Rocha', employee_matricula: '2023119', status: 'enviado', created_at: '2026-07-25T11:31:00', authorized_at: '2026-07-25T11:37:00', sent_at: '2026-07-25T11:38:00', error_message: null },
];

function initials(name: string) {
  return name.split(' ').filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
}

function statusTone(status: Status | DispatchStatus) {
  if (status === 'reconhecida' || status === 'arquivada' || status === 'enviado') return 'green';
  if (status === 'revisao' || status === 'pendente') return 'amber';
  if (status === 'baixa_confianca' || status === 'rejeitada' || status === 'erro') return 'coral';
  return 'gray';
}

function formatDate(value: string | null) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function Button({ children, className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { className?: string }) {
  return <button className={`button ${className}`} {...props}>{children}</button>;
}

function StatusPill({ status, label }: { status: Status | DispatchStatus; label?: string }) {
  const text = label ?? (status in statusLabels ? statusLabels[status as Status] : status === 'enviado' ? 'Enviado' : status === 'erro' ? 'Com erro' : 'Pendente');
  return <span className={`status-pill ${statusTone(status)}`} data-testid={`status-${status}`}>{text}</span>;
}

function Confidence({ value }: { value: number }) {
  return <div className="confidence" data-testid={`confidence-${value}`}><span className="confidence-bar"><i className={value >= 70 ? 'amber' : ''} style={{ width: `${value}%` }} /></span><strong>{value}%</strong></div>;
}

function PersonCell({ name, tone = '' }: { name: string; tone?: string }) {
  return <div className="person-cell"><span className={`table-avatar ${tone}`} aria-hidden="true">{initials(name)}</span><span>{name}</span></div>;
}

function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const [user, setUser] = useState<User>({ name: 'Mariana Farias', role: 'Operadora DIGEP' });
  const [view, setView] = useState<View>('dashboard');
  const [competency, setCompetency] = useState('07/2026');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [timesheets, setTimesheets] = useState<Timesheet[]>(initialTimesheets);
  const [employees, setEmployees] = useState<Employee[]>(initialEmployees);
  const [dispatches, setDispatches] = useState<Dispatch[]>(initialDispatches);
  const [audit, setAudit] = useState<AuditItem[]>([
    { id: 'F-1045', name: 'Davi Cardoso', action: 'Folha arquivada', status: 'arquivada', competencia: '07/2026', date: '2026-07-26T16:42:00' },
    { id: 'F-1047', name: 'Lia Cristina Nunes', action: 'Folha arquivada', status: 'arquivada', competencia: '07/2026', date: '2026-07-26T14:07:00' },
    { id: 'F-1048', name: 'Omar Ferreira', action: 'Reconhecimento revisado', status: 'reconhecida', competencia: '07/2026', date: '2026-07-25T11:28:00' },
    { id: 'F-0991', name: 'Carlos Eduardo Reis', action: 'Folha arquivada', status: 'arquivada', competencia: '06/2026', date: '2026-06-29T15:02:00' },
  ]);
  const [toast, setToast] = useState('');
  const [noticeVisible, setNoticeVisible] = useState(true);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [loginUser, setLoginUser] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [selectedQueueId, setSelectedQueueId] = useState<string | null>('F-1042');
  const [draftName, setDraftName] = useState('');
  const [draftMatricula, setDraftMatricula] = useState('');
  const [draftCompetencia, setDraftCompetencia] = useState(competency);
  const [draftNote, setDraftNote] = useState('');
  const [archiveSearch, setArchiveSearch] = useState('');
  const [archiveStatus, setArchiveStatus] = useState('todos');
  const [dispatchStatus, setDispatchStatus] = useState('todos');
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importPreview, setImportPreview] = useState(false);
  const [batchFile, setBatchFile] = useState<File | null>(null);
  const [apiOnline, setApiOnline] = useState(false);
  const batchInputRef = useRef<HTMLInputElement>(null);
  const employeeInputRef = useRef<HTMLInputElement>(null);

  const announce = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 3300);
  };

  const currentRows = useMemo(() => timesheets.filter((row) => row.competencia === competency), [timesheets, competency]);
  const queueRows = useMemo(() => currentRows.filter((row) => !['arquivada', 'rejeitada'].includes(row.status)), [currentRows]);
  const selectedQueue = useMemo(() => queueRows.find((row) => row.id === selectedQueueId) ?? queueRows[0] ?? null, [queueRows, selectedQueueId]);
  const dashboard = useMemo(() => {
    const recognized = currentRows.filter((row) => ['reconhecida', 'arquivada'].includes(row.status)).length;
    const review = currentRows.filter((row) => ['revisao', 'pendente', 'ocr_indisponivel'].includes(row.status)).length;
    const lowConfidence = currentRows.filter((row) => row.status === 'baixa_confianca').length;
    const archived = currentRows.filter((row) => row.status === 'arquivada').length;
    return {
      total: currentRows.length,
      recognized,
      review,
      low_confidence: lowConfidence,
      archived,
      recognition_rate: currentRows.length ? Math.round((recognized / currentRows.length) * 100) : 0,
      dispatch_pending: dispatches.filter((item) => item.status === 'pendente').length,
      dispatch_sent: dispatches.filter((item) => item.status === 'enviado').length,
      dispatch_error: dispatches.filter((item) => item.status === 'erro').length,
    };
  }, [currentRows, dispatches]);
  const attentionRows = currentRows.filter((row) => ['revisao', 'baixa_confianca', 'pendente', 'ocr_indisponivel'].includes(row.status)).slice(0, 5);
  const filteredArchive = useMemo(() => timesheets.filter((row) => {
    const matchesCompetency = row.competencia === competency;
    const matchesStatus = archiveStatus === 'todos' || row.status === archiveStatus;
    const search = archiveSearch.toLowerCase().trim();
    const matchesSearch = !search || row.name.toLowerCase().includes(search) || (row.matricula ?? '').includes(search) || row.id.toLowerCase().includes(search);
    return matchesCompetency && matchesStatus && matchesSearch;
  }), [archiveSearch, archiveStatus, competency, timesheets]);
  const filteredDispatches = dispatches.filter((item) => dispatchStatus === 'todos' || item.status === dispatchStatus);
  const recentActivity = timesheets.filter((row) => row.competencia === competency && row.reviewed_at).slice(-4).reverse();

  useEffect(() => {
    const row = selectedQueue;
    if (row) {
      setSelectedQueueId(row.id);
      setDraftName(row.name === 'Servidor não identificado' ? '' : row.name);
      setDraftMatricula(row.matricula ?? '');
      setDraftCompetencia(row.competencia);
      setDraftNote(row.note ?? '');
    } else {
      setDraftName('');
      setDraftMatricula('');
      setDraftCompetencia(competency);
      setDraftNote('');
    }
  }, [selectedQueue, competency]);

  useEffect(() => {
    if (!authenticated) return;
    let cancelled = false;
    const loadData = async () => {
      try {
        const [sheetRows, employeeRows, dispatchRows, auditRows] = await Promise.all([
          apiRequest<Timesheet[]>(`/timesheets?competency=${encodeURIComponent(competency)}`),
          apiRequest<Employee[]>('/employees'),
          apiRequest<Dispatch[]>('/dispatches'),
          apiRequest<AuditItem[]>('/audit'),
        ]);
        if (cancelled) return;
        setTimesheets(sheetRows);
        setEmployees(employeeRows);
        setDispatches(dispatchRows);
        setAudit(auditRows.map((item) => ({ ...item, date: item.date ?? new Date().toISOString() })));
        setApiOnline(true);
      } catch {
        if (!cancelled) setApiOnline(false);
      }
    };
    void loadData();
    return () => { cancelled = true; };
  }, [authenticated, competency]);

  const navigate = (nextView: View) => {
    setView(nextView);
    setMobileOpen(false);
  };

  const handleLogin = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!loginUser.trim() || !loginPassword.trim()) {
      setLoginError('Informe usuário e senha para continuar.');
      return;
    }
    setLoginError('');
    const displayName = loginUser.includes('@') ? loginUser.split('@')[0].replace(/[._-]/g, ' ') : loginUser;
    setUser({ name: displayName.split(' ').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' '), role: 'Operadora DIGEP' });
    setAuthenticated(true);
    announce('Acesso autorizado. Bem-vinda ao Ponto Digital.');
  };

  const handleLogout = () => {
    setAuthenticated(false);
    setLoginUser('');
    setLoginPassword('');
    setView('dashboard');
    announce('Sessão encerrada com segurança.');
  };

  const selectCompetency = (value: string) => {
    setCompetency(value);
    setSelectedQueueId(null);
    announce(`Competência alterada para ${value}.`);
  };

  const selectQueue = (id: string) => {
    setSelectedQueueId(id);
    const row = queueRows.find((item) => item.id === id);
    if (row) {
      setDraftName(row.name === 'Servidor não identificado' ? '' : row.name);
      setDraftMatricula(row.matricula ?? '');
      setDraftCompetencia(row.competencia);
      setDraftNote(row.note ?? '');
    }
  };

  const refreshFromApi = async () => {
    const [sheetRows, employeeRows, dispatchRows, auditRows] = await Promise.all([
      apiRequest<Timesheet[]>(`/timesheets?competency=${encodeURIComponent(competency)}`),
      apiRequest<Employee[]>('/employees'),
      apiRequest<Dispatch[]>('/dispatches'),
      apiRequest<AuditItem[]>('/audit'),
    ]);
    setTimesheets(sheetRows);
    setEmployees(employeeRows);
    setDispatches(dispatchRows);
    setAudit(auditRows);
  };

  const reviewAction = async (action: 'confirm' | 'pending' | 'reject') => {
    if (!selectedQueue) {
      announce('Selecione uma folha para continuar.');
      return;
    }
    const nextStatus: Status = action === 'confirm' ? 'arquivada' : action === 'pending' ? 'pendente' : 'rejeitada';
    const nextLabel = statusLabels[nextStatus];
    const date = new Date().toISOString();
    if (apiOnline) {
      try {
        await apiRequest(`/timesheets/${encodeURIComponent(selectedQueue.id)}/review`, {
          method: 'PATCH',
          body: JSON.stringify({ action, name: draftName, matricula: draftMatricula, competency: draftCompetencia, note: draftNote }),
        });
        await refreshFromApi();
        announce(`${draftName.trim() || selectedQueue.name} atualizado: ${nextLabel}.`);
        setSelectedQueueId(null);
        return;
      } catch (error) {
        announce(error instanceof Error ? error.message : 'Não foi possível salvar a revisão.');
        return;
      }
    }
    setTimesheets((rows) => rows.map((row) => row.id === selectedQueue.id ? {
      ...row,
      name: draftName.trim() || 'Servidor não identificado',
      matricula: draftMatricula.trim() || null,
      competencia: draftCompetencia,
      note: draftNote,
      status: nextStatus,
      status_label: nextLabel,
      reviewed_at: action === 'reject' ? date : date,
    } : row));
    setAudit((items) => [{ id: selectedQueue.id, name: draftName.trim() || 'Servidor não identificado', action: action === 'confirm' ? 'Folha arquivada' : action === 'pending' ? 'Folha encaminhada para pendência' : 'Processamento rejeitado', status: nextStatus, competencia: draftCompetencia, date }, ...items]);
    announce(`${draftName.trim() || selectedQueue.name} atualizado: ${nextLabel}.`);
    setSelectedQueueId(null);
  };

  const processBatch = async () => {
    if (!batchFile) {
      announce('Selecione um arquivo para iniciar o lote.');
      return;
    }
    if (apiOnline) {
      try {
        const result = await apiRequest<{ id: string }>('/batches', { method: 'POST', body: JSON.stringify({ filename: batchFile.name, competency }) });
        await refreshFromApi();
        setBatchFile(null);
        if (batchInputRef.current) batchInputRef.current.value = '';
        setSelectedQueueId(result.id);
        navigate('ocr');
        announce(`Lote recebido. ${batchFile.name} foi encaminhado para conferência manual.`);
        return;
      } catch (error) {
        announce(error instanceof Error ? error.message : 'Não foi possível receber o lote.');
        return;
      }
    }
    const nextId = `F-${1050 + timesheets.length}`;
    const newRow: Timesheet = { id: nextId, name: 'Servidor não identificado', matricula: null, competencia: competency, confidence: 0, status: 'ocr_indisponivel', status_label: statusLabels.ocr_indisponivel, reviewed_at: null, note: `Lote manual: ${batchFile.name}` };
    setTimesheets((rows) => [...rows, newRow]);
    setBatchFile(null);
    if (batchInputRef.current) batchInputRef.current.value = '';
    setSelectedQueueId(nextId);
    navigate('ocr');
    announce(`Lote recebido. ${batchFile.name} foi encaminhado para conferência manual.`);
  };

  const validateImport = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!importFile) {
      announce('Selecione uma planilha antes de validar.');
      return;
    }
    setImportPreview(true);
    announce('Prévia validada: 4 linhas prontas e 1 linha para correção.');
  };

  const confirmImport = async () => {
    if (apiOnline) {
      try {
        await apiRequest('/employees/import', {
          method: 'POST',
          body: JSON.stringify([{ name: 'Rafael Moura', matricula: '2026099', cpfLastDigits: '67', email: 'rafael.moura@undf.edu.br', workloadHours: 40, accumulatesRole: false }]),
        });
        await refreshFromApi();
        setImportPreview(false);
        setImportFile(null);
        if (employeeInputRef.current) employeeInputRef.current.value = '';
        announce('Importação concluída e salva no banco de dados.');
        return;
      } catch (error) {
        announce(error instanceof Error ? error.message : 'Não foi possível importar os servidores.');
        return;
      }
    }
    const newEmployee: Employee = { id: 20, name: 'Rafael Moura', matricula: '2026099', cpf: '***.***.***-67', email: 'rafael.moura@undf.edu.br', carga_horaria: 40, acumula: false };
    setEmployees((rows) => [...rows, newEmployee]);
    setImportPreview(false);
    setImportFile(null);
    if (employeeInputRef.current) employeeInputRef.current.value = '';
    announce('Importação concluída: 4 servidores adicionados ao cadastro.');
  };

  const authorizeDispatch = async (id: number) => {
    if (apiOnline) {
      try {
        await apiRequest(`/dispatches/${id}/authorize`, { method: 'PATCH' });
        await refreshFromApi();
        announce('Despacho autorizado. O envio simulado está liberado.');
        return;
      } catch (error) {
        announce(error instanceof Error ? error.message : 'Não foi possível autorizar o despacho.');
        return;
      }
    }
    setDispatches((items) => items.map((item) => item.id === id ? { ...item, authorized_at: new Date().toISOString() } : item));
    announce('Despacho autorizado. O envio simulado está liberado.');
  };

  const simulateSend = async (id: number) => {
    if (apiOnline) {
      try {
        await apiRequest(`/dispatches/${id}/send`, { method: 'PATCH' });
        await refreshFromApi();
        announce('Envio simulado com sucesso. Nenhuma mensagem real foi enviada.');
        return;
      } catch (error) {
        announce(error instanceof Error ? error.message : 'Não foi possível simular o envio.');
        return;
      }
    }
    setDispatches((items) => items.map((item) => item.id === id ? { ...item, status: 'enviado', sent_at: new Date().toISOString(), error_message: null } : item));
    announce('Envio simulado com sucesso. Nenhuma mensagem real foi enviada.');
  };

  const resendDispatch = async (id: number) => {
    if (apiOnline) {
      try {
        await apiRequest(`/dispatches/${id}/resend`, { method: 'PATCH' });
        await refreshFromApi();
        announce('Despacho devolvido para a fila de autorização.');
        return;
      } catch (error) {
        announce(error instanceof Error ? error.message : 'Não foi possível reenviar o despacho.');
        return;
      }
    }
    setDispatches((items) => items.map((item) => item.id === id ? { ...item, status: 'pendente', error_message: null, sent_at: null, authorized_at: null } : item));
    announce('Despacho devolvido para a fila de autorização.');
  };

  if (!authenticated) {
    return (
      <>
        <section className="login-page" aria-labelledby="login-heading">
          <div className="login-rail">
            <div className="login-rail-content">
              <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
              <p className="login-overline">UnDF · DIGEP</p>
              <h1 id="login-heading">Ponto Digital<br />DIGEP</h1>
              <p className="login-rail-copy">Uma mesa de operações para receber, conferir e guardar as folhas de ponto com clareza.</p>
            </div>
            <div className="login-rail-foot">
              <div><strong>Ambiente de demonstração</strong>Dados locais para treinamento da equipe.</div>
              <span className="rail-signal"><i className="signal-dot" /> Sistema disponível</span>
            </div>
          </div>
          <div className="login-panel">
            <div className="login-card">
              <p className="eyebrow">Acesso ao sistema</p>
              <h2>Bom trabalho por aqui.</h2>
              <p className="login-description">Entre com suas credenciais para acompanhar o processamento das folhas da DIGEP.</p>
              <form className="form-stack" onSubmit={handleLogin}>
                <label className="field-label">Usuário ou e-mail
                  <input data-testid="input-login-user" value={loginUser} onChange={(event) => setLoginUser(event.target.value)} placeholder="admin@undf.edu.br" autoComplete="username" />
                </label>
                <label className="field-label">Senha
                  <span className="password-input">
                    <input data-testid="input-login-password" value={loginPassword} onChange={(event) => setLoginPassword(event.target.value)} type={passwordVisible ? 'text' : 'password'} placeholder="Digite sua senha" autoComplete="current-password" />
                    <button data-testid="button-toggle-password" className="inline-action" type="button" onClick={() => setPasswordVisible((visible) => !visible)}>{passwordVisible ? 'Ocultar' : 'Mostrar'}</button>
                  </span>
                </label>
                <div className="form-options">
                  <label className="check-label"><input data-testid="checkbox-remember-access" type="checkbox" defaultChecked /> Lembrar acesso</label>
                  <button data-testid="button-forgot-password" className="inline-action" type="button" onClick={() => announce('Para redefinir seu acesso, procure a administração da DIGEP.')}>Esqueci minha senha</button>
                </div>
                {loginError && <p className="error-note" role="alert" data-testid="status-login-error">{loginError}</p>}
                <Button data-testid="button-submit-login" className="primary-button login-button" type="submit">Entrar <ArrowRight size={16} /></Button>
              </form>
              <p className="login-footnote">Projeto acadêmico desenvolvido na disciplina Estágio Empresarial I · Engenharia de Software · UnDF · 2026.2.</p>
            </div>
          </div>
        </section>
        <Toast message={toast} />
      </>
    );
  }

  const navPrimary = [
    { id: 'dashboard' as View, label: 'Dashboard', icon: LayoutDashboard },
    { id: 'ocr' as View, label: 'Conferência OCR', icon: ClipboardCheck, count: dashboard.review + dashboard.low_confidence },
    { id: 'arquivo' as View, label: 'Arquivo de folhas', icon: FileArchive },
    { id: 'novo-lote' as View, label: 'Novo lote', icon: Upload },
  ];
  const navManagement = [
    { id: 'servidores' as View, label: 'Servidores', icon: Users },
    { id: 'envios' as View, label: 'Fila de envios', icon: Send, count: dashboard.dispatch_pending },
    { id: 'auditoria' as View, label: 'Auditoria', icon: History },
  ];

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileOpen ? 'open' : ''}`} aria-label="Navegação principal">
        <div className="sidebar-brand"><div className="brand-mark" aria-hidden="true"><span /><span /><span /></div><div><strong>Ponto Digital DIGEP</strong><small>DIGEP · UnDF</small></div></div>
        <div className="env-badge"><span className="signal-dot" /> Ambiente de demonstração</div>
        <NavGroup label="Visão geral" items={navPrimary} view={view} navigate={navigate} />
        <NavGroup label="Gestão" items={navManagement} view={view} navigate={navigate} />
        <div className="sidebar-bottom">
          <button data-testid="button-about-project" className="nav-button" type="button" onClick={() => setAboutOpen(true)}><CircleHelp size={16} /> <span>Sobre o projeto</span></button>
          <button data-testid="button-logout" className="nav-button" type="button" onClick={handleLogout}><LogOut size={16} /> <span>Sair</span></button>
          <div className="user-chip"><span className="avatar">{initials(user.name)}</span><div><strong data-testid="text-sidebar-username">{user.name}</strong><span>{user.role}</span></div></div>
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <button data-testid="button-mobile-menu" className="mobile-menu" type="button" onClick={() => setMobileOpen((open) => !open)} aria-label="Abrir menu"><Menu size={21} /></button>
          <div className="breadcrumb"><span>UnDF</span><span className="breadcrumb-separator">/</span><strong>{viewLabels[view]}</strong></div>
          <div className="topbar-actions">
            <label className="competency-picker"><span>Competência</span><select data-testid="select-competency" value={competency} onChange={(event) => selectCompetency(event.target.value)}>{competencies.map((item) => <option key={item} value={item}>{item === '07/2026' ? 'Julho / 2026' : item === '06/2026' ? 'Junho / 2026' : 'Maio / 2026'}</option>)}</select></label>
            <button data-testid="button-notifications" className="icon-button" type="button" onClick={() => announce('Não há novas notificações para esta competência.')} aria-label="Notificações"><Bell size={16} /><i className="notification-dot" /></button>
            <div className="topbar-user"><span className="avatar">{initials(user.name)}</span><div className="topbar-user-copy"><strong data-testid="text-topbar-username">{user.name}</strong><span>{user.role}</span></div></div>
          </div>
        </header>
        <div className="page-content">
          {view === 'dashboard' && <DashboardView dashboard={dashboard} competency={competency} noticeVisible={noticeVisible} setNoticeVisible={setNoticeVisible} attentionRows={attentionRows} recentActivity={recentActivity} navigate={navigate} selectQueue={selectQueue} announce={announce} />}
          {view === 'ocr' && <OcrView competency={competency} queueRows={queueRows} selectedQueue={selectedQueue} selectedQueueId={selectedQueueId} selectQueue={selectQueue} draftName={draftName} setDraftName={setDraftName} draftMatricula={draftMatricula} setDraftMatricula={setDraftMatricula} draftCompetencia={draftCompetencia} setDraftCompetencia={setDraftCompetencia} draftNote={draftNote} setDraftNote={setDraftNote} reviewAction={reviewAction} navigate={navigate} announce={announce} />}
          {view === 'arquivo' && <ArchiveView rows={filteredArchive} search={archiveSearch} setSearch={setArchiveSearch} status={archiveStatus} setStatus={setArchiveStatus} navigate={navigate} />}
          {view === 'servidores' && <EmployeesView employees={employees} importOpen={importOpen} setImportOpen={setImportOpen} importFile={importFile} setImportFile={setImportFile} importPreview={importPreview} validateImport={validateImport} confirmImport={confirmImport} inputRef={employeeInputRef} navigate={navigate} />}
          {view === 'envios' && <DispatchView dispatches={filteredDispatches} status={dispatchStatus} setStatus={setDispatchStatus} authorizeDispatch={authorizeDispatch} simulateSend={simulateSend} resendDispatch={resendDispatch} navigate={navigate} />}
          {view === 'auditoria' && <AuditView audit={audit} competency={competency} navigate={navigate} />}
          {view === 'novo-lote' && <BatchView batchFile={batchFile} setBatchFile={setBatchFile} processBatch={processBatch} inputRef={batchInputRef} navigate={navigate} />}
          <footer className="system-footer">Ponto Digital DIGEP <span>·</span> Estágio Empresarial I <span>·</span> UnDF <span>·</span> 2026.2</footer>
        </div>
      </main>
      {aboutOpen && <AboutModal close={() => setAboutOpen(false)} />}
      <Toast message={toast} />
    </div>
  );
}

function NavGroup({ label, items, view, navigate }: { label: string; items: { id: View; label: string; icon: typeof LayoutDashboard; count?: number }[]; view: View; navigate: (view: View) => void }) {
  return <nav className="nav-group" aria-label={label}><p className="nav-label">{label}</p>{items.map((item) => {
    const Icon = item.icon;
    return <button data-testid={`nav-${item.id}`} key={item.id} className={`nav-button ${view === item.id ? 'active' : ''}`} type="button" onClick={() => navigate(item.id)}><Icon size={16} /><span>{item.label}</span>{typeof item.count === 'number' && <span className="nav-count">{String(item.count).padStart(2, '0')}</span>}</button>;
  })}</nav>;
}

function DashboardView({ dashboard, competency, noticeVisible, setNoticeVisible, attentionRows, recentActivity, navigate, selectQueue, announce }: { dashboard: { total: number; recognized: number; review: number; low_confidence: number; archived: number; recognition_rate: number; dispatch_pending: number; dispatch_sent: number; dispatch_error: number }; competency: string; noticeVisible: boolean; setNoticeVisible: (visible: boolean) => void; attentionRows: Timesheet[]; recentActivity: Timesheet[]; navigate: (view: View) => void; selectQueue: (id: string) => void; announce: (message: string) => void }) {
  const totalDispatch = dashboard.dispatch_pending + dashboard.dispatch_sent + dashboard.dispatch_error;
  const sentAngle = totalDispatch ? `${(dashboard.dispatch_sent / totalDispatch) * 360}deg` : '0deg';
  return <section aria-labelledby="dashboard-heading">
    <div className="page-heading"><div><p className="eyebrow">Gestão de folhas de ponto</p><h1 id="dashboard-heading">Gestão de Folhas de Ponto</h1><p className="heading-support">Acompanhe o recebimento, a conferência e o arquivamento da competência selecionada.</p><p className="credit-inline"><b>Competência ativa:</b> {competency} <span>·</span> Ambiente local de demonstração</p></div><Button data-testid="button-new-processing" className="primary-button" onClick={() => navigate('novo-lote')}><Upload size={15} /> Novo processamento</Button></div>
    {noticeVisible && <div className="notice" data-testid="notice-processing"><span className="notice-icon"><Info size={11} /></span><div><strong>Processamento real em modo de conferência</strong><span>Cada página recebida é registrada separadamente. Quando o OCR não estiver disponível, a folha é encaminhada para revisão manual sem preencher dados fictícios.</span></div><button data-testid="button-dismiss-notice" className="notice-close" type="button" onClick={() => setNoticeVisible(false)} aria-label="Fechar aviso"><X size={16} /></button></div>}
    <div className="metric-grid">
      <Metric label="Folhas recebidas" value={dashboard.total} foot="na competência ativa" icon={<FileText size={15} />} primary />
      <Metric label="Reconhecidas" value={dashboard.recognized} foot={`${dashboard.recognition_rate}% do total recebido`} icon={<FileCheck2 size={15} />} />
      <Metric label="Aguardando conferência" value={dashboard.review} foot="precisam de atenção" icon={<Clock3 size={15} />} tone="amber" trend="Fila ativa" />
      <Metric label="Baixa confiança" value={dashboard.low_confidence} foot="prioridade de revisão" icon={<AlertTriangle size={15} />} tone="coral" trend="Sinal" />
    </div>
    <div className="dashboard-grid">
      <article className="panel"><div className="panel-heading"><div><h2>Processamento da competência</h2><p>Progresso geral das folhas recebidas</p></div><button data-testid="button-dashboard-ocr" className="ghost-button button" type="button" onClick={() => navigate('ocr')}>Ver conferência <ArrowRight size={14} /></button></div><div className="progress-summary"><strong data-testid="text-recognition-rate">{dashboard.recognition_rate}%</strong><span>{dashboard.recognized} de {dashboard.total} folhas reconhecidas automaticamente</span></div><div className="progress-track large"><span style={{ width: `${dashboard.recognition_rate}%` }} /></div><div className="legend-grid"><Legend value={dashboard.recognized} label="Reconhecidas" tone="green" /><Legend value={dashboard.review} label="Em conferência" tone="amber" /><Legend value={dashboard.low_confidence} label="Baixa confiança" tone="coral" /></div><div className="panel-divider" /><div className="mini-stat-row"><div className="mini-stat"><span className="mini-stat-icon"><Clock3 size={14} /></span><div><strong>3m 42s</strong><span>Tempo médio de processamento</span></div></div><div className="mini-stat"><span className="mini-stat-icon green"><Archive size={14} /></span><div><strong>{dashboard.archived}</strong><span>Folhas arquivadas</span></div></div></div></article>
      <article className="panel"><div className="panel-heading"><div><h2>Atividade recente</h2><p>Últimas ações registradas no sistema</p></div><button data-testid="button-activity-more" className="icon-button" type="button" onClick={() => announce('A atividade detalhada está disponível na Auditoria.')} aria-label="Mais opções"><MoreHorizontal size={16} /></button></div><div className="activity-list">{recentActivity.length ? recentActivity.map((item) => <div className="activity-item" key={item.id}><span className="activity-bullet" style={{ background: item.status === 'arquivada' ? '#4c8878' : '#dda64e' }} /><div><strong>{item.name}</strong><span>{item.status_label} · {item.competencia}</span></div><time>{formatDate(item.reviewed_at)}</time></div>) : <div className="empty-inline">Nenhuma atividade registrada nesta competência.</div>}</div><button data-testid="button-view-audit" className="text-button" type="button" onClick={() => navigate('auditoria')}>Ver histórico completo <ArrowRight size={13} /></button></article>
    </div>
    <div className="bottom-grid">
      <article className="panel table-panel"><div className="panel-heading"><div><h2>Folhas que precisam de atenção</h2><p>Priorize os documentos com menor confiança</p></div><Button data-testid="button-attention-filter" className="secondary-button" onClick={() => navigate('ocr')}><FolderSearch size={14} /> Conferir fila</Button></div><div className="table-wrap"><table><thead><tr><th>Servidor</th><th>Matrícula</th><th>Confiança OCR</th><th>Situação</th><th /></tr></thead><tbody>{attentionRows.length ? attentionRows.map((row) => <tr key={row.id}><td><PersonCell name={row.name} tone={row.confidence < 70 ? 'amber' : ''} /></td><td className="muted-cell">{row.matricula ?? 'Não identificada'}</td><td><Confidence value={row.confidence} /></td><td><StatusPill status={row.status} /></td><td><button data-testid={`button-review-${row.id}`} className="row-action" type="button" onClick={() => { selectQueue(row.id); navigate('ocr'); }}>Revisar <ChevronRight size={12} /></button></td></tr>) : <tr><td colSpan={5}><div className="empty-inline">Nenhuma folha precisa de atenção nesta competência.</div></td></tr>}</tbody></table></div><button data-testid="button-view-all-pending" className="text-button table-footer" type="button" onClick={() => navigate('ocr')}>Ver todas as pendências <ArrowRight size={13} /></button></article>
      <article className="panel"><div className="panel-heading"><div><h2>Fila de envios</h2><p>Folhas de servidores que acumulam cargo</p></div><span className="small-badge">{dashboard.dispatch_pending} pendentes</span></div><div className="dispatch-visual"><div className="dispatch-donut" style={{ '--sent-angle': sentAngle } as React.CSSProperties}><div><strong>{totalDispatch}</strong><span>folhas</span></div></div><div className="dispatch-copy"><div><i className="legend-dot green" /><strong>{dashboard.dispatch_sent}</strong><span>Enviadas</span></div><div><i className="legend-dot amber" /><strong>{dashboard.dispatch_pending + dashboard.dispatch_error}</strong><span>Pendentes</span></div></div></div><Button data-testid="button-open-dispatch" className="secondary-button full-button" onClick={() => navigate('envios')}>Acessar fila de envios <ArrowRight size={14} /></Button></article>
    </div>
  </section>;
}

function Metric({ label, value, foot, icon, tone = '', trend, primary = false }: { label: string; value: number; foot: string; icon: React.ReactNode; tone?: string; trend?: string; primary?: boolean }) {
  return <article className={`metric-card ${primary ? 'primary' : ''}`}><div className="metric-top"><span className="metric-label">{label}</span><span className={`metric-icon ${tone}`}>{icon}</span></div><div className="metric-number" data-testid={`metric-${label}`}>{value}</div><div className="metric-foot"><span className={`trend ${tone}`}>{trend ?? '—'}</span><span>{foot}</span></div></article>;
}

function Legend({ value, label, tone }: { value: number; label: string; tone: string }) {
  return <div><i className={`legend-dot ${tone}`} /><strong>{value}</strong><span>{label}</span></div>;
}

function OcrView({ competency, queueRows, selectedQueue, selectedQueueId, selectQueue, draftName, setDraftName, draftMatricula, setDraftMatricula, draftCompetencia, setDraftCompetencia, draftNote, setDraftNote, reviewAction, navigate, announce }: { competency: string; queueRows: Timesheet[]; selectedQueue: Timesheet | null; selectedQueueId: string | null; selectQueue: (id: string) => void; draftName: string; setDraftName: (value: string) => void; draftMatricula: string; setDraftMatricula: (value: string) => void; draftCompetencia: string; setDraftCompetencia: (value: string) => void; draftNote: string; setDraftNote: (value: string) => void; reviewAction: (action: 'confirm' | 'pending' | 'reject') => void; navigate: (view: View) => void; announce: (message: string) => void }) {
  return <section aria-labelledby="ocr-heading"><div className="page-heading"><div><p className="eyebrow">Processamento · {competency}</p><h1 id="ocr-heading">Conferência de OCR</h1><p className="heading-support">Revise os dados extraídos antes de arquivar cada folha.</p></div><div className="heading-actions"><Button data-testid="button-ocr-back" className="secondary-button" onClick={() => navigate('dashboard')}><ArrowLeft size={14} /> Dashboard</Button><Button data-testid="button-ocr-new-batch" className="primary-button" onClick={() => navigate('novo-lote')}><Upload size={14} /> Novo lote</Button></div></div><div className="page-toolbar"><div className="toolbar-status"><i className="live-dot" /><strong>{queueRows.length} {queueRows.length === 1 ? 'folha' : 'folhas'} aguardando conferência</strong><span>· Atualizado agora</span></div><div className="toolbar-actions"><Button data-testid="button-ocr-refresh" className="secondary-button" onClick={() => announce('Fila atualizada com os dados locais mais recentes.')}><RefreshCw size={14} /> Atualizar</Button></div></div><div className="ocr-layout"><article className="panel queue-panel"><div className="queue-header"><div><h2>Fila de conferência</h2><p>Selecione uma folha para revisar</p></div><span className="queue-count">{String(queueRows.length).padStart(2, '0')}</span></div><div className="queue-list">{queueRows.length ? queueRows.map((row) => <button data-testid={`queue-item-${row.id}`} key={row.id} className={`queue-item ${selectedQueueId === row.id ? 'selected' : ''}`} type="button" onClick={() => selectQueue(row.id)}><span className="queue-thumb">REGISTRO<br />DE<br />FREQUÊNCIA</span><span className="queue-item-copy"><strong>{row.name}</strong><span>Mat. {row.matricula ?? 'não encontrada'} · {row.competencia}</span><span><StatusPill status={row.status} /><small className="queue-confidence">{row.confidence}%</small></span></span><ChevronRight size={15} className="queue-chevron" /></button>) : <div className="empty-inline">A fila de conferência está limpa para esta competência.</div>}</div><div className="queue-footer"><span><strong>{selectedQueue ? queueRows.findIndex((row) => row.id === selectedQueue.id) + 1 : 0}</strong> de {queueRows.length} selecionada</span><span>Use a lista para navegar</span></div></article><article className="panel review-panel"><div className="review-header"><div><span className="review-kicker">Folha selecionada</span><h2>{selectedQueue?.name ?? 'Selecione uma folha'}</h2><p>{selectedQueue ? `Matrícula ${selectedQueue.matricula ?? 'não encontrada'} · Referência ${selectedQueue.competencia}` : 'Escolha um item na fila ao lado'}</p></div><div className="review-status">{selectedQueue ? <StatusPill status={selectedQueue.status} /> : <StatusPill status="ocr_indisponivel" label="Sem seleção" />}</div></div>{selectedQueue ? <><div className="review-body"><DocumentViewer selectedQueue={selectedQueue} announce={announce} /><div className="recognized-data"><div className="recognized-heading"><div><h3>Dados reconhecidos</h3><span>Revise e confirme a associação</span></div><button data-testid="button-confidence-info" className="inline-action" type="button" onClick={() => announce('A confiança indica a segurança da leitura automática por campo.')}>Info confiança</button></div><div className="confidence-card"><div className="confidence-card-top"><span>Confiança geral</span><strong>{selectedQueue.confidence}%</strong></div><div className="progress-track"><span style={{ width: `${selectedQueue.confidence}%`, background: selectedQueue.confidence < 70 ? '#c95c4c' : '#dda64e' }} /></div><p>{selectedQueue.confidence < 70 ? 'Revise os campos destacados antes de associar.' : selectedQueue.confidence === 0 ? 'OCR indisponível: preencha os dados manualmente.' : 'Alguns campos podem precisar de revisão.'}</p></div><form className="data-form" onSubmit={(event) => event.preventDefault()}><label className="field-label">Matrícula <span className="field-confidence">leitura manual</span><input data-testid="input-review-matricula" value={draftMatricula} onChange={(event) => setDraftMatricula(event.target.value)} placeholder="Ex.: 2024187" /></label><label className="field-label">Nome do servidor <input data-testid="input-review-name" value={draftName} onChange={(event) => setDraftName(event.target.value)} placeholder="Nome completo" /></label><label className="field-label">Competência <select data-testid="select-review-competency" value={draftCompetencia} onChange={(event) => setDraftCompetencia(event.target.value)}>{competencies.map((item) => <option key={item} value={item}>{item}</option>)}</select></label><label className="field-label">Observação <span className="field-confidence">opcional</span><textarea data-testid="textarea-review-note" value={draftNote} onChange={(event) => setDraftNote(event.target.value)} placeholder="Adicione uma observação sobre esta conferência..." /></label></form><div className="association-check"><span className="check-icon"><Check size={11} /></span><div><strong>{draftMatricula && draftName ? 'Servidor identificado' : 'Associação pendente'}</strong><span>{draftMatricula && draftName ? 'Matrícula e nome prontos para conferência.' : 'Preencha matrícula e nome para completar o registro.'}</span></div></div></div></div><div className="review-footer"><button data-testid="button-reject-review" className="row-action" type="button" onClick={() => reviewAction('reject')}>Rejeitar processamento</button><div className="review-footer-actions"><Button data-testid="button-pending-review" className="secondary-button" onClick={() => reviewAction('pending')}>Encaminhar para pendência</Button><Button data-testid="button-confirm-review" className="primary-button" onClick={() => reviewAction('confirm')}><CheckCircle2 size={14} /> Confirmar e arquivar</Button></div></div></> : <div className="empty-inline">Selecione uma folha na fila para abrir a visualização protegida.</div>}</article></div></section>;
}

function DocumentViewer({ selectedQueue, announce }: { selectedQueue: Timesheet; announce: (message: string) => void }) {
  const [zoom, setZoom] = useState(100);
  const changeZoom = (amount: number) => {
    setZoom((current) => {
      const next = Math.min(140, Math.max(80, current + amount));
      announce(`Zoom ajustado para ${next}%.`);
      return next;
    });
  };

  return <div className="document-viewer"><div className="viewer-toolbar"><span>Visualização da folha</span><div className="viewer-controls"><button data-testid="button-zoom-out" type="button" onClick={() => changeZoom(-10)} disabled={zoom === 80} aria-label="Diminuir zoom"><ZoomOut size={13} /></button><span>{zoom}%</span><button data-testid="button-zoom-in" type="button" onClick={() => changeZoom(10)} disabled={zoom === 140} aria-label="Aumentar zoom"><ZoomIn size={13} /></button></div></div><div className="paper-stage"><div className="paper" style={{ transform: `scale(${zoom / 100})`, transformOrigin: 'top center', marginBottom: `${(zoom - 100) * 4}px` }}><div className="paper-brand">UnDF <span>UNIVERSIDADE DO DISTRITO FEDERAL</span></div><h3>REGISTRO DE FREQUÊNCIA</h3><div className="paper-rule" /><div className="paper-meta"><span>REFERÊNCIA: <b>{selectedQueue.competencia}</b></span><span>UA: <b>DIGEP</b></span><span>MATRÍCULA: <b>{selectedQueue.matricula ?? '—'}</b></span></div><div className="paper-field"><span>NOME DO SERVIDOR:</span><b>{(selectedQueue.name || 'SELECIONE UMA FOLHA').toUpperCase()}</b></div><div className="paper-fields-row"><span>CARGO: <b>—</b></span><span>PADRÃO: <b>—</b></span></div><div className="paper-field"><span>EXERCÍCIO:</span><b>2026</b></div><div className="paper-calendar"><div className="calendar-head"><span>DIA</span><span>ENTRADA</span><span>SAÍDA</span><span>ENTRADA</span><span>SAÍDA</span></div><div className="calendar-row faded"><span>...</span><span>...</span><span>...</span><span>...</span><span>...</span></div><div className="calendar-row faded"><span>...</span><span>...</span><span>...</span><span>...</span><span>...</span></div></div><div className="paper-signature"><span>Observações:</span><div /><div /></div><div className="paper-footer">Documento demonstrativo · visualização protegida</div></div></div></div>;
}

function ArchiveView({ rows, search, setSearch, status, setStatus, navigate }: { rows: Timesheet[]; search: string; setSearch: (value: string) => void; status: string; setStatus: (value: string) => void; navigate: (view: View) => void }) {
  return <section aria-labelledby="archive-heading"><div className="page-heading"><div><p className="eyebrow">Gestão · Arquivo</p><h1 id="archive-heading">Arquivo de folhas</h1><p className="heading-support">Consulte as folhas processadas por competência, situação e identificação do servidor.</p></div><Button data-testid="button-archive-dashboard" className="secondary-button" onClick={() => navigate('dashboard')}><ArrowLeft size={14} /> Dashboard</Button></div><article className="panel table-panel"><div className="panel-heading"><div><h2>Folhas processadas</h2><p>{rows.length} registro{rows.length === 1 ? '' : 's'} encontrado{rows.length === 1 ? '' : 's'} em {status === 'todos' ? 'todos os status' : statusLabels[status as Status]}</p></div><div className="table-tools"><span className="search-wrap"><Search size={15} /><input data-testid="input-archive-search" className="search-field" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Nome, matrícula ou ID" /></span><select data-testid="select-archive-status" className="select-field" value={status} onChange={(event) => setStatus(event.target.value)}><option value="todos">Todos os status</option><option value="arquivada">Arquivadas</option><option value="reconhecida">Reconhecidas</option><option value="revisao">Em revisão</option><option value="pendente">Pendentes</option><option value="baixa_confianca">Baixa confiança</option><option value="ocr_indisponivel">OCR indisponível</option><option value="rejeitada">Rejeitadas</option></select></div></div><div className="table-wrap"><table><thead><tr><th>ID</th><th>Servidor</th><th>Matrícula</th><th>Competência</th><th>Situação</th><th>Confiança</th><th>Revisão</th></tr></thead><tbody>{rows.length ? rows.map((row) => <tr key={row.id}><td><span className="muted-cell">{row.id}</span></td><td><PersonCell name={row.name} /></td><td className="muted-cell">{row.matricula ?? '—'}</td><td>{row.competencia}</td><td><StatusPill status={row.status} /></td><td><Confidence value={row.confidence} /></td><td className="muted-cell">{formatDate(row.reviewed_at)}</td></tr>) : <tr><td colSpan={7}><div className="empty-inline"><PackageOpen size={22} /> Nenhuma folha encontrada com esses filtros.</div></td></tr>}</tbody></table></div></article></section>;
}

function EmployeesView({ employees, importOpen, setImportOpen, importFile, setImportFile, importPreview, validateImport, confirmImport, inputRef, navigate }: { employees: Employee[]; importOpen: boolean; setImportOpen: (open: boolean) => void; importFile: File | null; setImportFile: (file: File | null) => void; importPreview: boolean; validateImport: (event: FormEvent<HTMLFormElement>) => void; confirmImport: () => void; inputRef: React.RefObject<HTMLInputElement | null>; navigate: (view: View) => void }) {
  return <section aria-labelledby="employees-heading"><div className="page-heading"><div><p className="eyebrow">Gestão · Cadastro</p><h1 id="employees-heading">Servidores</h1><p className="heading-support">Consulte e importe dados de servidores para associar às folhas de ponto.</p></div><div className="heading-actions"><Button data-testid="button-employees-dashboard" className="secondary-button" onClick={() => navigate('dashboard')}><ArrowLeft size={14} /> Dashboard</Button><Button data-testid="button-toggle-import" className="primary-button" onClick={() => setImportOpen(!importOpen)}><FileSpreadsheet size={14} /> {importOpen ? 'Fechar importação' : 'Importar planilha'}</Button></div></div><article className="panel table-panel"><div className="panel-heading"><div><h2>Servidores cadastrados</h2><p>{employees.length} registros com dados pessoais protegidos</p></div><ShieldCheck size={19} color="#4d8374" /></div><div className="table-wrap"><table><thead><tr><th>ID</th><th>Nome</th><th>Matrícula</th><th>CPF</th><th>E-mail</th><th>Carga horária</th><th>Acúmulo</th></tr></thead><tbody>{employees.map((employee) => <tr key={employee.id}><td className="muted-cell">{employee.id}</td><td><PersonCell name={employee.name} /></td><td>{employee.matricula}</td><td className="muted-cell">{employee.cpf}</td><td className="muted-cell">{employee.email}</td><td>{employee.carga_horaria}h</td><td>{employee.acumula ? <StatusPill status="pendente" label="Sim" /> : <StatusPill status="reconhecida" label="Não" />}</td></tr>)}</tbody></table></div></article>{importOpen && <article className="panel import-panel"><form className="import-form" onSubmit={validateImport}><label className="field-label">Planilha de servidores<input ref={inputRef} data-testid="input-employee-file" type="file" accept=".csv,.xlsx" onChange={(event) => setImportFile(event.target.files?.[0] ?? null)} /><span className="import-help">Colunas esperadas: Nome, Matrícula, CPF, E-mail, Carga Horária e Acumula cargo.</span></label><Button data-testid="button-validate-import" className="primary-button" type="submit"><ClipboardCheck size={14} /> Validar planilha</Button></form>{importFile && <div className="file-selected" data-testid="status-import-file"><FileSpreadsheet size={15} /> {importFile.name}</div>}{importPreview && <div className="import-result" data-testid="panel-import-preview"><div className="import-summary"><strong>Prévia pronta</strong><br />4 linhas válidas de 5 encontradas. Uma linha requer correção antes de uma próxima importação.</div><table className="import-preview"><thead><tr><th>Nome</th><th>Matrícula</th><th>Ação</th></tr></thead><tbody><tr><td>Rafael Moura</td><td>2026099</td><td><StatusPill status="reconhecida" label="Inserir" /></td></tr><tr><td>1 linha</td><td>CPF incompleto</td><td><StatusPill status="revisao" label="Revisar" /></td></tr></tbody></table><Button data-testid="button-confirm-import" className="primary-button" type="button" onClick={confirmImport}><CheckCircle2 size={14} /> Confirmar linhas válidas</Button></div>}</article>}</section>;
}

function DispatchView({ dispatches, status, setStatus, authorizeDispatch, simulateSend, resendDispatch, navigate }: { dispatches: Dispatch[]; status: string; setStatus: (value: string) => void; authorizeDispatch: (id: number) => void; simulateSend: (id: number) => void; resendDispatch: (id: number) => void; navigate: (view: View) => void }) {
  return <section aria-labelledby="dispatch-heading"><div className="page-heading"><div><p className="eyebrow">Gestão · Envios</p><h1 id="dispatch-heading">Fila de envios</h1><p className="heading-support">Autorize e acompanhe o despacho simulado de folhas para servidores que acumulam cargo.</p></div><Button data-testid="button-dispatch-dashboard" className="secondary-button" onClick={() => navigate('dashboard')}><ArrowLeft size={14} /> Dashboard</Button></div><div className="notice"><span className="notice-icon"><ShieldCheck size={11} /></span><div><strong>Envio simulado e autorizado por pessoa</strong><span>Nenhuma mensagem real é enviada nesta demonstração. A autorização fica registrada para a trilha de auditoria.</span></div></div><article className="panel table-panel"><div className="panel-heading"><div><h2>Despachos de e-mail</h2><p>{dispatches.length} registro{dispatches.length === 1 ? '' : 's'} na fila</p></div><select data-testid="select-dispatch-status" className="select-field" value={status} onChange={(event) => setStatus(event.target.value)}><option value="todos">Todos os status</option><option value="pendente">Pendentes</option><option value="enviado">Enviados</option><option value="erro">Com erro</option></select></div><div className="table-wrap"><table><thead><tr><th>ID</th><th>Servidor</th><th>Matrícula</th><th>Status</th><th>Data</th><th>Observação</th><th>Ações</th></tr></thead><tbody>{dispatches.length ? dispatches.map((item) => <tr key={item.id}><td className="muted-cell">#{item.id}</td><td><PersonCell name={item.employee_name} /></td><td>{item.employee_matricula}</td><td><StatusPill status={item.status} /></td><td className="muted-cell">{formatDate(item.sent_at ?? item.authorized_at ?? item.created_at)}</td><td className="muted-cell">{item.error_message ?? (item.authorized_at && item.status === 'pendente' ? 'Autorizado para simulação' : '—')}</td><td>{item.status === 'erro' ? <button data-testid={`button-resend-${item.id}`} className="row-action" type="button" onClick={() => resendDispatch(item.id)}><RotateCcw size={12} /> Reenviar</button> : item.status === 'pendente' && item.authorized_at ? <button data-testid={`button-send-${item.id}`} className="row-action" type="button" onClick={() => simulateSend(item.id)}><MailCheck size={12} /> Simular envio</button> : item.status === 'pendente' ? <button data-testid={`button-authorize-${item.id}`} className="row-action" type="button" onClick={() => authorizeDispatch(item.id)}><ShieldCheck size={12} /> Autorizar</button> : <span className="muted-cell">Concluído</span>}</td></tr>) : <tr><td colSpan={7}><div className="empty-inline">Nenhum despacho encontrado neste filtro.</div></td></tr>}</tbody></table></div></article></section>;
}

function AuditView({ audit, competency, navigate }: { audit: AuditItem[]; competency: string; navigate: (view: View) => void }) {
  const rows = audit.filter((item) => item.competencia === competency);
  return <section aria-labelledby="audit-heading"><div className="page-heading"><div><p className="eyebrow">Gestão · Auditoria</p><h1 id="audit-heading">Auditoria</h1><p className="heading-support">Registro das conferências e alterações realizadas nas folhas de ponto.</p></div><Button data-testid="button-audit-dashboard" className="secondary-button" onClick={() => navigate('dashboard')}><ArrowLeft size={14} /> Dashboard</Button></div><article className="panel table-panel"><div className="panel-heading"><div><h2>Registro de auditoria</h2><p>Competência {competency} · alterações locais nesta sessão</p></div><History size={18} color="#4d8374" /></div><div className="table-wrap"><table><thead><tr><th>ID folha</th><th>Servidor</th><th>Ação</th><th>Situação</th><th>Competência</th><th>Data</th></tr></thead><tbody>{rows.length ? rows.map((item, index) => <tr key={`${item.id}-${index}`}><td className="muted-cell">{item.id}</td><td><PersonCell name={item.name} /></td><td>{item.action}</td><td><StatusPill status={item.status} /></td><td>{item.competencia}</td><td className="muted-cell">{formatDate(item.date)}</td></tr>) : <tr><td colSpan={6}><div className="empty-inline"><History size={22} /> Nenhum registro de auditoria nesta competência.</div></td></tr>}</tbody></table></div></article></section>;
}

function BatchView({ batchFile, setBatchFile, processBatch, inputRef, navigate }: { batchFile: File | null; setBatchFile: (file: File | null) => void; processBatch: () => void; inputRef: React.RefObject<HTMLInputElement | null>; navigate: (view: View) => void }) {
  return <section aria-labelledby="batch-heading"><div className="page-heading"><div><p className="eyebrow">Processamento · Novo lote</p><h1 id="batch-heading">Receber folhas de ponto</h1><p className="heading-support">Envie um arquivo e acompanhe cada página como um documento individual.</p></div><Button data-testid="button-batch-dashboard" className="secondary-button" onClick={() => navigate('dashboard')}><ArrowLeft size={14} /> Dashboard</Button></div><article className="batch-card"><span className="upload-symbol"><Upload size={22} /></span><h2>Envie o arquivo do lote</h2><p>PDF, PNG ou JPG até 20 MB. O arquivo original permanece em armazenamento privado durante a demonstração.</p>{batchFile && <div className="file-selected" data-testid="status-batch-file"><FileText size={15} /> {batchFile.name}</div>}<input ref={inputRef} data-testid="input-batch-file" className="hidden" type="file" accept=".pdf,.png,.jpg,.jpeg" onChange={(event) => setBatchFile(event.target.files?.[0] ?? null)} /><Button data-testid="button-select-batch-file" className="secondary-button" type="button" onClick={() => inputRef.current?.click()}><Upload size={14} /> {batchFile ? 'Trocar arquivo' : 'Selecionar arquivo'}</Button>{batchFile && <><br /><Button data-testid="button-process-batch" className="primary-button" type="button" onClick={processBatch}>Iniciar processamento <ArrowRight size={14} /></Button></>}<p className="batch-note">Sem OCR instalado, cada página ficará marcada como “OCR indisponível” para conferência manual. Este fallback não inventa dados.</p></article></section>;
}

function AboutModal({ close }: { close: () => void }) {
  return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="about-title" onClick={(event) => { if (event.currentTarget === event.target) close(); }}><div className="modal-card"><button data-testid="button-close-about" className="modal-close" type="button" onClick={close} aria-label="Fechar"><X size={19} /></button><div className="brand-mark" style={{ background: '#e6f0ea' }} aria-hidden="true"><span /><span /><span /></div><p className="eyebrow">Sobre o projeto</p><h2 id="about-title">Ponto Digital DIGEP</h2><p>Sistema de gestão de folhas de ponto para recebimento, conferência, arquivamento e despacho administrativo da Universidade do Distrito Federal.</p><div className="project-principles"><section><h3>Missão</h3><p>Digitalizar e otimizar a gestão das folhas de ponto, tornando o processo de recebimento, conferência e arquivamento mais ágil, seguro e organizado.</p></section><section><h3>Visão</h3><p>Ser uma solução de referência para a gestão digital de folhas de ponto, promovendo eficiência, transparência e redução de processos manuais.</p></section><section><h3>Valores</h3><ul><li><strong>Eficiência</strong> — simplificar e agilizar processos.</li><li><strong>Segurança</strong> — proteger informações e dados dos servidores.</li><li><strong>Transparência</strong> — garantir rastreabilidade das ações.</li><li><strong>Organização</strong> — facilitar o armazenamento e acesso às informações.</li><li><strong>Inovação</strong> — utilizar tecnologia para melhorar a gestão.</li><li><strong>Confiabilidade</strong> — garantir informações consistentes e processos seguros.</li><li><strong>Responsabilidade</strong> — respeitar a privacidade e a legislação, especialmente a LGPD.</li></ul></section></div><div className="credit-block"><strong>Desenvolvimento do sistema</strong><span>Jasmine de Sá Araujo</span><strong>Identidade visual</strong><span>Francisco Daniel Bento dos Santos e Estevão Souza Araújo</span></div></div></div>;
}

function Toast({ message }: { message: string }) {
  return <div className={`toast ${message ? 'visible' : ''}`} role="status" data-testid="status-toast"><span className="toast-icon"><Check size={11} /></span><span>{message}</span></div>;
}

function RoutedErrorBoundary({ children }: { children: React.ReactNode }) {
  return <ErrorBoundary resetKey="ponto-digital">{children}</ErrorBoundary>;
}

export default function RootApp() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><RoutedErrorBoundary><App /></RoutedErrorBoundary><Toaster /></TooltipProvider></QueryClientProvider>;
}