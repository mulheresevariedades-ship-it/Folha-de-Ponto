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
import {
	competencyFromContent,
	isPdfBuffer,
	isValidCompetency,
	matriculaFromContent,
	monthFolderName,
	nameFromContent,
	officialTimesheetFileName,
	oldTimesheetFileName,
} from "../lib/timesheet-files";

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
type CompetencySource = "conteudo-pdf" | "ocr" | "fallback" | "nao-identificada";

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
	competencyDetected: boolean;
	competencySource: CompetencySource;
	confidence: number;
	employee: EmployeeRow | null;
	personKey: string;
	duplicate: boolean;
	duplicateInUpload: boolean;
	duplicateReason: string | null;
	needsReview: boolean;
	ocrUnavailable: boolean;
};
type AnalysisError = { sourceFilename: string; pageNumber?: number; message: string };
type FileResult = { sourceFilename: string; pages: number; status: "processado" | "erro"; message: string | null };
type SkippedDetail = { sourceFilename: string; pageNumber: number; name: string; competency: string; reason: string };

/** Signals that the reference month could not be read from the PDF content. */
class FallbackRequiredError extends Error {
	constructor(
		readonly unidentifiedCount: number,
		readonly fallbackCompetency: string,
	) {
		super(
			`Não foi possível identificar a competência em ${unidentifiedCount} página(s). Confirme o uso da competência de referência antes de arquivar.`,
		);
		this.name = "FallbackRequiredError";
	}
}

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

function isTrue(value: unknown): boolean {
	return value === true || ["1", "true", "sim", "yes"].includes(String(value ?? "").trim().toLocaleLowerCase("pt-BR"));
}

async function pathExists(target: string): Promise<boolean> {
	return fs
		.access(target)
		.then(() => true)
		.catch(() => false);
}

async function makeOldPath(filePath: string): Promise<string> {
	const parsed = path.parse(filePath);
	const base = oldTimesheetFileName(filePath, new Date());
	if (!(await pathExists(base))) return base;
	let candidate = base;
	for (let suffix = 1; suffix <= 50; suffix += 1) {
		candidate = path.join(parsed.dir, `${path.parse(base).name}-${String(suffix).padStart(3, "0")}${parsed.ext}`);
		if (!(await pathExists(candidate))) return candidate;
	}
	return path.join(parsed.dir, `${parsed.name}_OLD_${Date.now()}${parsed.ext}`);
}

/** Official destination: Folhas_AAAA-MM/Nome_do_servidor-AAAA-MM.pdf */
function officialArchivePath(entry: AnalysisEntry): string {
	const displayName = entry.employee?.name || entry.name;
	const fileHash = createHash("sha256").update(entry.pageBuffer).digest("hex");
	const fileName = officialTimesheetFileName({
		name: displayName,
		competency: entry.competency,
		matricula: entry.matricula,
		unidentifiedHash: fileHash,
	});
	return path.join(dataRoot(), monthFolderName(entry.competency), fileName);
}

async function recognizePage(imagePath: string) {
	if (!activeOcrWorker) {
		activeOcrWorker = await createWorker("por+eng");
	}
	return activeOcrWorker.recognize(imagePath);
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
		const result = await recognizePage(`${imagePrefix}.png`);
		const confidence = result.data.confidence;
		return {
			text: result.data.text ?? "",
			source: "ocr" as const,
			ocrConfidence: Number.isFinite(confidence) ? Math.round(confidence) : 0,
			ocrUnavailable: false,
		};
	} catch {
		// OCR is optional: the operator can fill the data manually during review.
		return { text: "", source: "conteudo-pdf" as const, ocrConfidence: 0, ocrUnavailable: true };
	}
}

