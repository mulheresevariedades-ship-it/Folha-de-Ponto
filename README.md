# Folha-de-Ponto

## Demo local sem banco

Para visualizar e testar a interface sem configurar PostgreSQL, mantenha a API demo
rodando na porta `4000` e a interface na porta `3000`:

```powershell
$env:PORT="4000"
node node_modules\.pnpm\tsx@4.23.13\node_modules\tsx\dist\cli.mjs artifacts\api-server\src\demo.ts
pnpm --filter @workspace\ponto-digital run dev
```

Abra `http://localhost:3000/`. Os dados são sintéticos, ficam apenas em memória e
nenhum e-mail real é enviado.

## Banco de dados (API real)

A API real (`artifacts/api-server/src/index.ts`) lê `DATABASE_URL` do ambiente —
não carrega `.env` automaticamente. Prepare uma vez na raiz do repositório:

```powershell
Copy-Item .env.example .env   # cole a connection string do Neon (o .env não é versionado)
Get-Content .env | Where-Object { $_ -match '^[A-Z_]+=' } | ForEach-Object {
  if ($_ -match '^([A-Z_]+)=(.*)$') { Set-Item "env:$($matches[1])" $matches[2] }
}
pnpm --filter @workspace/db run push    # provisiona as tabelas no Neon
```

Em produção (Vercel), defina `DATABASE_URL` em Settings → Environment Variables;
o deploy não usa `.env`.

> **Porta 5432 bloqueada?** Redes corporativas costumam bloquear a porta 5432 do
> PostgreSQL, o que impede o `push` e a API real na máquina local — nessas redes
> use o modo demo acima ou faça o deploy na Vercel, onde a porta funciona. Se o
> Neon estiver com IP Allow restrito, libere os IPs da Vercel (ou `0.0.0.0/0`).

## Pasta de dados (arquivos arquivados)

Os PDFs arquivados usam a variável `PONTO_DATA_DIR`:

- Caminho absoluto: é usado exatamente como informado.
- Caminho relativo (ex.: `arquivo`): é resolvido contra a **raiz do workspace**,
  não contra o diretório de onde o servidor foi iniciado — assim o app pode rodar de
  qualquer pasta sem perder os arquivos.
- Se não definida, usa `data/` na raiz do workspace.

```powershell
$env:PONTO_DATA_DIR="D:\archive\folhas"   # opcional
pnpm --filter @workspace/api-server run demo
```

## Rodar sem instalar PostgreSQL (modo portátil)

O sistema pode ser copiado para qualquer computador e iniciado sem instalar
nenhum banco: um PostgreSQL embutido (PGlite) grava os dados em arquivo, na
pasta `data/`.

```powershell
pnpm --filter @workspace/api-server run build
node scripts\portable\package.mjs --runtime "C:\Program Files\nodejs"
```

O comando gera a pasta `dist-portable/` com a API, a interface, o banco
embutido e o runtime do Node. Basta dar duplo clique em `Iniciar-Ponto.bat`: o
sistema sobe em uma única porta e as demais estações da rede abrem apenas o
navegador no endereço mostrado.

- A pasta de dados (`data/`) guarda o banco, os arquivos e a chave local de
  cifragem — para fazer backup, copie essa pasta com o sistema encerrado.
- **Uma única máquina executa a API.** O banco embutido não trava entre
  processos: duas estações gravando na mesma pasta causam perda de dados. O
  sistema recusa a segunda abertura com uma mensagem clara e, se a execução
  anterior tiver sido encerrada à força, recupera o acesso sozinho.
- O modo portátil usa um `SESSION_SECRET` próprio, guardado em
  `data/SESSION_SECRET.txt`. Não apague esse arquivo: os dados cifrados
  dependem dele.

### Executando de uma pasta de rede compartilhada

O sistema pode rodar direto de um compartilhamento de rede, sem instalação
em cada computador:

1. Copie a pasta do projeto para o compartilhamento (ex.: `\\servidor\FolhaPonto`).
2. Defina `PONTO_DATA_DIR` com o caminho absoluto da pasta de dados **na rede**,
   para que os arquivos não fiquem presos a uma máquina:
   `$env:PONTO_DATA_DIR = "\\servidor\FolhaPonto\data"`.
3. Exporte `DATABASE_URL` no momento de iniciar (o `.env` não é carregado
   automaticamente).
4. Inicie a API: `pnpm --filter @workspace/api-server run dev`; em outra janela,
   o frontend: `pnpm --filter @workspace/ponto-digital run dev`.

Para usar o banco embutido em vez do Postgres, inicie pelo inicializador do
modo portátil — ele já resolve a pasta de dados e dispensa o `DATABASE_URL`.

O lock simples de operações vale também no modo demo: toda gravação exige o
lease de 30 s da sessão (liberado automaticamente ao abandonar; consultas não
são bloqueadas) e, enquanto outro usuário estiver gravando, a interface exibe
"Sistema em uso por outro usuário. Aguarde a conclusão da operação antes de
salvar novas alterações."

## Arquivo permanente em bucket (S3/R2)

Para produção, os PDFs podem ser arquivados em um bucket S3-compatível
(Cloudflare R2, AWS S3, MinIO) em vez da pasta local — no Vercel o disco da
function é efêmero (`/tmp`), então sem bucket os arquivos não sobrevivem a
novos deploys.

- Ative definindo `S3_BUCKET`, `S3_ACCESS_KEY_ID` e `S3_SECRET_ACCESS_KEY`
  (mais `S3_ENDPOINT` e `S3_REGION` para R2/MinIO; veja `.env.example`). Sem
  essas variáveis, o sistema continua usando a pasta local — o modo portátil
  não muda.
