import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { officialTimesheetFileName } from "./timesheet-files";

/**
 * Geração da folha de ponto em PDF sem depender de LibreOffice/Word.
 *
 * O documento é montado com `pdf-lib` (já usado na leitura dos PDFs), então o
 * mesmo código roda na Vercel e no pacote portátil. O calendário acadêmico da
 * competência entra na coluna "Observação"; sábados e domingos são marcados
 * automaticamente. O nome oficial do arquivo é o mesmo do arquivo arquivado:
 * `Nome_do_servidor-AAAA-MM.pdf`.
 */

export interface TimesheetSpecialDate {
	/** Data no formato AAAA-MM-DD. */
	date: string;
	description: string;
}

export interface TimesheetPdfInput {
	employeeName: string;
	matricula: string;
	competency: string;
	workloadHours: number;
	specialDates: TimesheetSpecialDate[];
	generatedAt?: Date;
}

const MONTH_NAMES = [
	"janeiro",
	"fevereiro",
	"março",
	"abril",
	"maio",
	"junho",
	"julho",
	"agosto",
	"setembro",
	"outubro",
	"novembro",
	"dezembro",
];

const WEEKDAY_NAMES = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

/**
 * Helvetica padrão usa WinAnsiEncoding: cobre acentos do português, mas não
 * emojis nem símbolos fora de Latin-1. Texto imprevisível (nome lido por OCR)
 * precisa ser normalizado antes de chegar ao PDF, senão o pdf-lib lança erro.
 */
export function sanitizePdfText(value: string): string {
	return value
		.normalize("NFC")
		.replace(/[\u2018\u2019]/g, "'")
		.replace(/[\u201C\u201D]/g, '"')
		.replace(/[\u2013\u2014]/g, "-")
		.replace(/\u2026/g, "...")
		.replace(/[^\x20-\x7E\u00A0-\u00FF]/g, "");
}

function fitText(value: string, font: PDFFont, size: number, maxWidth: number): string {
	const clean = sanitizePdfText(value);
	if (font.widthOfTextAtSize(clean, size) <= maxWidth) return clean;
	let result = clean;
	while (result.length > 1 && font.widthOfTextAtSize(`${result}...`, size) > maxWidth) {
		result = result.slice(0, -1);
	}
	return `${result}...`;
}

export function officialGeneratedTimesheetFileName(input: {
	employeeName: string;
	matricula?: string | null;
	competency: string;
}): string {
	return officialTimesheetFileName({
		name: input.employeeName,
		competency: input.competency,
		matricula: input.matricula ?? null,
	});
}