function matchedEmployee(text: string, matricula: string | null, name: string | null, candidates: EmployeeRow[]): EmployeeRow | null {
	const digitsInText = text.replace(/\D/g, "");
	if (matricula) {
		const byMatricula = candidates.find((employee) => employee.matricula.replace(/\D/g, "") === matricula);
		if (byMatricula) return byMatricula;
	}
	const normalizedText = normalizeSearch(text);
	const candidatesByName = [...candidates].sort((a, b) => b.name.length - a.name.length);
	for (const employee of candidatesByName) {
		const normalizedName = normalizeSearch(employee.name);
		if (normalizedName.length >= 5 && normalizedText.includes(normalizedName)) return employee;
	}
	if (name) {
		const normalizedInput = normalizeSearch(name);
		return candidates.find((candidate) => normalizeSearch(candidate.name) === normalizedInput) ?? null;
	}
	return null;
}

async function analyzeFiles(files: UploadedFile[], fallbackCompetency: string) {
	if (!files.length) throw new Error("Envie pelo menos um PDF.");
	const totalBytes = files.reduce((total, file) => total + file.size, 0);
	if (totalBytes > maxTotalBytes) throw new Error("O lote ultrapassa o limite de 50 MB.");

	const errors: AnalysisError[] = [];
	const fileResults: FileResult[] = [];
	const work: Array<{ file: UploadedFile; document: PDFDocument; hash: string }> = [];
	let totalPages = 0;
	for (const file of files) {
		if (path.extname(file.originalname).toLocaleLowerCase("pt-BR") !== ".pdf" || !isPdfBuffer(file.buffer)) {
			const message = "Somente arquivos PDF válidos são aceitos (o conteúdo não é um PDF).";
			errors.push({ sourceFilename: file.originalname, message });
			fileResults.push({ sourceFilename: file.originalname, pages: 0, status: "erro", message });
			continue;
		}
		let document: PDFDocument;
		try {
			document = await PDFDocument.load(file.buffer);
		} catch {
			const message = "O arquivo não pôde ser lido como PDF.";
			errors.push({ sourceFilename: file.originalname, message });
			fileResults.push({ sourceFilename: file.originalname, pages: 0, status: "erro", message });
			continue;
		}
		totalPages += document.getPageCount();
		if (totalPages > maxPages) throw new Error(`O lote pode conter no máximo ${maxPages} páginas.`);
		work.push({ file, document, hash: createHash("sha256").update(file.buffer).digest("hex") });
	}
	if (!work.length) throw new Error(errors[0]?.message ?? "Nenhum PDF válido foi enviado.");

	const activeEmployees = await db.select().from(employees).where(eq(employees.active, true));
	const knownSheets = await db
		.select({ employeeId: timesheets.employeeId, personKey: timesheets.personCompetencyKey, competency: timesheets.competency })
		.from(timesheets);
	const existingKeys = new Set<string>();
	for (const sheet of knownSheets) {
		if (sheet.personKey) existingKeys.add(`${sheet.personKey}|${sheet.competency}`);
		if (sheet.employeeId) existingKeys.add(`employee:${sheet.employeeId}|${sheet.competency}`);
	}

	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ponto-batch-"));
	const entries: AnalysisEntry[] = [];
	const seenInUpload = new Set<string>();
	try {
		for (let fileIndex = 0; fileIndex < work.length; fileIndex += 1) {
			const source = work[fileIndex];
			const sourcePath = path.join(tempDir, `source-${fileIndex}.pdf`);
			await fs.writeFile(sourcePath, source.file.buffer);
			let pages = 0;
			let fileMessage: string | null = null;
			for (let pageNumber = 1; pageNumber <= source.document.getPageCount(); pageNumber += 1) {
				try {
					const target = await PDFDocument.create();
					const [copied] = await target.copyPages(source.document, [pageNumber - 1]);
					target.addPage(copied);
					const pageBuffer = Buffer.from(await target.save());
					const extracted = await extractPageText(sourcePath, pageNumber, tempDir);
					const text = extracted.text;
					const detectedMatricula = matriculaFromContent(text);
					const detectedName = nameFromContent(text);
					const employee = matchedEmployee(text, detectedMatricula, detectedName, activeEmployees);
					const name = employee?.name || detectedName || "";
					const matricula = employee?.matricula || detectedMatricula;
					const detectedCompetency = competencyFromContent(text);
					const competency = detectedCompetency ?? fallbackCompetency;
					const competencyDetected = Boolean(detectedCompetency);
					const personKey = employee
						? `employee:${employee.id}`
						: name
							? `name:${createHash("sha256").update(normalizeSearch(name)).digest("hex")}`
							: `page:${createHash("sha256").update(pageBuffer).digest("hex")}`;
					const duplicateKey = competency ? `${personKey}|${competency}` : "";
					const duplicateInUpload = Boolean(duplicateKey && seenInUpload.has(duplicateKey));
					if (duplicateKey) seenInUpload.add(duplicateKey);
					const alreadyArchived = Boolean(duplicateKey && existingKeys.has(duplicateKey));
					const confidence =
						text.length === 0
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
					entries.push({
						sourceFilename: source.file.originalname,
						sourceBuffer: source.file.buffer,
						sourceHash: source.hash,
						fileIndex,
						pageNumber,
						pageBuffer,
						name,
						matricula,
						competency,
						competencyDetected,
						competencySource: detectedCompetency ? extracted.source : fallbackCompetency ? "fallback" : "nao-identificada",
						confidence,
						employee: employee ?? null,
						personKey,
						duplicate: alreadyArchived || duplicateInUpload,
						duplicateInUpload,
						duplicateReason: alreadyArchived ? "já arquivada para esta pessoa e competência" : duplicateInUpload ? "repetida dentro do próprio lote" : null,
						needsReview: !employee || !detectedCompetency || confidence < 85 || extracted.ocrUnavailable,
						ocrUnavailable: extracted.ocrUnavailable,
					});
					pages += 1;
				} catch (error) {
					const message = error instanceof Error ? `Página não processada: ${error.message}` : "Página não processada.";
					errors.push({ sourceFilename: source.file.originalname, pageNumber, message });
					fileMessage = message;
				}
			}
			fileResults.push({
				sourceFilename: source.file.originalname,
				pages,
				status: fileMessage ? "erro" : "processado",
				message: fileMessage,
			});
		}
		return { entries, errors, fileResults };
	} finally {
		if (activeOcrWorker) {
			await activeOcrWorker.terminate().catch(() => undefined);
			activeOcrWorker = null;
		}
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}

function toPreview(entries: AnalysisEntry[], errors: AnalysisError[] = [], fileResults: FileResult[] = []) {
	const duplicateCount = entries.filter((entry) => entry.duplicate).length;
	const reviewCount = entries.filter((entry) => entry.needsReview).length;
	const unidentifiedCount = entries.filter((entry) => !entry.competencyDetected).length;
	return {
		entries: entries.map((entry) => ({
			sourceFilename: entry.sourceFilename,
			pageNumber: entry.pageNumber,
			name: entry.name || "Não identificado",
			matricula: entry.matricula,
			competency: entry.competency || "",
			competencyDetected: entry.competencyDetected,
			competencySource: entry.competencySource,
			confidence: entry.confidence,
			duplicate: entry.duplicate,
			duplicateInUpload: entry.duplicateInUpload,
			duplicateReason: entry.duplicateReason,
			needsReview: entry.needsReview,
		})),
		newCount: entries.filter((entry) => !entry.duplicate).length,
		duplicateCount,
		reviewCount,
		unidentifiedCount,
		errors,
		fileResults,
	};
}

type FileChange = { target: string; backupPath: string; restorePath: string };

async function restoreChanges(changes: FileChange[]): Promise<void> {
	for (const change of [...changes].reverse()) {
		await fs.rm(change.target, { force: true }).catch(() => undefined);
		await fs.rename(change.backupPath, change.restorePath).catch(() => undefined);
	}
}

/**
 * Archives one page. Existing files are never deleted: the previous version is
 * renamed with the _OLD_<AAAAMMDD-HHMMSS> suffix before the new file is written.
 */
async function saveEntry(entry: AnalysisEntry, replaceDuplicates: boolean, batchId: string | null): Promise<"created" | "updated" | "skipped"> {
	const criteria = and(
		eq(timesheets.competency, entry.competency),
		entry.employee ? eq(timesheets.employeeId, entry.employee.id) : eq(timesheets.personCompetencyKey, entry.personKey),
	);
	const [existing] = await db.select().from(timesheets).where(criteria).limit(1);
	if (existing && !replaceDuplicates) return "skipped";

	const archivePath = officialArchivePath(entry);
	await fs.mkdir(path.dirname(archivePath), { recursive: true });
	const changes: FileChange[] = [];
	try {
		if (existing?.originalFilePath) {
			const previous = path.resolve(existing.originalFilePath);
			if (previous !== path.resolve(archivePath) && (await pathExists(previous))) {
				const backupPath = await makeOldPath(archivePath);
				await fs.rename(previous, backupPath);
				changes.push({ target: previous, backupPath, restorePath: previous });
			}
		}
		if (await pathExists(archivePath)) {
			const backupPath = await makeOldPath(archivePath);
			await fs.rename(archivePath, backupPath);
			changes.push({ target: archivePath, backupPath, restorePath: archivePath });
		}
		await fs.writeFile(archivePath, entry.pageBuffer);
	} catch (error) {
		await restoreChanges(changes);
		throw error;
	}

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
	try {
		await db.transaction(async (tx) => {
			const values = {
				batchId,
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
			} else {
				await tx.insert(timesheets).values({ ...values, reference: `F-${randomUUID().slice(0, 8).toUpperCase()}` });
			}
		});
	} catch (error) {
		await fs.rm(archivePath, { force: true }).catch(() => undefined);
		await restoreChanges(changes);
		throw error;
	}
	return existing ? "updated" : "created";
}

type PersistOutcome =
	| { conflict: true; preview: ReturnType<typeof toPreview> }
	| {
			conflict: false;
			result: {
				created: number;
				updated: number;
				skipped: number;
				entries: ReturnType<typeof toPreview>["entries"];
				errors: AnalysisError[];
				skippedDetails: SkippedDetail[];
				duplicatesInBatch: number;
				fileResults: FileResult[];
			};
	  };

async function persistEntries(
	entries: AnalysisEntry[],
	replaceDuplicates: boolean,
	confirmFallback: boolean,
	analysis: { errors: AnalysisError[]; fileResults: FileResult[] },
): Promise<PersistOutcome> {
	if (entries.some((entry) => !isValidCompetency(entry.competency))) {
		throw new Error(
			"Não foi possível identificar a competência de uma ou mais páginas. Selecione uma competência de referência e revise a prévia.",
		);
	}
	const unidentified = entries.filter((entry) => !entry.competencyDetected);
	if (unidentified.length && !confirmFallback) {
		throw new FallbackRequiredError(unidentified.length, entries.find((entry) => entry.competency)?.competency ?? "");
	}
	if (entries.some((entry) => entry.duplicate) && !replaceDuplicates) {
		return { conflict: true, preview: toPreview(entries, analysis.errors, analysis.fileResults) };
	}

	const root = dataRoot();
	const sourceDirectory = path.join(root, "uploads", "sources");
	await fs.mkdir(sourceDirectory, { recursive: true }).catch(() => undefined);
	const batchIds = new Map<string, string | null>();
	const errors: AnalysisError[] = [...analysis.errors];
	for (const entry of entries) {
		if (batchIds.has(entry.sourceHash)) continue;
		try {
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
		} catch (error) {
			batchIds.set(entry.sourceHash, null);
			errors.push({
				sourceFilename: entry.sourceFilename,
				message: error instanceof Error ? `Falha ao registrar o arquivo original: ${error.message}` : "Falha ao registrar o arquivo original.",
			});
		}
	}

	const skippedDetails: SkippedDetail[] = [];
	const planned: AnalysisEntry[] = [];
	const seen = new Set<string>();
	let duplicatesInBatch = 0;
	for (const entry of entries) {
		const key = `${entry.personKey}|${entry.competency}`;
		if (seen.has(key)) {
			duplicatesInBatch += 1;
			skippedDetails.push({
				sourceFilename: entry.sourceFilename,
				pageNumber: entry.pageNumber,
				name: entry.name || "Não identificado",
				competency: entry.competency,
				reason: "Página repetida no mesmo lote — a primeira versão foi mantida.",
			});
			continue;
		}
		seen.add(key);
		planned.push(entry);
	}

	let created = 0;
	let updated = 0;
	for (const entry of planned) {
		try {
			const outcome = await saveEntry(entry, replaceDuplicates, batchIds.get(entry.sourceHash) ?? null);
			if (outcome === "created") created += 1;
			else if (outcome === "updated") updated += 1;
			else
				skippedDetails.push({
					sourceFilename: entry.sourceFilename,
					pageNumber: entry.pageNumber,
					name: entry.name || "Não identificado",
					competency: entry.competency,
					reason: "Folha já existente para esta pessoa e competência.",
				});
		} catch (error) {
			// One failing page must not stop the remaining files.
			errors.push({
				sourceFilename: entry.sourceFilename,
				pageNumber: entry.pageNumber,
				message: error instanceof Error ? `Não foi possível arquivar: ${error.message}` : "Não foi possível arquivar esta página.",
			});
		}
	}

	for (const entry of planned) {
		await recordAudit("folha_processada", "timesheet", entry.personKey, {
			name: entry.name,
			matricula: entry.matricula,
			competency: entry.competency,
			competencySource: entry.competencySource,
			status: entry.needsReview ? "revisao" : "reconhecida",
			sourceFilename: entry.sourceFilename,
			pageNumber: entry.pageNumber,
		}).catch(() => undefined);
	}

	return {
		conflict: false,
		result: {
			created,
			updated,
			skipped: skippedDetails.length,
			entries: toPreview(planned, errors, analysis.fileResults).entries,
			errors,
			skippedDetails,
			duplicatesInBatch,
			fileResults: analysis.fileResults,
		},
	};
}

router.post("/batches/preview", upload.array("files", 10), async (req, res): Promise<void> => {
	try {
		const files = readFiles(req);
		const fallbackCompetency = String(req.body.fallbackCompetency ?? "").trim();
		if (fallbackCompetency && !isValidCompetency(fallbackCompetency)) {
			res.status(400).json({ message: "Competência de fallback inválida. Use AAAAMM." });
			return;
		}
		const analysis = await serializePdfWork(() => analyzeFiles(files, fallbackCompetency));
		res.json(toPreview(analysis.entries, analysis.errors, analysis.fileResults));
	} catch (error) {
		res.status(422).json({ message: error instanceof Error ? error.message : "Não foi possível analisar o lote." });
	}
});

router.post("/batches", upload.array("files", 10), async (req, res, next): Promise<void> => {
	try {
		const files = readFiles(req);
		const fallbackCompetency = String(req.body.fallbackCompetency ?? "").trim();
		const replaceDuplicates = isTrue(req.body.replaceDuplicates);
		const confirmFallback = isTrue(req.body.confirmFallback);
		if (fallbackCompetency && !isValidCompetency(fallbackCompetency)) {
			res.status(400).json({ message: "Competência de fallback inválida. Use AAAAMM." });
			return;
		}
		const analysis = await serializePdfWork(() => analyzeFiles(files, fallbackCompetency));
		const outcome = await persistEntries(analysis.entries, replaceDuplicates, confirmFallback, analysis);
		if (outcome.conflict) {
			res.status(409).json(outcome.preview);
			return;
		}
		req.log.info(
			{ created: outcome.result.created, updated: outcome.result.updated, skipped: outcome.result.skipped },
			"Timesheet batch archived",
		);
		res.status(201).json(outcome.result);
	} catch (error) {
		if (error instanceof FallbackRequiredError) {
			res.status(422).json({
				message: error.message,
				requiresFallbackConfirmation: true,
				unidentifiedCount: error.unidentifiedCount,
				fallbackCompetency: error.fallbackCompetency,
			});
			return;
		}
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
