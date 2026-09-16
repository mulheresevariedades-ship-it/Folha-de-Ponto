# Relatório do Projeto — Ponto Digital DIGEP (FolhaPonto)

## 1. Visão geral

Sistema web para recebimento, conferência e arquivamento de **folhas de ponto dos professores da DIGEP/UnDF**, com OCR de PDFs escaneados, autenticação por perfis, adequação à LGPD e fila simulada de envio de e-mails ao RH.

| Item | Valor |
|---|---|
| Linguagem | Python 3.12 |
| Framework | FastAPI + Uvicorn |
| Banco de dados | SQLite (via `sqlite3` padrão) |
| Frontend | HTML/CSS/JS puro (SPA em `index.html`/`app.js`) |
| OCR | Tesseract + pré-processamento Pillow |
| Repositório | `https://github.com/Daniel-Francisc/FolhaPonto.git` |
| Branch principal | `main` |
| CI | GitHub Actions (`.github/workflows/python-app.yml`) |

## 2. Entregas por fase (11 fases)

| Fase | Descrição | Status |
|---|---|---|
| 1 | CI/CD, `pyproject.toml`, `.env.example`, documentação | ✔ Concluída |
| 2 | Segurança/LGPD: mascaramento e criptografia de CPF | ✔ Concluída |
| 3 | Autenticação JWT com perfis (admin/operador/consulta) | ✔ Concluída |
| 4 | OCR com pré-processamento (grayscale, contraste, binarização, deskew) | ✔ Concluída |
| 5 | Importação de servidores (CSV/XLSX) com prévia | ✔ Concluída |
| 6 | Views de arquivo e conferência com zoom/rotação | ✔ Concluída |
| 7 | Fila de envio de e-mail (simulada) | ✔ Concluída |
| 8 | Dashboard e auditoria alimentados pelo banco | ✔ Concluída |
| 9 | Migrações e estrutura do banco | ✔ Concluída |
| 10 | Testes automatizados (37) | ✔ Concluída |
| 11 | Documentação completa (README RF01–RF12) | ✔ Concluída |

## 3. Arquitetura

### 3.1 Componentes

| Componente | Arquivo | Função |
|---|---|---|
| API principal | `server.py` (1017 linhas) | 21 endpoints, autenticação, lotes, revisão, importação, fila de envio |
| Autenticação | `auth.py` | JWT (python-jose), bcrypt, revogação de token, `require_roles` |
| LGPD | `security.py` | `mask_cpf`, `validate_cpf`, criptografia Fernet de CPF |
| Models | `models.py` | Schemas Pydantic (login, review, dispatch, etc.) |
| Processamento/OCR | `FolhaPontoBack/processing.py` | Extração, pré-processamento PIL, classificação por confiança |
| Frontend | `index.html` (399 linhas), `app.js` (662 linhas), `styles.css` | Interface completa |

### 3.2 Endpoints (21)

| Grupo | Endpoints |
|---|---|
| Saúde | `GET /api/health` |
| Autenticação | `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/me` |
| Dashboard | `GET /api/dashboard` |
| Folhas | `GET /api/timesheets` · `GET /api/timesheets/{id}` · `POST .../{id}/review` · `POST .../{id}/pending` · `POST .../{id}/reject` · `GET .../{id}/download` |
| Lotes | `POST /api/batches` |
| Servidores | `GET /api/employees` · `POST /api/employees/import/preview` · `POST /api/employees/import/confirm` |
| Envios | `GET /api/dispatches` · `POST /api/dispatches/{id}/authorize` · `POST .../simulate-send` · `POST .../resend` |
| Interface | `GET /` · `GET /styles.css` · `GET /app.js` |

## 4. Segurança e LGPD

