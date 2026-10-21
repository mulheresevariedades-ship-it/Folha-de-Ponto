import express, { type Express } from "express";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Serve a interface compilada (`artifacts/ponto-digital/dist/public`) pela
 * própria API, para que o modo portátil funcione em uma única porta: as outras
 * estações da rede abrem apenas `http://<maquina>:<porta>/`.
 *
 * O deploy da Vercel continua servindo o front pelo CDN, sem passar por aqui.
 */
export function serveFrontend(app: Express, publicDir: string): boolean {
	const indexFile = path.join(publicDir, "index.html");

	if (!existsSync(indexFile)) {
		return false;
	}

	app.use(express.static(publicDir, { index: false, fallthrough: true }));

	// Fallback da SPA: qualquer rota não-API devolve o index e o roteador do
	// front (wouter) resolve o caminho no navegador.
	app.get(/^(?!\/api\/).*/, (_req, res, next) => {
		res.sendFile(indexFile, (error) => {
			if (error) next(error);
		});
	});

	return true;
}
