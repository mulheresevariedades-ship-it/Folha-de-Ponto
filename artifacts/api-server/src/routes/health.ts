import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { ocrDiagnostics } from "../lib/ocr";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

/** Esconde caminhos de arquivo: o diagnóstico mostra o problema, não a máquina. */
function semCaminhos(mensagem: string): string {
  return mensagem.replace(/(?:[A-Za-z]:\\|\/)[^\s"'`,;)]*/g, "…");
}

/**
 * Situação do OCR no servidor.
 *
 * Resposta curta e sem caminhos de arquivo: o operador precisa saber se o
 * modelo de idioma está presente, se o motor existe e qual foi a última
 * falha — sem expor a estrutura do servidor.
 */
router.get("/ocr-diagnostico", (_req, res) => {
  const diagnostico = ocrDiagnostics();
  res.json({
    motorDisponivel: diagnostico.motorDisponivel,
    modeloLocal: diagnostico.modeloLocal,
    cacheModelos: diagnostico.cache.arquivos.length,
    ultimaFalha: diagnostico.ultimaFalha
      ? {
          motivo: diagnostico.ultimaFalha.reason,
          em: diagnostico.ultimaFalha.at,
          mensagem: semCaminhos(diagnostico.ultimaFalha.message),
        }
      : null,
  });
});

export default router;
