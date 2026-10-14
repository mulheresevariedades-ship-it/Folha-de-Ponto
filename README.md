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