# Folha-de-Ponto

## Baixar e usar no Windows (passo a passo)

Esta é a forma mais simples de testar em casa. **Você não precisa de Git, Node
nem terminal** — o instalador pronto fica na página de Releases do GitHub (o Git
guarda apenas o código-fonte).

### 1. Baixar os arquivos

1. Abra: https://github.com/mulheresevariedades-ship-it/Folha-de-Ponto/releases/latest
2. Na seção **Assets**, baixe os três arquivos:
   - `Ponto-Digital-Setup-1.0.0.exe` — instalador (~161 MB)
   - `Ponto-Digital-teste.cer` — certificado de teste
   - `Ponto-Digital-Setup-1.0.0.exe.sha256` — hash para conferir o download
3. Deixe os três na pasta `Downloads`.

### 2. Conferir o download (recomendado)

Abra o PowerShell e rode:

```powershell
$sha = (Get-Content "$env:USERPROFILE\Downloads\Ponto-Digital-Setup-1.0.0.exe.sha256").Split()[0]
(Get-FileHash "$env:USERPROFILE\Downloads\Ponto-Digital-Setup-1.0.0.exe" -Algorithm SHA256).Hash.ToLower() -eq $sha
```

O resultado deve ser `True`. O hash esperado é:

```text
0ea13b59c009da6003788ea3934aec9e7212ae6bc99787046bd0e5591cd9df5e
```

### 3. Confiar no certificado de teste (opcional)

O instalador é assinado com um certificado **de teste** (não é de uma autoridade
certificadora). Sem instalar o `.cer`, o Windows mostra "editor desconhecido".

1. Dê duplo clique em `Ponto-Digital-teste.cer`.
2. **Instalar Certificado** → **Usuário atual** → **Avançar**.
3. Marque **Colocar todos os certificados no repositório a seguir** → **Procurar**.
4. Escolha **Autoridades de Certificação Raiz Confiáveis** → **OK** → **Avançar** → **Concluir**.
5. Confirme o aviso de segurança.
6. (Opcional) Repita o processo escolhendo **Editores Confiáveis**.

Só faça isso se baixou os arquivos do link oficial acima. Esse certificado serve
apenas para esta versão de teste.

### 4. Instalar

1. Dê duplo clique em `Ponto-Digital-Setup-1.0.0.exe`.
2. Se aparecer **"O Windows protegeu o computador"**, clique em **Mais informações** → **Executar assim mesmo**.
3. A instalação é **por usuário** e não pede senha de administrador. Pode manter a pasta sugerida.
4. Ao terminar, o app abre sozinho. Se não abrir, use o atalho **Ponto Digital**.

### 5. Usar

- Atalho **Ponto Digital** na Área de Trabalho e no Menu Iniciar.
- A primeira abertura leva alguns segundos (tela de splash).
- Feche a janela para encerrar; o backend para junto e libera o banco.
- Funciona **offline**: banco local, OCR e PDF não dependem de internet.
- Dados: `%LOCALAPPDATA%\PontoDigital\data`
- Logs: `%LOCALAPPDATA%\PontoDigital\logs\launcher.log`

### 6. Desinstalar

**Configurações → Aplicativos → Ponto Digital → Desinstalar**.
Os dados em `%LOCALAPPDATA%\PontoDigital\data` são preservados; apague a pasta
manualmente se quiser remover tudo.

### Se algo não funcionar

| Sintoma | O que fazer |
| --- | --- |
| "O Windows protegeu o computador" | **Mais informações** → **Executar assim mesmo** |
| "Editor desconhecido" | Instale o `.cer` (passo 3) ou prossiga |
| "Acesso negado" ou "bloqueado por política" | Política corporativa (WDAC/App Control). Teste em outro PC ou peça liberação ao TI |
| Smart App Control bloqueia o app | O Windows pode impedir apps sem reputação. Teste em outro PC ou avalie desativar o Smart App Control (não é possível reativar sem reinstalar o Windows) |
| Antivírus reclama do instalador | Versão de teste com certificado interno; permita o arquivo |
| App não abre | Veja `%LOCALAPPDATA%\PontoDigital\logs\launcher.log` |
| Porta ocupada | O app tenta 8080–8084 e depois uma porta livre automaticamente |

### Baixar pelo Git (opcional, para desenvolvedores)

O Git **não** contém o instalador. Se quiser compilar a partir do código:

```powershell
git clone https://github.com/mulheresevariedades-ship-it/Folha-de-Ponto.git
cd Folha-de-Ponto
pnpm install
pnpm build:installer
```

