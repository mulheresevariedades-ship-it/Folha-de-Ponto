#!/bin/bash

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║   🚀 CONECTANDO COM VERCEL - https://vercel.com/dig-ep/folha-ponto"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# Passo 1: Verificar status Git
echo "1️⃣  VERIFICANDO GIT..."
cd /workspaces/FolhaPonto
git status
echo ""

# Passo 2: Verificar se há mudanças pendentes
echo "2️⃣  CHECANDO ALTERAÇÕES..."
CHANGES=$(git status --porcelain)
if [ -z "$CHANGES" ]; then
    echo "✅ Nenhuma alteração pendente"
else
    echo "⚠️  Alterações detectadas:"
    echo "$CHANGES"
    echo ""
    echo "Commitando alterações..."
    git add -A
    git commit -m "chore: final sync with new vercel deployment"
fi
echo ""

# Passo 3: Push para GitHub
echo "3️⃣  FAZENDO PUSH PARA GITHUB..."
git push origin main -v
echo ""

# Passo 4: Mostrar instruções
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║                   ✅ PRÓXIMAS AÇÕES                           ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""
echo "📋 Acesse: https://vercel.com/dig-ep/folha-ponto/settings"
echo ""
echo "⚙️  Configure estas variáveis de ambiente:"
echo ""
echo "   SECRET_KEY"
echo "   Valor: (gere com: openssl rand -base64 32 | head -c 64)"
echo ""
echo "   JWT_ALGORITHM = HS256"
echo "   JWT_EXPIRATION_MINUTES = 480"
echo "   ADMIN_USERNAME = admin@undf.edu.br"
echo "   ADMIN_PASSWORD = (sua senha segura)"
echo "   PONTO_DATA_DIR = /tmp/folhaponto"
echo ""
echo "🚀 Clique em 'Redeploy' ou 'Deploy'"
echo ""
echo "⏱️  Aguarde ~2-3 minutos para o deploy completar"
echo ""
echo "✅ Acesse: https://folha-ponto.vercel.app"
echo ""