- O bucket fica **privado**: o download continua pela API
  (`GET /api/timesheets/:id/file`), o que evita URLs públicas com dados de
  servidores (LGPD).
- As convenções valem igualmente no bucket: a substituição de folha antiga
  grava o `_OLD_AAAAMMDD-HHMMSS` via cópia server-side (o S3 não tem rename).
- A estrutura no bucket espelha a local: `Folhas_AAAA-MM/Nome-AAAA-MM.pdf` e
  `uploads/sources/<hash>.pdf` na raiz do bucket. Use um bucket dedicado.

Passos no Cloudflare R2 (recomendado: free tier e zero custo de egress):
crie a conta, ative o R2, crie o bucket, gere uma API token com permissão de
leitura/escrita no bucket e copie o Access Key ID + Secret + endpoint da
conta. As credenciais vão direto para as variáveis de ambiente (Vercel
Settings → Environment Variables ou `.env` local) — nunca no código nem em
commits.

## Convenções do arquivo de folhas

- Nome oficial sempre no padrão `Folhas_AAAA-MM/Nome_do_servidor-AAAA-MM.pdf`.
- Ao substituir uma folha existente, a versão anterior nunca é apagada: é renomeada
  com o carimbo `_OLD_AAAAMMDD-HHMMSS` dentro da mesma pasta.
- Repetições dentro do mesmo lote não são sobrescritas: entram em `skippedDetails`
  e `duplicatesInBatch` no resultado da API.
- Quando a competência não é identificada no PDF, a API responde `422` com
  `requiresFallbackConfirmation: true`; a gravação só ocorre após confirmação
  explícita do operador (`confirmFallback: true`).
- Planilhas `.xlsx`/`.xls` são validadas pela assinatura real do arquivo (ZIP/OLE2),
  não apenas pela extensão.
- PDFs são validados pelo conteúdo (`%PDF-`), também sem confiar na extensão:
  um arquivo renomeado é recusado com `422`.

## Leitura do texto das folhas em PDF

O reconhecimento da competência, do nome e da matrícula lê o texto do PDF em
quatro etapas, nessa ordem:

1. `pdftotext` (poppler), quando o binário está instalado no computador do
   operador — é a leitura que preserva o layout da folha;
2. a leitura da camada de texto feita em JavaScript puro
   (`artifacts/api-server/src/lib/pdf-text.ts`), que decodifica a página,
   as fontes simples e as fontes compostas com a tabela `/ToUnicode`;
   funciona na Vercel e no modo portátil, sem nenhum programa externo;
3. o OCR, para PDF digitalizado (imagem), feito pelo `tesseract.js` (WASM puro,
   sem binários de sistema) sobre a imagem extraída do próprio arquivo
   (`artifacts/api-server/src/lib/pdf-raster.ts`): o JPEG da página vai intacto
   ao OCR e as imagens em bits crus são montadas em PNG. **Não depende do
   poppler** — funciona na Vercel e no modo portátil;
4. a conferência manual, que só acontece quando nenhuma das etapas acima
   conseguiu ler a página.

Se a página digitalizada não tiver uma imagem aproveitável (folha vetorial
com fonte incorporada, por exemplo), o `pdftoppm` do poppler entra como
segunda tentativa do OCR — quando ele estiver instalado.

Assim, um PDF gerado por Word, Excel ou por um sistema de folha é lido na
Vercel e no modo portátil sem instalar nada, e um PDF digitalizado também é
lido sem instalar nada.

### O que a API devolve

- `competencySource` com `conteudo-pdf` (texto), `ocr-conteudo-pdf` (página
  digitalizada lida por OCR), `fallback` (competência de referência) ou
  `nao-identificada`;
- `ocrApplied: true` quando a página foi lida por OCR e `ocrUnavailable: true`
  quando nenhuma estratégia de OCR funcionou — esse campo só aparece quando
  o problema é real;
- quando o OCR lê com **confiança baixa** (abaixo de 60), a competência não é
  aceita: a página é marcada para revisão manual, com a nota
  "Leitura por OCR com confiança baixa", em vez de arquivar um dado
  provavelmente errado.

### OCR sem internet (modo portátil)

O `tesseract.js` baixa o modelo de idioma (português e inglês, cerca de 4 MB)
do CDN do projeto. O empacotador portátil (`scripts/portable/package.mjs`)
baixa esse modelo uma vez e o coloca em `server/tessdata/`; em tempo de
execução a API usa o modelo local quando ele existe e, não havendo internet,
o OCR continua funcionando. Para apontar outro caminho:
`PONTO_TESSDATA_PATH`. Para trocar os idiomas: `PONTO_OCR_LANGUAGES`
(por exemplo `por`).

## SMTP (nunca no código)

A senha SMTP nunca fica no repositório. A configuração é salva criptografada no
banco pela tela de Configurações, com fallback pelas variáveis de ambiente:
`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, `SMTP_SECURE`.
A API informa a origem ativa no campo `source` (`database`, `environment`, `none`).

## Testes

As regras puras de nomeação, competência e validação de arquivos têm testes
automatizados:

```powershell
pnpm --filter @workspace/api-server run test
```

A suíte também cobre a leitura de PDF digitalizado de ponta a ponta
(`src/lib/ocr.test.ts`): o modelo de idioma do OCR é baixado da internet na
primeira execução (cerca de 4 MB). Sem internet o teste é ignorado com aviso
— o restante da suíte continua válido. Para desligá-lo de propósito:
`PONTO_OCR_TEST=0`.
