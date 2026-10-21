# Folha-de-Ponto

Sistema de controle de ponto: cadastro de servidores, importação de folhas de
ponto em PDF e de planilhas de RH, calendário de feriados, validação de
competência, disparo por e-mail e auditoria das operações.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — API (porta `PORT`; a demo usa 4000)
- `pnpm --filter @workspace/ponto-digital run dev` — interface (porta 3000 por padrão)
- `pnpm --filter @workspace/api-server run demo` — API demo, sem banco, dados sintéticos
- `pnpm run typecheck` — typecheck de todos os pacotes
- `pnpm run build` — typecheck + build de todos os pacotes
- `pnpm --filter @workspace/api-spec run codegen` — regenera hooks e schemas Zod a partir do OpenAPI
- `pnpm --filter @workspace/db run push` — aplica o schema no Postgres (só em desenvolvimento)
- `pnpm --filter @workspace/db run generate` — gera as migrações SQL versionadas
- `pnpm --filter @workspace/api-server run test` — testes das regras de arquivo e nomeação

Variáveis de ambiente:

- `DATABASE_URL` — **obrigatória** na API real: string de conexão do Postgres.
- `SESSION_SECRET` — **obrigatória**: protege o CPF (HMAC) e a senha de SMTP (AES).
- `PONTO_DATA_DIR` — pasta de arquivos (PDFs arquivados). Absoluta ou relativa à
  raiz do workspace; o padrão é `data/`.
- `PORT` — porta da API. Obrigatória no servidor real, opcional na demo.
- `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_ENDPOINT`, `S3_REGION` —
  quando presentes, os PDFs vão para um bucket S3-compatível em vez do disco.

### Vercel

Defina `DATABASE_URL` e `SESSION_SECRET` em Settings → Environment Variables. O
`vercel.json` redireciona `/api/*` para a função `api/index.js`, que carrega o
bundle ESM `artifacts/api-server/dist/app.mjs`.

O disco da function é efêmero: sem bucket S3 os arquivos arquivados não
sobrevem a um novo deploy. Use `S3_*` ou um servidor com `PONTO_DATA_DIR`
apontando para a pasta compartilhada.

### Modo portátil (sem instalar nada)

`pnpm --filter @workspace/api-server run build` seguido de
`node scripts/portable/package.mjs --runtime <pasta-do-node>` gera a pasta
`dist-portable/`, com a API, a interface, o banco embutido e o runtime do Node.
O `Iniciar-Ponto.bat` sobe o sistema em uma única porta: as demais estações da
rede abrem apenas o navegador.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM (modo portátil: PGlite, o mesmo Postgres em WASM)
- Validação: Zod (`zod/v4`), `drizzle-zod`
- Codegen da API: Orval (a partir do spec OpenAPI)
- Build: esbuild (bundle ESM)

## Onde ficam as coisas

- `artifacts/api-server/src` — API (rotas em `routes/`, utilitários em `lib/`)
- `artifacts/ponto-digital/src` — interface React
- `lib/db/src/schema/index.ts` — schema do banco (fonte de verdade das tabelas)
- `lib/db/migrations` — migrações SQL versionadas
- `lib/api-spec/openapi.yaml` — contrato da API (gera hooks e schemas Zod)
- `data/` — arquivos em tempo de execução (PDFs, uploads, banco portátil)
- `scripts/portable` — empacotador e inicializador do modo portátil

## Decisões de arquitetura

- **A fachada `db` é um proxy.** `lib/db` exporta um único `db` que delega para
  o driver ativo. O padrão é `pg` + `DATABASE_URL`; o modo portátil registra um
  PGlite em arquivo no boot. Nenhuma rota conhece a diferença.
- **A trava de operação é global e tem TTL.** Uma única linha em
  `operation_locks` (id 1) com lease de 30 s, renovada por heartbeat. Uma
  segunda estação que tenta gravar recebe 423; sem sessão ativa, 428.
- **O PGlite não trava entre processos.** Duas máquinas gravando no mesmo
  diretório causam perda silenciosa. O modo portátil recusa a segunda
  abertura e recupera a trava órfã quando o processo dono já morreu.
- **Arquivos são validados pelo conteúdo, não pela extensão.** Planilhas pela
  assinatura ZIP/OLE2, PDFs pela assinatura `%PDF-`.
- **A senha de SMTP nunca fica no repositório.** Fica cifrada no banco, com
  fallback para as variáveis de ambiente.

## Produto

- Cadastro de servidores (nome, matrícula, CPF, e-mail, cargo, carga horária,
  acúmulo de cargo) com importação de planilha validada.
- Importação de folhas de ponto em PDF, com leitura de competência, matrícula e
  nome, OCR como recurso e confirmação manual quando a competência não é
  identificada.
- Calendário de datas especiais a partir de planilha.
- Validação de leafs e despacho por e-mail com histórico.
- Auditoria das operações e modo de demonstração com dados sintéticos.

## Preferências do usuário

- O sistema é usado no topo de uma instituição pública: foco em simplicidade
  para o operador e em nunca perder dados já registrados.
- Toda gravação passa pela trava de operação; a interface avisa quando outro
  usuário está usando o sistema.
- Nada de credenciais no código ou nos commits.

## Armadilhas

- **`DATABASE_URL` ausente não é fallback automático:** a API real falha de
  propósito. O modo portátil é opt-in explícito por `PONTO_DB_MODE=portable`.
- **O `dev` script do api-server usa `export`**, que é POSIX e falha no
  `cmd.exe`. Use PowerShell ou outra entrada.
- **A porta 5432 costuma estar bloqueada** em redes corporativas, o que impede
  `drizzle-kit push` e a API real na máquina local.
- **`pnpm-lock.yaml` precisa acompanhar qualquer dependência nova** — o deploy
  usa `pnpm install --frozen-lockfile`.
- **O `.env` não é carregado automaticamente.** Exporte as variáveis antes de
  iniciar a API.

## Pointers

- `README.md` — instruções de operação e convenções de arquivo
- `lib/db/src/schema/index.ts` — tabelas, enums e índices
- `artifacts/api-server/src/routes/lock.ts` — trava de operação
- `scripts/portable/package.mjs` — empacotamento do modo portátil
