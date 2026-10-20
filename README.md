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
