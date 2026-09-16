# 🚀 FolhaPonto Digital - GUIA COMPLETO DE ACESSO

## ✅ STATUS ATUAL

**Front-end + Back-end**: ✅ CONECTADOS E FUNCIONANDO

---

## 📱 ACESSAR LOCALMENTE

### URL:
```
http://localhost:8000/
```

### Credenciais de Teste:
```
Usuário: admin@undf.edu.br
Senha:   admin123
```

### O que Funciona:
- ✅ **Formulário de Login** → Conectado à API
- ✅ **Autenticação JWT** → Login salva token no localStorage
- ✅ **Dashboard** → Mostra estatísticas de folhas de ponto
- ✅ **Conferência OCR** → Interface para revisar folhas
- ✅ **Arquivo** → Filtrar e buscar folhas processadas
- ✅ **Servidores** → Importar e gerenciar servidores
- ✅ **Fila de Envios** → Gerenciar e simular envios de e-mail

---

## 🌐 ACESSAR NO VERCEL

Quando estiver no ar, será:
```
https://digepundf.vercel.app/
```

### Para Funcionar no Vercel:

1. Abra: **https://vercel.com/dig-ep/digepundf/settings/environment-variables**

2. Adicione as 6 variáveis de ambiente:

| Variável | Valor |
|----------|-------|
| `SECRET_KEY` | Gere uma string aleatória de 64 caracteres |
| `JWT_ALGORITHM` | `HS256` |
| `JWT_EXPIRATION_MINUTES` | `480` |
| `ADMIN_USERNAME` | `admin@undf.edu.br` |
| `ADMIN_PASSWORD` | Escolha uma senha segura |
| `PONTO_DATA_DIR` | `/tmp/folhaponto` |

3. Clique em "Redeploy"

4. Depois de alguns minutos, acesse:
   ```
   https://digepundf.vercel.app/
   ```

---

## 🔗 ESTRUTURA DE CONEXÃO

### Front-end → Back-end

```
index.html (interface web)
    ↓
app.js (JavaScript/aplicação)
    ↓
apiFetch() (função para chamadas à API)
    ↓
/api/auth/login (autenticação)
/api/dashboard (dados)
/api/timesheets (folhas)
/api/employees (servidores)
/api/dispatches (envios)
/api/batches (upload de PDF/imagens)
```

### Fluxo de Login:
```
1. Usuário entra com email + senha
2. Front faz POST /api/auth/login
3. Back verifica banco de dados
4. Retorna JWT token
5. Front salva token no localStorage
6. Autoriza requisições futuras com Bearer token
7. Back valida token em rotas protegidas
```

---

## 🧪 TESTAR ENDPOINTS

### 1. **Health Check** (sem autenticação)
```bash
curl http://localhost:8000/api/health
```
Resposta esperada:
```json
{"status":"ok","mode":"real","database":"sqlite"}
```

### 2. **Login**
```bash
curl -X POST http://localhost:8000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin@undf.edu.br","password":"admin123"}'
```

Resposta:
```json
{
  "access_token": "eyJ...",
  "token_type": "bearer",
  "user": {
    "id": 1,
    "username": "admin@undf.edu.br",
    "role": "admin",
    "full_name": "Administrador",
    "active": true
  }
}
```

### 3. **Dashboard** (com token)
```bash
TOKEN="seu-token-aqui"
curl http://localhost:8000/api/dashboard \
  -H "Authorization: Bearer $TOKEN"
```

---

## 📁 ARQUIVOS PRINCIPAIS

| Arquivo | Função |
|---------|--------|
| `index.html` | Interface web (HTML/CSS) |
| `app.js` | Lógica da aplicação (JavaScript) |
| `styles.css` | Estilos visuais |
| `server.py` | API FastAPI (Python) |
| `auth.py` | Autenticação JWT |
| `models.py` | Modelos Pydantic |
| `security.py` | Segurança LGPD (CPF) |
| `api/index.py` | Entrada para Vercel |

---

## 🔐 SEGURANÇA

- ✅ JWT com expiração (480 minutos)
- ✅ Senhas com bcrypt (hash seguro)
- ✅ LGPD: CPF mascarado/criptografado
- ✅ Tokens revogáveis (logout)
- ✅ Banco de dados SQLite com PRAGMA foreign_keys

---

## 📊 DADOS NO BANCO

Após login, você pode:

1. **Enviar folhas de ponto** (PDF/PNG/JPG)
   - Sistema extrai data, matrícula, nome via OCR
   - Salva no banco com status "pendente"

2. **Revisar folhas**
   - Mudar status: "reconhecida" ou "revisão necessária"
   - Adicionar observações

3. **Arquivar folhas**
   - Marcar como "arquivada"
   - Filtrar por período

4. **Importar servidores**
   - Upload de CSV/XLSX com dados
   - Mapear funcionários

5. **Gerenciar envios**
   - Simular envio de e-mail
   - Rastrear status

---

## ⚙️ CONFIGURAÇÕES AVANÇADAS

### Variável Opcional: CPF_ENCRYPTION_KEY
```
Se deixar vazio: CPF é apenas mascarado (***.***.***-00)
Se preencher: CPF é criptografado com Fernet (mais seguro)
```

### Para Gerar Chave de Criptografia:
```bash
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

---

## 🚀 PRÓXIMOS PASSOS

### Local (Desenvolvimento):
```bash
# Servidor já está rodando em http://localhost:8000
# Abra no navegador e teste!
```

### Vercel (Produção):
1. Configure as 6 variáveis de ambiente
2. Faça "Redeploy"
3. Acesse https://digepundf.vercel.app

---

## 📞 TROUBLESHOOTING

### "Autenticação necessária"
→ Você foi desconectado. Faça login novamente.

### "Credenciais inválidas"
→ Verifique usuário/senha. Use: `admin@undf.edu.br` / `admin123`

### "Sessão expirada"
→ Token venceu. Faça login novamente (JWT expira em 8 horas).

### "Vercel mostra erro 500"
→ Verifique as variáveis de ambiente em:
   https://vercel.com/dig-ep/digepundf/settings/environment-variables

### "Front-end carrega mas não faz login"
→ Abra DevTools (F12) → Console e veja mensagens de erro

---

## ✨ PRONTO PARA USAR!

**Local**: http://localhost:8000  
**Vercel**: https://digepundf.vercel.app (após configurar env vars)

Credenciais: `admin@undf.edu.br` / `admin123`

🎉 **Sistema totalmente funcional!**
