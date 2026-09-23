# Banco de dados do Ponto Digital

O banco usa PostgreSQL e é gerenciado pelo Drizzle. O schema fica em
`src/schema/index.ts` e cobre usuários, servidores, lotes de upload, folhas,
envios e auditoria.

## Configuração

Defina `DATABASE_URL` no ambiente do servidor e do Drizzle:

```bash
export DATABASE_URL="postgresql://usuario:senha@localhost:5432/digep"
pnpm --filter @workspace/db push
```

Em produção, configure a mesma variável no provedor antes de iniciar a API.

## API disponível

Com o servidor em execução, o frontend pode consultar:

- `GET /api/dashboard?competency=07/2026`
- `GET /api/timesheets?competency=07/2026&status=arquivada&q=Maria`
- `GET /api/timesheets/:reference`
- `GET /api/employees`
- `GET /api/dispatches?status=pendente`
- `GET /api/audit`

Os CPFs retornados pela API são sempre mascarados. O valor completo, quando
necessário, deve ser armazenado somente em `cpf_encrypted` após a aplicação de
uma chave de criptografia no backend.