function formatDateTime(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function monthLabel(competency: string): string {
	const [year, month] = competency.split("-");
	return `${MONTH_NAMES[Number(month) - 1] ?? month} de ${year}`;
}

function drawCell(
	page: PDFPage,
	text: string,
	font: PDFFont,
	size: number,
	x: number,
	y: number,
	width: number,
	align: "left" | "center" = "left",
) {
	const content = fitText(text, font, size, width - 6);
	const textWidth = font.widthOfTextAtSize(content, size);
	const drawX = align === "center" ? x + (width - textWidth) / 2 : x + 3;
	page.drawText(content, { x: drawX, y, size, font, color: rgb(0.12, 0.16, 0.14) });
}

export async function buildTimesheetPdf(input: TimesheetPdfInput): Promise<Buffer> {
	const [yearText, monthText] = input.competency.split("-");
	const year = Number(yearText);
	const month = Number(monthText);
	if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
		throw new Error("Competência inválida para gerar a folha.");
	}

	const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
	const specialsByDate = new Map(input.specialDates.map((event) => [event.date, event.description]));

	const document = await PDFDocument.create();
	document.setTitle(`Folha de ponto - ${sanitizePdfText(input.employeeName)} - ${input.competency}`);
	document.setAuthor("Ponto Digital DIGEP");
	document.setCreator("Ponto Digital DIGEP");
	document.setProducer("Ponto Digital DIGEP");

	const regular = await document.embedFont(StandardFonts.Helvetica);
	const bold = await document.embedFont(StandardFonts.HelveticaBold);
	const page = document.addPage([595.28, 841.89]);
	const { width, height } = page.getSize();
	const margin = 40;
	const tableWidth = width - margin * 2;
	const ink = rgb(0.12, 0.16, 0.14);
	const soft = rgb(0.45, 0.52, 0.48);

	let y = height - 52;
	const centered = (text: string, size: number, font: PDFFont, color = ink) => {
		const content = fitText(text, font, size, tableWidth);
		page.drawText(content, { x: margin + (tableWidth - font.widthOfTextAtSize(content, size)) / 2, y, size, font, color });
		y -= size + 5;
	};

	centered("REGISTRO DE FREQUÊNCIA", 16, bold);
	centered(`Competência: ${monthLabel(input.competency)}`, 11, regular, soft);
	y -= 10;

	page.drawText("Servidor(a):", { x: margin, y, size: 10, font: bold, color: ink });
	page.drawText(fitText(input.employeeName, regular, 11, tableWidth - 80), {
		x: margin + 74,
		y,
		size: 11,
		font: regular,
		color: ink,
	});
	y -= 17;

	page.drawText(`Matrícula: ${sanitizePdfText(input.matricula)}`, { x: margin, y, size: 10, font: regular, color: ink });
	const workload = `Carga horária: ${input.workloadHours} horas`;
	page.drawText(workload, { x: margin + tableWidth - regular.widthOfTextAtSize(workload, 10), y, size: 10, font: regular, color: ink });
	y -= 14;

	page.drawText("Preencha os horários de entrada e saída em cada dia útil.", { x: margin, y, size: 8.5, font: regular, color: soft });
	y -= 14;

	const columns = [
		{ label: "Dia", width: 30, align: "center" as const },
		{ label: "Dia da semana", width: 70, align: "left" as const },
		{ label: "Entrada", width: 56, align: "center" as const },
		{ label: "Saída", width: 56, align: "center" as const },
		{ label: "Entrada", width: 56, align: "center" as const },
		{ label: "Saída", width: 56, align: "center" as const },
		{ label: "Observação", width: 0, align: "left" as const },
	];
	columns[6].width = tableWidth - columns.slice(0, 6).reduce((total, column) => total + column.width, 0);

	const headerHeight = 18;
	const rowHeight = 16.2;
	const tableTop = y;
	const tableHeight = headerHeight + rowHeight * daysInMonth;

	page.drawRectangle({
		x: margin,
		y: tableTop - headerHeight,
		width: tableWidth,
		height: headerHeight,
		color: rgb(0.92, 0.95, 0.93),
	});
	let columnX = margin;
	for (const column of columns) {
		drawCell(page, column.label, bold, 8.5, columnX, tableTop - headerHeight + 5, column.width, column.align);
		columnX += column.width;
	}

	for (let day = 1; day <= daysInMonth; day += 1) {
		const date = `${input.competency}-${String(day).padStart(2, "0")}`;
		const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
		const observation = specialsByDate.get(date) ?? (weekday === 0 ? "Domingo" : weekday === 6 ? "Sábado" : "");
		const rowTop = tableTop - headerHeight - rowHeight * (day - 1);
		const textY = rowTop - rowHeight + 5;
		let cellX = margin;
		const values = [
			String(day).padStart(2, "0"),
			WEEKDAY_NAMES[weekday] ?? "",
			"",
			"",
			"",
			"",
			observation,
		];
		values.forEach((value, index) => {
			drawCell(page, value, index === 0 ? bold : regular, 8, cellX, textY, columns[index].width, columns[index].align);
			cellX += columns[index].width;
		});
	}

	// Grade da tabela (linhas horizontais + colunas verticais).
	const tableBottom = tableTop - tableHeight;
	const horizontalLines = [tableTop, tableTop - headerHeight];
	for (let day = 1; day <= daysInMonth; day += 1) {
		horizontalLines.push(tableTop - headerHeight - rowHeight * day);
	}
	for (const lineY of horizontalLines) {
		page.drawLine({
			start: { x: margin, y: lineY },
			end: { x: margin + tableWidth, y: lineY },
			thickness: 0.5,
			color: rgb(0.72, 0.78, 0.74),
		});
	}
	let gridX = margin;
	for (const column of columns) {
		page.drawLine({
			start: { x: gridX, y: tableTop },
			end: { x: gridX, y: tableBottom },
			thickness: 0.5,
			color: rgb(0.72, 0.78, 0.74),
		});
		gridX += column.width;
	}
	page.drawLine({
		start: { x: margin + tableWidth, y: tableTop },
		end: { x: margin + tableWidth, y: tableBottom },
		thickness: 0.5,
		color: rgb(0.72, 0.78, 0.74),
	});

	const generatedAt = input.generatedAt ?? new Date();
	const footerY = Math.max(54, tableBottom - 42);
	page.drawText(`Documento gerado em ${formatDateTime(generatedAt)} · Ponto Digital DIGEP`, {
		x: margin,
		y: footerY + 26,
		size: 7.5,
		font: regular,
		color: soft,
	});
	page.drawLine({
		start: { x: margin + 70, y: footerY },
		end: { x: margin + tableWidth - 70, y: footerY },
		thickness: 0.8,
		color: ink,
	});
	const signature = fitText(`Assinatura do(a) servidor(a) — ${input.employeeName}`, regular, 8.5, tableWidth - 40);
	page.drawText(signature, {
		x: margin + (tableWidth - regular.widthOfTextAtSize(signature, 8.5)) / 2,
		y: footerY - 12,
		size: 8.5,
		font: regular,
		color: ink,
	});

	return Buffer.from(await document.save());
}
