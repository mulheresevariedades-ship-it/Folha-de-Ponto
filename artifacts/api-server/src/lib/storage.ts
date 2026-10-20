import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Finds the workspace root instead of relying on the directory the process
 * happened to be started from. This keeps the shared data folder stable when
 * the system runs from a network share or from a shortcut.
 */
function findWorkspaceRoot(start: string): string | null {
	let directory = path.resolve(start);
	for (let depth = 0; depth < 8; depth += 1) {
		if (existsSync(path.join(directory, "pnpm-workspace.yaml"))) return directory;
		const parent = path.dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	return null;
}

export function workspaceRoot(): string {
	return findWorkspaceRoot(process.cwd()) ?? path.resolve(process.cwd());
}

/**
 * PONTO_DATA_DIR may be absolute (recommended for a network share) or relative
 * to the workspace root. When it is not set, the portable `data/` folder next
 * to the workspace is used.
 */
export function dataRoot(): string {
	const configured = process.env.PONTO_DATA_DIR?.trim();
	if (configured) {
		return path.isAbsolute(configured) ? path.normalize(configured) : path.resolve(workspaceRoot(), configured);
	}
	return path.join(workspaceRoot(), "data");
}