- **CPF nunca é exposto**: formato mascarado `***.***.***-XX` em todas as respostas.
- **Criptografia em repouso**: CPF cifrado com Fernet usando `CPF_ENCRYPTION_KEY`.
- **Autenticação JWT**: tokens com expiração, revogação por logout e auditoria por usuário.
- **3 perfis de acesso**: admin, operador e consulta, com restrição por rota.
- **Validação de CPF**: dígitos verificadores conferidos na importação.
- **Admin inicial**: bootstrap via variáveis de ambiente (`ADMIN_USERNAME`/`ADMIN_PASSWORD`).

## 5. Testes automatizados

**Total: 37 testes — 37 passaram** (`python -m pytest -q`, ~42s).

| Arquivo | Testes | Cobertura |
|---|---|---|
| `tests/test_comprehensive.py` | 30 | Auth, permissões, CPF/LGPD, importação CSV/XLSX, PDF 3 páginas, arquivamento, disparos, dashboard, segurança |
| `tests/test_phase2.py` | 5 | Autenticação e fluxos da fase 2 |
| `tests/test_processing.py` | 2 | Processamento de imagem/OCR |

## 6. Requisitos funcionais atendidos (RF01–RF12)

RF01 Recebimento de lotes ✔ | RF02 Upload/armazenamento ✔ | RF03 Extração de dados (OCR) ✔ | RF04 Sincronização com SIGPEP (parcial, base importação) ✔ | RF05 Reconhecimento/classificação ✔ | RF06 Envio pendências (fila simulada) ✔ | RF07 Dashboard ✔ | RF08 Consulta de servidores ✔ | RF09 Auditoria ✔ | RF10 Arquivamento ✔ | RF11 Integração envio RH (simulado) ✔ | RF12 Login/perfis ✔

## 7. Estrutura do repositório (49 arquivos versionados)

- **Backend**: `server.py`, `auth.py`, `security.py`, `models.py`, `main.py`, `FolhaPontoBack/` (Main, ocr, melhoriaImg, processing)
- **Frontend**: `index.html`, `app.js`, `styles.css`
- **Testes**: `tests/` (3 arquivos, 37 testes)
- **Assets**: `attached_assets/` (zippado, PDFs, planilhas, textos de requisitos)
- **Docs**: `README.md`, `screenshots/` (imagens do sistema)
- **Infra**: `.github/workflows/python-app.yml`, `pyproject.toml`, `uv.lock`, `.env.example`, `.gitignore`

## 8. Limitações conhecidas

| Limitação | Observação |
|---|---|
| Envio de e-mail simulado | A fila registra/envia no banco; SMTP real fica para fase futura |
| OCR requer Tesseract | Depende de `TESSERACT_CMD` instalado no sistema; quando ausente, marca `ocr_indisponivel` sem inventar dados |
| SQLite | Escala para ambiente acadêmico; `DATABASE_URL` já reservado para troca futura |
| Sincronização SIGPEP | Estrutura pronta para integração; não consumida ainda |

## 9. Histórico relevante (extra)

- `f338c16` MVP completo: auth JWT, LGPD, OCR, importação, fila de envio e 37 testes.
- `87b1152` Remoção de vestígios Replit (`uv.lock` → `folha-ponto`).
- Limpeza prévia: `.replit` removido, `.gitignore` e `pyproject.toml` corrigidos.

## 10. Como executar

```bash
# instalação (uma vez)
pip install -e ".[test]"

# execução
python -m uvicorn server:app --host 127.0.0.1 --port 5000

# testes
python -m pytest -q
```

Variáveis de ambiente necessárias (ver `.env.example`): `SECRET_KEY`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `TESSERACT_CMD`, `CPF_ENCRYPTION_KEY`.

## 11. Próximos passos sugeridos

1. SMTP real para o envio de pendências (RF06).
2. Integração SIGPEP (RF04) e webhook para os envios.
3. Troca de SQLite por PostgreSQL (usar `DATABASE_URL`).
4. Upload de múltiplos arquivos em paralelo e fila de processamento.
5. Relatórios exportáveis (XLSX/PDF) do dashboard.