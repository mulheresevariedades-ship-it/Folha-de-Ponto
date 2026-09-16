"""Entrada ASGI para Vercel."""

import sys
import logging

# Configurar logging para debug
logging.basicConfig(
    level=logging.DEBUG,
    format='%(asctime)s - %(levelname)s - %(message)s',
    stream=sys.stdout
)

logger = logging.getLogger(__name__)

try:
    logger.info("Importando servidor FastAPI...")
    from server import app
    logger.info("Servidor FastAPI importado com sucesso!")
except Exception as e:
    logger.error(f"Erro ao importar servidor: {e}", exc_info=True)
    raise

__all__ = ["app"]
