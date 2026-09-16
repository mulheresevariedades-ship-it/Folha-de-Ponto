# 🚀 CONEXÃO COM NOVO VERCEL - folha-ponto

## ✅ O QUE FOI FEITO:

- ✅ Código commitado no GitHub
- ✅ Push realizado com sucesso
- ✅ Pronto para conectar ao novo Vercel

---

## 🔗 CONECTAR AO VERCEL NOVO

### Passo 1: Abrir Dashboard Vercel

Acesse: **https://vercel.com/dig-ep/folha-ponto**

### Passo 2: Verificar Repositório Conectado

1. Vá para **Settings** → **Git**
2. Verifique se está conectado ao repositório certo:
   ```
   https://github.com/Daniel-Francisc/FolhaPonto
   ```

Se não estiver conectado:
- Clique em "Connect Repository"
- Selecione: `Daniel-Francisc/FolhaPonto`
- Clique em "Connect"

### Passo 3: Configurar Variáveis de Ambiente

1. Em **Settings**, vá para **Environment Variables**
2. Clique em **Add**
3. Configure cada variável:

#### Variável 1: SECRET_KEY
```
Name: SECRET_KEY
Value: (gere uma string aleatória de 64 caracteres)
```

Para gerar:
```bash
openssl rand -base64 32 | head -c 64
```

Exemplos (escolha um):
```
KvX9mQpL2zJ7wR4fD8sBcN1hE5tY3gU6jV2wX8kL9mP0qR3sT4uV5yW6aZ7bC
```

#### Variável 2: JWT_ALGORITHM
```
Name: JWT_ALGORITHM
Value: HS256
```

#### Variável 3: JWT_EXPIRATION_MINUTES
```
Name: JWT_EXPIRATION_MINUTES
Value: 480
```

#### Variável 4: ADMIN_USERNAME
```
Name: ADMIN_USERNAME
Value: admin@undf.edu.br
```

#### Variável 5: ADMIN_PASSWORD
```
Name: ADMIN_PASSWORD
Value: (escolha uma senha segura, ex: SeNhA#12345)
```

#### Variável 6: PONTO_DATA_DIR
```
Name: PONTO_DATA_DIR
Value: /tmp/folhaponto
```

### Passo 4: Salvar e Redeploy

1. Clique em "Save"
2. Vá para **Deployments**
3. Clique em **Redeploy** (ao lado do deployment atual)
4. Selecione **Production** branch (main)
5. Clique em **Redeploy**

### Passo 5: Aguardar Deploy

- O processo leva ~2-3 minutos
- Você verá status: "Building" → "Ready"
- Quando ficar **Ready** (verde), está pronto!

---

## 🌐 ACESSAR O SISTEMA

### Após Deploy Completo:

**URL**: https://folha-ponto.vercel.app/

**Credenciais de Login**:
```
Email:  admin@undf.edu.br
Senha:  (a que você configurou em ADMIN_PASSWORD)
```

---

## 📋 CHECKLIST FINAL

- [ ] Repositório GitHub conectado ao Vercel
- [ ] SECRET_KEY configurado (64 chars)
- [ ] JWT_ALGORITHM = HS256
- [ ] JWT_EXPIRATION_MINUTES = 480
- [ ] ADMIN_USERNAME = admin@undf.edu.br
- [ ] ADMIN_PASSWORD configurado
- [ ] PONTO_DATA_DIR = /tmp/folhaponto
- [ ] Clicado em "Redeploy"
- [ ] Deploy concluído (verde "Ready")
- [ ] Sistema acessível em https://folha-ponto.vercel.app/

---

## 🧪 TESTAR APÓS DEPLOY

Após o sistema estar "Ready" no Vercel:

### 1. Acessar a Interface
```
https://folha-ponto.vercel.app/
```

### 2. Fazer Login
- Email: admin@undf.edu.br
- Senha: (a que configurou)

### 3. Explorar Funcionalidades
- Dashboard
- Upload de folhas
- Conferência OCR
- Arquivo
- Gerenciamento de servidores
- Fila de envios

---

## ⚠️ TROUBLESHOOTING

### Erro: "Vercel project not found"
→ Verifique se selecionou o repositório correto em "Connect Repository"

### Erro: "Credenciais inválidas" ao fazer login
→ Verifique se a ADMIN_PASSWORD foi configurada corretamente

### Erro: "500 Internal Server Error"
→ Verifique os logs em Vercel:
   1. Vá para **Deployments**
   2. Clique no deployment com erro
   3. Vá para **Logs**
   4. Procure por mensagens de erro

### Erro: "No SECRET_KEY configured"
→ Confira se todas as 6 variáveis foram configuradas

---

## 🔄 FAZER ATUALIZAÇÕES NO CÓDIGO

Após fazer mudanças no código local:

```bash
cd /workspaces/FolhaPonto

# Fazer suas mudanças...

git add -A
git commit -m "feat: descrição da mudança"
git push origin main
```

Vercel fará deploy automaticamente!

---

## 📞 LINKS ÚTEIS

| Recurso | URL |
|---------|-----|
| **Vercel Project** | https://vercel.com/dig-ep/folha-ponto |
| **GitHub Repository** | https://github.com/Daniel-Francisc/FolhaPonto |
| **Sistema Live** | https://folha-ponto.vercel.app |
| **Documentação** | Ver GUIA_COMPLETO.md |

---

## 🎯 RESUMO

```
1. Vercel: https://vercel.com/dig-ep/folha-ponto
2. Conectar repositório GitHub (Daniel-Francisc/FolhaPonto)
3. Configurar 6 variáveis de ambiente
4. Clique em "Redeploy"
5. Aguarde ~3 minutos
6. Acesse https://folha-ponto.vercel.app
7. Faça login com admin@undf.edu.br / sua-senha
8. ✅ Pronto!
```

---

**Sistema FolhaPonto Digital - Totalmente Funcional no Vercel! 🎉**
