# Dados locais ou compartilhados

Esta pasta é o diretório padrão usado pela API quando `PONTO_DATA_DIR` não está definido.

O sistema cria automaticamente:

- `uploads/` para arquivos recebidos durante o processamento;
- `uploads/sources/` para os PDFs originais;
- `Folhas_AAAA-MM/` para as folhas arquivadas por competência.

No modo portátil (banco embutido) também são criados:

- `banco/` com o banco de dados em arquivo — não abra nem edite;
- `SESSION_SECRET.txt` com a chave usada para cifrar os dados sensíveis;
- `LOCK-PONTO.json`, a trava que impede duas estações de gravarem ao mesmo tempo.

Não coloque PDFs, planilhas ou dados reais no Git. Para uma pasta de rede, defina
`PONTO_DATA_DIR` com o caminho absoluto da pasta compartilhada antes de iniciar a API,
por exemplo no Windows:

```powershell
$env:PONTO_DATA_DIR = "\\servidor\FolhaPonto\data"
pnpm --filter @workspace/api-server run dev
```
