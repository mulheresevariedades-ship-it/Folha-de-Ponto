import { and, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import multer from "multer";
import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { PDFDocument } from "pdf-lib";
import { createWorker } from "tesseract.js";
import { db, batches, employees, timesheets } from "@workspace/db";
import { recordAudit, normalizeSearch } from "../lib/audit";
import { dataRoot } from "../lib/storage";

const router: IRouter = Router();
const upload = multer({
	storage: multer.memoryStorage(),
	limits: { fileSize: 20 * 1024 * 1024, files: 10 },
});
const execFile = promisify(execFileCallback);
const maxTotalBytes = 50 * 1024 * 1024;
const maxPages = 100;
const statusLabels: Record<string, string> = {
	reconhecida: "Reconhecida",
	revisao: "Revisão necessária",
	ocr_indisponivel: "OCR indisponível",
};

type UploadedFile = Express.Multer.File;
type EmployeeRow = typeof employees.$inferSelect;
type AnalysisEntry = {
	sourceFilename: string;
	sourceBuffer: Buffer;
	sourceHash: string;
	fileIndex: number;
	pageNumber: number;
	pageBuffer: Buffer;
	name: string;
	matricula: string | null;
	competency: string;
	competencySource: "conteudo-pdf" | "ocr" | "fallback" | "nao-identificada";
	confidence: number;
	employee: EmployeeRow | null;
	personKey: string;
	duplicate: boolean;
	duplicateInUpload: boolean;
	needsReview: boolean;
	ocrUnavailable: boolean;
};
type AnalysisError = {
	sourceFilename: string;
	message: string;
};

let activeOcrWorker: Awaited<ReturnType<typeof createWorker>> | null = null;
let pdfQueue: Promise<void> = Promise.resolve();

async function serializePdfWork<T>(work: () => Promise<T>): Promise<T> {
	const previous = pdfQueue;
	let release!: () => void;
	pdfQueue = new Promise<void>((resolve) => {
		release = resolve;
	});
	await previous;
	try {
		return await work();
	} finally {
		release();
	}
}

function readFiles(req: Express.Request): UploadedFile[] {
	return Array.isArray(req.files) ? req.files : [];
}

function competencyFromContent(text: string): string | null {
	const normalized = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR");
	const monthMap: Record<string, string> = {
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
	for (const [monthName, monthNumber] of Object.entries(monthMap)) {
		const match = normalized.match(new RegExp(`\\b${monthName}\\s*(?:de\\s*)?(20\\d{2})\\b`));
		if (match) return `${match[1]}-${monthNumber}`;
	}
	const monthYear = normalized.match(/\b(0?[1-9]|1[0-2])\s*[/. -]\s*(20\d{2})\b/);
	if (monthYear) return `${monthYear[2]}-${monthYear[1].padStart(2, "0")}`;
	const reference = normalized.match(/\b(?:competencia|referencia)\s*[:\-]?\s*(0?[1-9]|1[0-2])\s*[/.-]\s*(20\d{2})\b/);
	if (reference) return `${reference[2]}-${reference[1].padStart(2, "0")}`;
	return null;
}

function matriculaFromContent(text: string): string | null {
	const normalized = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
	const match = normalized.match(/\bmatricula\b[^\d]{0,36}(\d[\d./-]{2,})/i);
	return match ? match[1].replace(/\D/g, "") : null;
}

function nameFromContent(text: string): string | null {
	const normalizedLines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	for (let index = 0; index < normalizedLines.length; index += 1) {
		const line = normalizedLines[index];
		const match = line.match(/\bnome(?:\s+(?:do|da)\s+servidor(?:a)?)?\s*[:\-]\s*(.+)$/i);
		if (match) {
			const value = match[1].split(/\b(?:matr[ií]cula|cpf|compet[eê]ncia)\b/i)[0].trim();
			if (value.length >= 3) return value.slice(0, 140);
			const next = normalizedLines[index + 1] ?? "";
			if (next.length >= 3 && !/matr[ií]cula|cpf|compet[eê]ncia/i.test(next)) return next.slice(0, 140);
		}
	}
	return null;
}

function safeSlug(value: string): string {
	const slug = value
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-zA-Z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 100);
	return slug || "Servidor-nao-identificado";
}

function isTrue(value: unknown): boolean {
	return value === true || ["true", "1", "sim", "yes"].includes(String(value ?? "").trim().toLowerCase());
}

async function recognizeImage(imagePath: string): Promise<{ text: string; confidence: number }> {
	if (!activeOcrWorker) activeOcrWorker = await createWorker("por+eng");
	const recognized = await activeOcrWorker.recognize(imagePath);
	return {
		text: recognized.data.text ?? "",
		confidence: Number.isFinite(recognized.data.confidence) ? Math.round(recognized.data.confidence) : 0,
	};
}

async function extractPageText(pdfPath: string, pageNumber: number, tempDir: string) {
	try {
		const result = await execFile("pdftotext", ["-f", String(pageNumber), "-l", String(pageNumber), "-layout", pdfPath, "-"], {
			maxBuffer: 2 * 1024 * 1024,
		});
		if (result.stdout.trim().length >= 24) {
			return { text: result.stdout, source: "conteudo-pdf" as const, ocrConfidence: 100, ocrUnavailable: false };
		}
	} catch {
		// A scanned page can still be processed with OCR below.
	}
	try {
		const imagePrefix = path.join(tempDir, `page-${randomUUID()}`);
		await execFile("pdftoppm", [
			"-f",
			String(pageNumber),
			"-l",
			String(pageNumber),
			"-png",
			"-r",
			"180",
			"-singlefile",
			pdfPath,
			imagePrefix,
		]);
		const result = await recognizeImage(`${imagePrefix}.png`);
		return { text: result.text, source: "ocr" as const, ocrConfidence: result.confidence, ocrUnavailable: false };
	} catch {
		return { text: "", source: "ocr" as const, ocrConfidence: 0, ocrUnavailable: true };
	}
}

function matchedEmployee(text: string, extractedMatricula: string | null, extractedName: string | null, candidates: EmployeeRow[]) {
	const digitsInText = text.replace(/\D/g, "");
	const byMatricula = candidates.find((employee) => {
		const digits = employee.matricula.replace(/\D/g, "");
		return extractedMatricula ? digits === extractedMatricula : digits.length >= 4 && digitsInText.includes(digits);
	});
	if (byMatricula) return byMatricula;
	const normalized = normalizeSearch(text);
	return candidates.find((employee) => normalized.includes(normalizeSearch(employee.name))) ?? null;
}

async function analyzeFiles(files: UploadedFile[], fallbackCompetency: string) {
	if (!files.length) throw new Error("Envie pelo menos um PDF.");
	const totalBytes = files.reduce((total, file) => total + file.size, 0);
	if (totalBytes > maxTotalBytes) throw new Error("O lote ultrapassa o limite de 50 MB.");

	const sourceDocs: Array<{ file: UploadedFile; path: string; document: PDFDocument; hash: string }> = [];
	const errors: AnalysisError[] = [];
	let totalPages = 0;
	for (const file of files) {
		if (path.extname(file.originalname).toLowerCase() !== ".pdf" || file.buffer.subarray(0, 5).toString() !== "%PDF-") {
			errors.push({ sourceFilename: file.originalname, message: "Somente arquivos PDF válidos são aceitos." });
			continue;
		}
		let document: PDFDocument;
		try {
			document = await PDFDocument.load(file.buffer);
		} catch {
			errors.push({ sourceFilename: file.originalname, message: "O arquivo não pôde ser lido como PDF." });
			continue;
		}
		totalPages += document.getPageCount();
		if (totalPages > maxPages) throw new Error(`O lote pode conter no máximo ${maxPages} páginas.`);
		const hash = createHash("sha256").update(file.buffer).digest("hex");
		sourceDocs.push({ file, path: "", document, hash });
	}
	if (!sourceDocs.length) {
		throw new Error(errors[0]?.message ?? "Nenhum PDF válido foi enviado.");
	}

	const activeEmployees = await db.select().from(employees).where(eq(employees.active, true));
	const knownSheets = await db.select({
		employeeId: timesheets.employeeId,
		personKey: timesheets.personCompetencyKey,
		competency: timesheets.competency,
	}).from(timesheets);
	const existingKeys = new Set<string>();
	for (const sheet of knownSheets) {
		if (sheet.personKey) existingKeys.add(`${sheet.personKey}|${sheet.competency}`);
		if (sheet.employeeId) existingKeys.add(`employee:${sheet.employeeId}|${sheet.competency}`);
	}

	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ponto-batch-"));
	const entries: AnalysisEntry[] = [];
	const seenInUpload = new Set<string>();
	try {
		for (let fileIndex = 0; fileIndex < sourceDocs.length; fileIndex += 1) {
			const source = sourceDocs[fileIndex];
			const sourcePath = path.join(tempDir, `source-${fileIndex}.pdf`);
			await fs.writeFile(sourcePath, source.file.buffer);
			source.path = sourcePath;
			for (let pageIndex = 0; pageIndex < source.document.getPageCount(); pageIndex += 1) {
				const pageDocument = await PDFDocument.create();
				const [page] = await pageDocument.copyPages(source.document, [pageIndex]);
				pageDocument.addPage(page);
				const pageBuffer = Buffer.from(await pageDocument.save());
				const extracted = await extractPageText(sourcePath, pageIndex + 1, tempDir);
				const text = extracted.text.trim();
				const foundMatricula = matriculaFromContent(text);
				const foundName = nameFromContent(text);
				const employee = matchedEmployee(text, foundMatricula, foundName, activeEmployees);
				const name = employee?.name ?? foundName ?? "";
				const matricula = employee?.matricula ?? foundMatricula;
				const detectedCompetency = competencyFromContent(text);
				const competency = detectedCompetency ?? fallbackCompetency;
				const competencySource = detectedCompetency
					? extracted.source
					: fallbackCompetency
						? "fallback"
						: "nao-identificada";
				const personKey = employee
					? `employee:${employee.id}`
					: name
						? `name:${createHash("sha256").update(normalizeSearch(name)).digest("hex")}`
						: `page:${createHash("sha256").update(pageBuffer).digest("hex")}`;
				const duplicateKey = competency ? `${personKey}|${competency}` : "";
				const duplicateInUpload = Boolean(duplicateKey && seenInUpload.has(duplicateKey));
				if (duplicateKey) seenInUpload.add(duplicateKey);
				const duplicate = Boolean(duplicateKey && (existingKeys.has(duplicateKey) || duplicateInUpload));
				const confidence = text.length === 0
					? 0
					: Math.min(
							98,
							Math.max(
								20,
								Math.round(
									(extracted.source === "ocr" ? extracted.ocrConfidence * 0.6 : 72) +
										(employee ? 22 : 0) +
										(detectedCompetency ? 8 : 0),
								),
							),
						);
				const needsReview = !employee || !detectedCompetency || confidence < 85 || extracted.ocrUnavailable;
				entries.push({
					sourceFilename: source.file.originalname,
					sourceBuffer: source.file.buffer,
					sourceHash: source.hash,
					fileIndex,
					pageNumber: pageIndex + 1,
					pageBuffer,
					name,
					matricula,
					competency,
					competencySource,
					confidence,
					employee: employee ?? null,
					personKey,
					duplicate,
					duplicateInUpload,
					needsReview,
					ocrUnavailable: extracted.ocrUnavailable,
				});
			}
		}
		return { entries, errors };
	} finally {
		if (activeOcrWorker) {
			await activeOcrWorker.terminate().catch(() => undefined);
			activeOcrWorker = null;
		}
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}

function toPreview(entries: AnalysisEntry[], errors: AnalysisError[] = []) {
	const duplicateCount = entries.filter((entry) => entry.duplicate).length;
	const reviewCount = entries.filter((entry) => entry.needsReview).length;
	return {
		entries: entries.map((entry) => ({
			sourceFilename: entry.sourceFilename,
			pageNumber: entry.pageNumber,
			name: entry.name || "Não identificado",
			matricula: entry.matricula,
			competency: entry.competency,
			confidence: entry.confidence,
			duplicate: entry.duplicate,
			duplicateInUpload: entry.duplicateInUpload,
			needsReview: entry.needsReview,
		})),
		newCount: entries.length - duplicateCount,
		duplicateCount,
		reviewCount,
		errors,
	};
}

async function makeOldPath(filePath: string): Promise<string> {
	const compact = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
	const timestamp = `${compact.slice(0, 8)}-${compact.slice(8)}`;
	const parsed = path.parse(filePath);
	let candidate = path.join(parsed.dir, `${parsed.name}_OLD_${timestamp}${parsed.ext}`);
	let suffix = 1;
	while (await fs.access(candidate).then(() => true).catch(() => false)) {
		candidate = path.join(parsed.dir, `${parsed.name}_OLD_${timestamp}-${String(suffix).padStart(3, "0")}${parsed.ext}`);
		suffix += 1;
	}
	return candidate;
}

async function createArchivePath(entry: AnalysisEntry, previousPath?: string | null): Promise<string> {
	if (previousPath) {
		await fs.mkdir(path.dirname(previousPath), { recursive: true });
		return previousPath;
	}
	const root = dataRoot();
	const monthDirectory = path.join(root, `Folhas_${entry.competency}`);
	await fs.mkdir(monthDirectory, { recursive: true });
	const baseName = safeSlug(entry.name);
	const suffix = entry.employee ? "" : entry.matricula ? `-${safeSlug(entry.matricula)}` : "";
	let candidate = path.join(monthDirectory, `${baseName}${suffix}-${entry.competency}.pdf`);
	if (!(await fs.access(candidate).then(() => true).catch(() => false))) return candidate;
	const stats = await fs.stat(candidate);
	if (stats.isFile()) {
		candidate = path.join(monthDirectory, `${baseName}${suffix}-${entry.competency}-${entry.sourceHash.slice(0, 8)}-${entry.pageNumber}.pdf`);
	}
	return candidate;
}

async function persistEntries(entries: AnalysisEntry[], replaceDuplicates: boolean) {
	if (entries.some((entry) => !/^\d{4}-(0[1-9]|1[0-2])$/.test(entry.competency))) {
		throw new Error("Não foi possível identificar a competência de uma ou mais páginas. Selecione uma competência de fallback e revise a prévia.");
	}
	const duplicateEntries = entries.filter((entry) => entry.duplicate);
	if (duplicateEntries.length && !replaceDuplicates) {
		return { conflict: true as const, preview: toPreview(entries) };
	}
	const root = dataRoot();
	const sourceDirectory = path.join(root, "uploads", "sources");
	await fs.mkdir(sourceDirectory, { recursive: true });

	const batchIds = new Map<string, string>();
	for (const entry of entries) {
		if (batchIds.has(entry.sourceHash)) continue;
		const [previous] = await db.select({ id: batches.id }).from(batches).where(eq(batches.fileHash, entry.sourceHash)).limit(1);
		if (previous) {
			batchIds.set(entry.sourceHash, previous.id);
			continue;
		}
		const sourcePath = path.join(sourceDirectory, `${entry.sourceHash}.pdf`);
		await fs.writeFile(sourcePath, entry.sourceBuffer);
		const [batch] = await db
			.insert(batches)
			.values({
				originalFilename: entry.sourceFilename,
				storagePath: sourcePath,
				fileHash: entry.sourceHash,
				mimeType: "application/pdf",
				pageCount: entries.filter((candidate) => candidate.sourceHash === entry.sourceHash).length,
			})
			.returning({ id: batches.id });
		batchIds.set(entry.sourceHash, batch.id);
	}

	let created = 0;
	let updated = 0;
	let skipped = 0;
	const committedEntries: AnalysisEntry[] = [];
	const fileChanges: Array<{ archivePath: string; backupPath: string | null; restorePath: string }> = [];
	const committedUploadKeys = new Set<string>();
	try {
		await db.transaction(async (tx) => {
			for (const entry of entries) {
				const uploadKey = `${entry.personKey}|${entry.competency}`;
				if (committedUploadKeys.has(uploadKey)) {
					skipped += 1;
					continue;
				}
				const criteria = and(
					eq(timesheets.competency, entry.competency),
					entry.employee
						? eq(timesheets.employeeId, entry.employee.id)
						: eq(timesheets.personCompetencyKey, entry.personKey),
				);
				const [existing] = await tx.select().from(timesheets).where(criteria).limit(1);
				if (existing && !replaceDuplicates) {
					skipped += 1;
					continue;
				}
				const archivePath = await createArchivePath(entry, existing?.originalFilePath);
				const restorePath = existing?.originalFilePath ?? archivePath;
				let backupPath: string | null = null;
				if (await fs.access(restorePath).then(() => true).catch(() => false)) {
					backupPath = await makeOldPath(restorePath);
					await fs.rename(restorePath, backupPath);
				}
				fileChanges.push({ archivePath, backupPath, restorePath });
				await fs.writeFile(archivePath, entry.pageBuffer);
				const status: (typeof timesheets.$inferInsert)["status"] = entry.ocrUnavailable
					? "ocr_indisponivel"
					: entry.needsReview
						? "revisao"
						: "reconhecida";
				const note = entry.needsReview
					? entry.ocrUnavailable
						? "OCR indisponível nesta página; confira os dados manualmente."
						: "Confirme nome, matrícula e competência antes de arquivar."
					: null;
				const values = {
					batchId: batchIds.get(entry.sourceHash) ?? null,
					employeeId: entry.employee?.id ?? null,
					competency: entry.competency,
					personCompetencyKey: entry.personKey,
					confidence: entry.confidence,
					status,
					statusLabel: statusLabels[status],
					note,
					extractedData: {
						name: entry.name,
						matricula: entry.matricula,
						competencySource: entry.competencySource,
					},
					originalFilePath: archivePath,
					updatedAt: new Date(),
				};
				if (existing) {
					await tx.update(timesheets).set(values).where(eq(timesheets.id, existing.id));
					updated += 1;
				} else {
					await tx.insert(timesheets).values({
						...values,
						reference: `F-${randomUUID().slice(0, 8).toUpperCase()}`,
					});
					created += 1;
				}
				committedUploadKeys.add(uploadKey);
				committedEntries.push(entry);
			}
		});
	} catch (error) {
		for (const change of fileChanges.reverse()) {
			await fs.rm(change.archivePath, { force: true });
			if (change.backupPath) await fs.rename(change.backupPath, change.restorePath).catch(() => undefined);
		}
		throw error;
	}
	for (const entry of committedEntries) {
		await recordAudit("folha_processada", "timesheet", entry.personKey, {
			name: entry.name,
			matricula: entry.matricula,
			competency: entry.competency,
			status: entry.needsReview ? "revisao" : "reconhecida",
		});
	}
	return {
		conflict: false as const,
		result: {
			created,
			updated,
			skipped,
			entries: toPreview(committedEntries).entries,
		},
	};
}

router.post("/batches/preview", upload.array("files", 10), async (req, res): Promise<void> => {
	try {
		const files = readFiles(req);
		const fallbackCompetency = String(req.body.fallbackCompetency ?? "").trim();
		if (fallbackCompetency && !/^\d{4}-(0[1-9]|1[0-2])$/.test(fallbackCompetency)) {
			res.status(400).json({ message: "Competência de fallback inválida. Use AAAA-MM." });
			return;
		}
		const analysis = await serializePdfWork(() => analyzeFiles(files, fallbackCompetency));
		res.json(toPreview(analysis.entries, analysis.errors));
	} catch (error) {
		res.status(422).json({ message: error instanceof Error ? error.message : "Não foi possível analisar o lote." });
	}
});

router.post("/batches", upload.array("files", 10), async (req, res, next): Promise<void> => {
	try {
		const files = readFiles(req);
		const fallbackCompetency = String(req.body.fallbackCompetency ?? "").trim();
		const replaceDuplicates = isTrue(req.body.replaceDuplicates);
		if (fallbackCompetency && !/^\d{4}-(0[1-9]|1[0-2])$/.test(fallbackCompetency)) {
			res.status(400).json({ message: "Competência de fallback inválida. Use AAAA-MM." });
			return;
		}
		const outcome = await serializePdfWork(async () => {
			const analysis = await analyzeFiles(files, fallbackCompetency);
			const result = await persistEntries(analysis.entries, replaceDuplicates);
			if (result.conflict) return result;
			return {
				...result,
				result: { ...result.result, errors: analysis.errors },
			};
		});
		if (outcome.conflict) {
			res.status(409).json(outcome.preview);
			return;
		}
		req.log.info(
			{ created: outcome.result.created, updated: outcome.result.updated, skipped: outcome.result.skipped },
			"PDF batch processed",
		);
		res.status(201).json(outcome.result);
	} catch (error) {
		if (
			error instanceof Error &&
			(error.message.includes("competência") ||
				error.message.includes("PDF") ||
				error.message.includes("lote") ||
				error.message.includes("páginas") ||
				error.message.includes("Envie pelo menos"))
		) {
			res.status(422).json({ message: error.message });
			return;
		}
		next(error);
	}
});

export default router;
