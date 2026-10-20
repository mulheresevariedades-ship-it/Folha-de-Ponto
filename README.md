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

## Modo portátil (armazenamento de arquivos)

Os PDFs arquivados usam a variável `PONTO_DATA_DIR`:

- Caminho absoluto: é usado exatamente como informado.
- Caminho relativo (ex.: `ponto-data`): é resolvido contra a **raiz do workspace**,
  não contra o diretório de onde o servidor foi iniciado — assim o app pode rodar de
  qualquer pasta sem perder os arquivos.
- Se não definida, usa `ponto-data` na raiz do workspace.

```powershell
$env:PONTO_DATA_DIR="D:\archive\folhas"   # opcional
pnpm --filter @workspace/api-server run demo
```

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
