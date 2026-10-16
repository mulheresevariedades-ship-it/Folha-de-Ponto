import path from "node:path";

export function dataRoot(): string {
	return path.resolve(process.env.PONTO_DATA_DIR ?? "data");
}
