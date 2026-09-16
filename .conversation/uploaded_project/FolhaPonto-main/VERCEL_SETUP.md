# 🚀 Configuração Vercel - FolhaPonto Digital

Seu projeto está pronto para deployment no Vercel! Siga os passos abaixo:

## 1. Variáveis de Ambiente Obrigatórias

Configure as seguintes variáveis no **Dashboard do Vercel** em "Settings > Environment Variables":

### Segurança
- **SECRET_KEY**: Uma string aleatória de 64 caracteres
- **JWT_ALGORITHM**: `HS256`
- **JWT_EXPIRATION_MINUTES**: `480` (8 horas)
- **CPF_ENCRYPTION_KEY**: Deixe vazio se preferir apenas mascarar

### Credenciais Admin
- **ADMIN_USERNAME**: `admin@undf.edu.br` (ou seu e-mail)
- **ADMIN_PASSWORD**: Senha segura para o administrador inicial

### Configuração de Dados
- **PONTO_DATA_DIR**: `/tmp/folhaponto` (Vercel usa `/tmp` como único diretório gravável)

## 2. Conectar o Repositório

1. Vá para https://vercel.com/dig-ep/digepundf
2. Clique em "Connect Git Repository"
3. Selecione seu repositório GitHub do FolhaPonto
4. Configure as variáveis de ambiente acima

## 3. Deploy

Seu projeto estará disponível em:
- **URL Principal**: https://digepundf.vercel.app
- **URL Alternativa**: https://digepundf-c1mlkmfbh-dig-ep.vercel.app

## 4. Testando a Aplicação

### Rota de Health Check
```
GET https://digepundf.vercel.app/api/health
```

### Rota Raiz
```
GET https://digepundf.vercel.app/
```

### Login
```
POST https://digepundf.vercel.app/api/auth/login
Content-Type: application/json

{
  "username": "admin@undf.edu.br",
  "password": "sua-senha-admin"
}
```

## 5. Verificar Logs do Vercel

Se houver erro 500 (FUNCTION_INVOCATION_FAILED):

1. Acesse: https://vercel.com/dig-ep/digepundf/deployments
2. Clique no deployment com erro
3. Vá para a aba "Logs"
4. Procure por erros na inicialização

### Logs Esperados
```
[STARTUP] Inicializando banco de dados...
[STARTUP] Banco de dados inicializado com sucesso!
[STARTUP] Configurando autenticação...
[STARTUP] Autenticação configurada com sucesso!
[STARTUP] Sistema pronto para operação!
```

## 6. Status do Deploy

**Status**: ✅ Pronto para deployment no Vercel
**Versão**: 0.4.0
**Acompanhe em**: https://vercel.com/dig-ep/digepundf
