import app from "./app";
import { logger } from "./lib/logger";

/**
 * `NODE_ENV` é lido pelo logger para escolher entre a saída formatada
 * (desenvolvimento) e a simples (produção).
 *
 * O valor é definido aqui, e não no script `dev`, porque `export VAR=valor` é
 * sintaxe POSIX e quebra no `cmd.exe` do Windows. O padrão do Node é
 * "desenvolvimento" — só a produção define `NODE_ENV=production`.
 */
process.env.NODE_ENV ??= "development";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
