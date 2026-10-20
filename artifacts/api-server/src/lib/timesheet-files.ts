import path from "node:path";

/**
 * Pure helpers for the timesheet archive. Keeping these free of database and
 * filesystem access makes it possible to test naming and recognition rules in
 * isolation.
 */

const MONTHS: Record<string, string> = {
	janeiro: "01",
	fevereiro: "02",
	marco: "03",
	abril: "04",
	maio: "05",
	junho: "06",
	julho: "07",
	agosto: "08",
	setembro: "09",
	outubro: "10",
	novembro: "11",
	dezembro: "12",
};

// Names that cannot be used as file names on Windows network shares.
const RESERVED_STEMS = new Set([
	"con",
	"prn",
	"aux",
	"nul",
	"com1",
	"com2",
	"com3",
	"com4",
	"com5",
	"com6",
	"com7",
	"com8",
	"com9",
	"lpt1",
	"lpt2",
	"lpt3",
	"lpt4",
	"lpt5",
	"lpt6",
	"lpt7",
	"lpt8",
	"lpt9",
]);

export function stripAccents(value: string): string {
	return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Produces a readable, portable file stem: no accents, no special characters,
 * no repeated underscores, no trailing dots/spaces and no Windows device names.
 */
export function sanitizeFileStem(value: string, maxLength = 110): string {
	let stem = stripAccents(String(value ?? ""))
		.replace(/[^a-zA-Z0-9]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "");
	if (!stem) return "";
	// Keep the beginning of long names so the server name stays recognizable.
	if (stem.length > maxLength) stem = stem.slice(0, maxLength).replace(/_+$/g, "");
	if (RESERVED_STEMS.has(stem.toLocaleLowerCase("en-US"))) stem = `${stem}_`;
	return stem;
}

export function isValidCompetency(value: string): boolean {
	return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

export function monthFolderName(competency: string): string {
	return `Folhas_${competency}`;
}

/**
 * Official archive name: Nome_do_servidor-AAAA-MM.pdf.
 * When the server could not be identified, the matrícula and a short page hash
 * keep different unidentified pages from colliding with each other.
 */
export function officialTimesheetFileName(input: {
	name: string;
	competency: string;
	matricula?: string | null;
	unidentifiedHash?: string | null;
}): string {
	const hasName = Boolean(sanitizeFileStem(input.name, 90));
	const base = hasName ? sanitizeFileStem(input.name, 90) : "Servidor_nao_identificado";
	const matricula = !hasName && input.matricula ? sanitizeFileStem(input.matricula, 24) : "";
	const hash = !hasName && input.unidentifiedHash ? sanitizeFileStem(input.unidentifiedHash, 8) : "";
	const extras = [base, matricula, hash].filter(Boolean).join("_");
	return `${extras}-${input.competency}.pdf`;
}

export function timestampForFileName(date = new Date()): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
	const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
	return `${day}-${time}`;
}

/** Maria_Silva-2027-01.pdf -> Maria_Silva-2027-01_OLD_20270215-143022.pdf */
export function oldTimesheetFileName(archivePath: string, date = new Date()): string {
	const parsed = path.parse(archivePath);
	return `${parsed.name}_OLD_${timestampForFileName(date)}${parsed.ext || ".pdf"}`;
}

export function isPdfBuffer(buffer: Buffer): boolean {
	return buffer.length >= 5 && buffer.subarray(0, 5).toString("latin1") === "%PDF-";
}

/**
 * Finds the reference month inside the page text. Labels and month names take
 * precedence; a bare MM/YYYY is only accepted when it is not part of a full
 * dd/mm/yyyy date.
 */
export function competencyFromContent(text: string): string | null {
	const normalized = stripAccents(text).toLocaleLowerCase("pt-BR");

	for (const [monthName, monthNumber] of Object.entries(MONTHS)) {
		const match = normalized.match(
			new RegExp(`\\b${monthName}\\b\\s*(?:de\\s*)?[\\/\\s-]*(20\\d{2})\\b`),
		);
		if (match) return `${match[1]}-${monthNumber}`;
	}

	const labelled = normalized.match(
		/\b(?:competencia|referencia|periodo|mes|folha)\b[^\d]{0,24}(\d{1,2})\s*[/.-]\s*(20\d{2})\b/,
	);
	if (labelled) {
		const month = Number(labelled[1]);
		if (month >= 1 && month <= 12) return `${labelled[2]}-${String(month).padStart(2, "0")}`;
	}

	const monthYear = normalized.match(/(?<![\d/])(0?[1-9]|1[0-2])\s*[/.-]\s*(20\d{2})\b/);
	if (monthYear) return `${monthYear[2]}-${monthYear[1].padStart(2, "0")}`;

	return null;
}

export function matriculaFromContent(text: string): string | null {
	const normalized = stripAccents(text);
	const match = normalized.match(/\bmatricula\b[^\d]{0,36}(\d[\d./-]{2,})/i);
	return match ? match[1].replace(/\D/g, "") : null;
}

export function nameFromContent(text: string): string | null {
	const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const match = line.match(
			/\b(?:nome(?:\s+(?:do|da)\s+servidor(?:a)?)?|servidor(?:\(a\))?)\s*[:\-]\s*(.+)$/i,
		);
		if (match) {
			const value = match[1].split(/\b(?:matr[ií]cula|cpf|compet[eê]ncia)\b/i)[0].trim();
			if (value.length >= 3) return value.slice(0, 140);
			const next = lines[index + 1] ?? "";
			if (next.length >= 3 && !/matr[ií]cula|cpf|compet[eê]ncia/i.test(next)) return next.slice(0, 140);
		}
	}
	return null;
}