Requisitos: Windows x64, Node 24, pnpm 9 e internet na primeira compilação.
Saída: `dist-installer/Ponto-Digital-Setup-1.0.0.exe`. Para rodar sem instalar,
use `pnpm build:portable` e depois `Iniciar-Ponto.bat` (seção *Rodar sem instalar
PostgreSQL*).

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
pnpm build:portable
```

O comando gera a pasta `dist-portable/` com a API, a interface, o banco
embutido, o OCR e o runtime do Node (baixado uma única vez no build e guardado
em `node_modules/.cache`). Sem internet no build? Aponte um Node 24 já
instalado: `node scripts\portable\package.mjs --runtime "C:\Program Files\nodejs"`.
Basta dar duplo clique em `Iniciar-Ponto.bat`: o
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

## Instalador Windows (aplicativo desktop)

Para entregar o sistema a quem não usa terminal, gere o instalador:

```powershell
pnpm build:installer
```

Saída: `dist-installer/Ponto-Digital-Setup-1.0.0.exe`. O comando é completo:
compila interface e API, monta o pacote portátil (mesmo `portable.mjs`, mesmo
banco PGlite, mesmo OCR sem Poppler), confere se worker/WASM/modelos `por` e
`eng` e o runtime do Node estão presentes e chama o electron-builder (NSIS).
Nada precisa ser copiado à mão. Para testar sem instalar, `pnpm build:desktop`
gera `dist-desktop/win-unpacked/Ponto Digital.exe`.

O aplicativo não reimplementa a interface: ele inicia o backend portátil numa
porta livre e abre a interface numa janela própria.

| Item | Local |
| --- | --- |
| Programa (instalação por usuário, sem UAC) | `%LOCALAPPDATA%\Programs\Ponto Digital` |
| Dados (banco, PDFs, `SESSION_SECRET`) | `%LOCALAPPDATA%\PontoDigital\data` |
| Log de inicialização | `%LOCALAPPDATA%\PontoDigital\logs\launcher.log` |
| Estado do servidor (porta/PID) | `%LOCALAPPDATA%\PontoDigital\state\server.json` |

- **Porta:** tenta 8080–8084; se estiverem ocupadas, usa uma porta livre do
  sistema. Antes de iniciar, verifica `/api/healthz` + o título da interface
  para reaproveitar um servidor já em execução (clique duplo no atalho não abre
  duas instâncias do backend).
- **Fechamento:** fechar a janela encerra o backend de forma ordenada (fecha o
  banco e libera a trava). Se o processo morrer à força, a próxima abertura
  recupera a trava sozinha — o mesmo mecanismo do modo portátil.
- **Pasta de rede:** crie `%LOCALAPPDATA%\PontoDigital\config.json` com
  `{"dataDir": "\\\\servidor\\compartilhamento\\ponto"}` (ou defina
  `PONTO_DATA_DIR`). O lock de estação única continua valendo.
- **Desinstalar** remove programa e atalhos e **preserva os dados**; para
  backup, copie a pasta `data` com o sistema fechado.
- **Ícone:** a fonte é `assets/icon.png`; gere de novo com `pnpm build:icon`
  (o electron-builder converte para `.ico` no executável, atalhos e
  instalador). Para usar o logo oficial, substitua o PNG e rode o build.
- **Requisitos de build:** Node 24 na máquina de build e internet apenas para
  baixar Electron/NSIS/Node embutido/modelos de OCR na primeira vez. A máquina
  de destino não precisa de nada disso.
- **Build em máquina corporativa com App Control/WDAC:** executáveis sem
  assinatura são bloqueados, inclusive o stub que o electron-builder executa
  para pré-assinar o desinstalador. Nesse caso o `pnpm build:installer` repete a
  etapa com um script NSIS derivado do template do electron-builder (os includes
  são embutidos no arquivo): o desinstalador é gravado no momento da instalação
  (`WriteUninstaller`) e remove atalhos, pasta do programa e registro de
  desinstalação, preservando os dados em `%LOCALAPPDATA%\PontoDigital`. O
  electron-builder avisa que o desinstalador não foi assinado; o arquivo
  distribuído é o instalador.
- **Assinatura de código:** o `.exe` sai sem assinatura (SmartScreen avisa na
  primeira execução). Para entregar assinado, use o workflow
  `Instalador Windows` do GitHub Actions (gera o artefato `Ponto-Digital-Setup`
  e o anexa na release quando a tag é `v*`) ou assine com `signtool` e um
  certificado de code signing antes de distribuir. No workflow, configure os
  secrets `CSC_LINK` (`.pfx` em base64 ou URL) e `CSC_KEY_PASSWORD`; a etapa
  "Conferir instalador e assinatura" falha se o segredo existir e o arquivo não
  estiver assinado de verdade.
- **Assinatura local:** `scripts/desktop/new-test-cert.ps1` cria um certificado
  autoassinado (somente teste) e `scripts/desktop/sign-installer.ps1` assina o
  `.exe` com `Set-AuthenticodeSignature`, sem precisar do `signtool`. O
  certificado de teste só é aceito nas máquinas em que o `.cer` for instalado em
  "Autoridades de Certificação Raiz Confiáveis" e "Editores Confiáveis"; para
  distribuir, use um certificado real.
- O modo portátil clássico (`Iniciar-Ponto.bat`) e o deploy na Vercel não
  mudam; o instalador usa exatamente o mesmo pacote.

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
- `ocrUnavailableReason` com o motivo da falha (`modelo-indisponivel`,
  `tempo-limite`, `motor-indisponivel` ou `leitura-falhou`), que também vai
  para a nota da folha gravada;
- quando o OCR lê com **confiança baixa** (abaixo de 60), a competência não é
  aceita: a página é marcada para revisão manual, com a nota
  "Leitura por OCR com confiança baixa", em vez de arquivar um dado
  provavelmente errado.

### Diagnóstico do OCR

`GET /api/ocr-diagnostico` mostra a situação do OCR no servidor: se o motor
existe, se o runtime do worker está embarcado (`workerEmbutido`), se o modelo
de idioma está na máquina (e quais arquivos estão lá), quantos modelos estão
no cache e qual foi a última falha. A resposta não traz caminhos de arquivo.
É o primeiro lugar a olhar quando uma folha digitalizada não é lida.

### OCR sem internet (Vercel e modo portátil)

O `tesseract.js` precisa de duas coisas em tempo de execução: o **modelo de
idioma** (português e inglês, cerca de 4 MB) e o **runtime do motor** (o
script do worker e o núcleo WASM, cerca de 19 MB). Nos dois ambientes eles
**entram junto do programa**, então o OCR não depende da internet em tempo de
execução:

- **Vercel**: o build da API copia o runtime do OCR e o modelo para
  `artifacts/api-server/dist/ocr/` e o `vercel.json` embarca essa pasta na
  função (`includeFiles`); em tempo de execução a API lê o modelo do disco e
  aponta o `tesseract.js` para o worker embarcado;
- **modo portátil**: o empacotador (`scripts/portable/package.mjs`) copia o
  runtime junto do bundle e baixa o modelo uma vez para `server/ocr/tessdata/`.

O runtime embarcado importa porque o `tesseract.js` é externo no bundle: ele
carrega o worker por caminho de arquivo (`new Worker(workerPath)`) e o
núcleo por `require('tesseract.js-core/...')`, e nenhum dos dois é um
`require` estático do ponto de entrada — sem a cópia, o empacotador do deploy
não os acompanha, o worker nunca sobe e o OCR trava até o prazo.

Só quando o modelo não está em lugar nenhum a API o baixa do CDN. Para
apontar outro caminho: `PONTO_TESSDATA_PATH`. Para trocar os idiomas:
`PONTO_OCR_LANGUAGES` (por exemplo `por`).

### Limite de tempo do OCR

Todo OCR tem prazo (`PONTO_OCR_TIMEOUT_MS`, padrão 60 s) para carregar o
modelo e ler a imagem. Estourado o prazo, a página é marcada para
conferência manual — o servidor nunca fica preso esperando a rede.

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
## Política de Arquivos e Versionamento

### Arquivos `_OLD_`

Quando uma folha de ponto é reenviada com `replaceDuplicates=true`, o arquivo anterior (corrente) é renomeado para o padrão:

```
NomeServidor-AAAA-MM_OLD_AAAAMMDD-HHMMSS.pdf
```

- **Quando é criado:** ao substituir uma folha duplicada (mesmo servidor + competência + fingerprint).
- **Nomenclatura:** `<nome>-<competência>_OLD_<timestamp>.pdf` (timestamp no formato AAAAMMDD-HHMMSS).
- **Finalidade:** preservação da versão anterior para auditoria e rastreabilidade.
- **Retenção:** arquivos `_OLD_` **não são apagados automaticamente**. A política futura de retenção poderá incluir limpeza periódica (ex.: remover `_OLD_` com mais de 90 dias) ou arquivamento em storage frio. Atualmente, a responsabilidade de limpeza é manual.

### `uploads/sources/`

Diretório usado para armazenar os PDFs originais enviados pelos usuários antes do processamento.

- **Finalidade:** manter a fonte original para reprocessamento, auditoria e reextração de dados.
- **Uso:** cada PDF enviado é salvo em `uploads/sources/` com nome estável (baseado em fingerprint quando identificado, ou nome genérico quando não identificado).
- **Política atual de retenção:** arquivos são mantidos indefinidamente. Não há limpeza automática. A remoção manual deve considerar impacto em auditoria e possibilidade de reprocessamento.

### Modo Portable

O modo portable (`dist-portable`) empacota:

- Runtime Node.js embutido
- Backend (API server)
- Frontend (ponto-digital)
- Banco PGlite (arquivo local)
- OCR (Tesseract + modelos `por`/`eng`)
- PDFium (WASM para rasterização JBIG2/JPX/CCITT)

**Como gerar:**

```bash
pnpm --filter @workspace/api-server run build
# Em seguida, executar o script de empacotamento portable
```

**Como executar:** basta executar o launcher do pacote `dist-portable`. Não requer Node, pnpm, npm, VS Code ou internet. O banco PGlite é criado automaticamente no diretório de dados do usuário.
