# 🔗 Links de Acesso - FolhaPonto Digital

## 🌍 Servidor Local (Codespaces)

O servidor **FolhaPonto** está rodando agora em:

### Links Diretos:

#### 1️⃣ **Página Raiz** (Health Check)
```
http://localhost:8000/
```
OU com Codespaces tunnel:
```
https://digepundf-c1mlkmfbh-dig-ep.vercel.app:8000
```

#### 2️⃣ **API Health**
```
http://localhost:8000/api/health
```

#### 3️⃣ **Login** (POST)
```
curl -X POST http://localhost:8000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin@undf.edu.br","password":"admin"}'
```

---

## 🔍 Status Atual

✅ **Servidor Local**: FUNCIONANDO na porta 8000
⏳ **Vercel**: Aguardando variáveis de ambiente

---

## 📋 O que Falta para o Vercel Funcionar

1. Vá para: **https://vercel.com/dig-ep/digepundf/settings/environment-variables**
2. Configure estas 6 variáveis:
   - `SECRET_KEY` = (string aleatória 64 chars)
   - `JWT_ALGORITHM` = `HS256`
   - `JWT_EXPIRATION_MINUTES` = `480`
   - `ADMIN_USERNAME` = `admin@undf.edu.br`
   - `ADMIN_PASSWORD` = (sua senha)
   - `PONTO_DATA_DIR` = `/tmp/folhaponto`

3. Clique em "Redeploy" ou "Deploy"

---

## 🧪 Para Testar Agora (Local)

```bash
# Rota raiz
curl http://localhost:8000/

# Health check
curl http://localhost:8000/api/health

# Dashboard (requer autenticação)
curl http://localhost:8000/api/dashboard
```

Esperado:
```json
{
    "message": "Ponto Digital DIGEP",
    "status": "running",
    "version": "0.4.0"
}
```

---

**Status**: ✅ LOCAL - OK | ⏳ VERCEL - Aguardando Env Vars
