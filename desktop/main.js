"use strict";

/**
 * Processo principal do Ponto Digital (Electron).
 *
 * O aplicativo não reimplementa a interface: inicia o servidor portátil que já
 * existe (`resources/portable/server/portable.mjs`, o mesmo do modo portátil)
 * e mostra essa interface numa janela própria. Toda a lógica de banco, OCR,
 * locks e pasta de rede continua no backend.
 */

const { app, BrowserWindow, dialog, Menu, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const {
	createLogger,
	ensureServer,
	resolveDataDir,
	stopServer,
} = require("./launcher");

/* ------------------------------------------------------------------ *
 * Pastas
 * ------------------------------------------------------------------ */

/**
 * Raiz do aplicativo no perfil do usuário: executáveis em Program Files (ou
 * `%LOCALAPPDATA%\Programs`) e dados graváveis aqui. `LOCALAPPDATA` evita a
 * sincronização do perfil e não exige privilégio de administrador.
 */
function appBaseDir() {
	const override = process.env.PONTO_DESKTOP_HOME?.trim();
	if (override) return path.resolve(override);
	const local = process.env.LOCALAPPDATA?.trim();
	return path.join(local || app.getPath("appData"), "PontoDigital");
}

const baseDir = appBaseDir();
fs.mkdirSync(baseDir, { recursive: true });

// Mantém caches/estado do próprio Electron junto dos demais dados (por padrão
// ele usaria %APPDATA%\Ponto Digital, em roaming).
app.setPath("userData", path.join(baseDir, "electron"));

const log = createLogger(path.join(baseDir, "logs", "launcher.log"));
const version = app.getVersion();

function portableDir() {
	if (app.isPackaged) return path.join(process.resourcesPath, "portable");
	// Desenvolvimento: `dist-portable/` na raiz do repositório.
	return process.env.PONTO_PORTABLE_DIR
		? path.resolve(process.env.PONTO_PORTABLE_DIR)
		: path.resolve(__dirname, "..", "dist-portable");
}

function iconPath() {
	const packaged = path.join(process.resourcesPath, "app-icon.png");
	if (app.isPackaged && fs.existsSync(packaged)) return packaged;
	const dev = path.resolve(__dirname, "..", "assets", "icon.png");
	return fs.existsSync(dev) ? dev : undefined;
}

/* ------------------------------------------------------------------ *
 * Janelas
 * ------------------------------------------------------------------ */

let mainWindow = null;
let splashWindow = null;
let server = null;
let shutdownStarted = false;
let shutdownDone = false;

function splashHtml() {
	return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<style>
	html, body { margin: 0; height: 100%; overflow: hidden; }
	body {
		display: flex; flex-direction: column; align-items: center; justify-content: center;
		gap: 14px; background: #ff3c00; color: #fff;
		font-family: "Segoe UI", system-ui, sans-serif; user-select: none;
	}
	.logo {
		width: 64px; height: 64px; border-radius: 16px; background: rgba(255,255,255,.16);
		display: flex; align-items: center; justify-content: center; font-size: 34px;
	}
	h1 { font-size: 22px; font-weight: 600; margin: 0; letter-spacing: .2px; }
	p { margin: 0; font-size: 13px; opacity: .92; }
	.bar { width: 180px; height: 3px; background: rgba(255,255,255,.28); border-radius: 2px; overflow: hidden; }
	.bar span { display: block; width: 40%; height: 100%; background: #fff; border-radius: 2px; animation: slide 1.2s ease-in-out infinite; }
	@keyframes slide { 0% { transform: translateX(-110%); } 100% { transform: translateX(360%); } }
</style>
</head>
<body>
	<div class="logo">🕒</div>
	<h1>Ponto Digital</h1>
	<p>Iniciando o sistema…</p>
	<div class="bar"><span></span></div>
</body>
</html>`;
}

function createSplash() {
	splashWindow = new BrowserWindow({
		width: 440,
		height: 280,
		frame: false,
		resizable: false,
		show: false,
		alwaysOnTop: true,
		icon: iconPath(),
		title: "Ponto Digital",
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
	});
	splashWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(splashHtml())}`);
	splashWindow.once("ready-to-show", () => splashWindow?.show());
	splashWindow.on("closed", () => {
		splashWindow = null;
	});
}

function closeSplash() {
	if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy();
	splashWindow = null;
}

function openMainWindow(port) {
	const origin = `http://127.0.0.1:${port}`;

	mainWindow = new BrowserWindow({
		width: 1280,
		height: 860,
		minWidth: 1024,
		minHeight: 700,
		show: false,
		title: "Ponto Digital",
		icon: iconPath(),
		autoHideMenuBar: true,
		backgroundColor: "#ffffff",
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			webviewTag: false,
			spellcheck: false,
		},
	});

	// A interface é local: só ela pode navegar. Links externos vão para o
	// navegador padrão, nunca para dentro da janela do sistema.
	const isLocalUi = (url) => {
		try {
			return new URL(url).origin === origin;
		} catch {
			return false;
		}
	};
	mainWindow.webContents.on("will-navigate", (event, url) => {
		if (isLocalUi(url)) return;
		event.preventDefault();
		if (/^https?:/i.test(url)) void shell.openExternal(url);
	});
	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		if (/^https?:/i.test(url)) void shell.openExternal(url);
		return { action: "deny" };
	});
	mainWindow.webContents.on("did-fail-load", (_event, code, description) => {
		log.error(`Falha ao carregar a interface (${code}): ${description}`);
	});

	mainWindow.once("ready-to-show", () => {
		closeSplash();
		mainWindow?.show();
	});
	mainWindow.on("closed", () => {
		mainWindow = null;
		log.info("Janela principal fechada.");
		app.quit();
	});

	void mainWindow.loadURL(`${origin}/`);
	log.info(`Interface aberta em ${origin}/.`);
}

/* ------------------------------------------------------------------ *
 * Erros
 * ------------------------------------------------------------------ */

function showFatalError(error) {
	const message = error?.userMessage || "Não foi possível iniciar o Ponto Digital.";
	const detail = [
		error?.detail ? `Detalhes: ${error.detail}` : "",
		"",
		"Tente abrir novamente. Caso o problema continue, consulte o arquivo de diagnóstico:",
		path.join(baseDir, "logs", "launcher.log"),
	]
		.filter((line) => line !== "")
		.join("\n");
	log.error(`${message} ${error?.detail ?? ""} ${error?.stack ?? ""}`.trim());
	closeSplash();
	dialog.showMessageBoxSync({
		type: "error",
		title: "Ponto Digital",
		message,
		detail,
		noLink: true,
		buttons: ["Fechar"],
	});
}

/* ------------------------------------------------------------------ *
 * Inicialização
 * ------------------------------------------------------------------ */

async function startup() {
	log.info(`Ponto Digital ${version} iniciando (${app.isPackaged ? "instalado" : "desenvolvimento"}).`);
	log.info(`Pasta de dados: ${resolveDataDir(baseDir)}`);
	createSplash();

	try {
		server = await ensureServer({
			baseDir,
			portableDir: portableDir(),
			log,
			version,
		});
		log.info(`Backend pronto na porta ${server.port}${server.reused ? " (reutilizado)" : ""}.`);
		openMainWindow(server.port);
	} catch (error) {
		showFatalError(error);
		app.quit();
	}
}

/* ------------------------------------------------------------------ *
 * Ciclo de vida
 * ------------------------------------------------------------------ */

app.setAppUserModelId("br.edu.undf.pontodigital");
Menu.setApplicationMenu(null);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
	// Já existe uma janela aberta: o clique no atalho apenas traz ela para a
	// frente (o evento `second-instance` da instância principal cuida disso).
	app.quit();
} else {
	app.on("second-instance", () => {
		log.info("Segundo clique no atalho: trazendo a janela existente para a frente.");
		if (mainWindow) {
			if (mainWindow.isMinimized()) mainWindow.restore();
			mainWindow.focus();
		}
	});

	app.on("window-all-closed", () => {
		app.quit();
	});

	// Todo pedido de saída é segurado até o backend fechar o banco e liberar a
	// trava. Sem isso, o segundo pedido (janela fechada + window-all-closed)
	// encerraria o processo no meio do encerramento e deixaria o servidor órfão.
	app.on("before-quit", (event) => {
		if (shutdownDone) return;
		event.preventDefault();
		if (shutdownStarted) return;
		shutdownStarted = true;
		log.info("Encerrando o Ponto Digital…");
		const finish = () => {
			shutdownDone = true;
			app.quit();
		};
		if (!server) {
			finish();
			return;
		}
		void stopServer(server, log).finally(finish);
	});

	app.on("will-quit", () => {
		log.info("Ponto Digital encerrado.");
	});

	app.whenReady().then(startup).catch((error) => {
		showFatalError(error);
		app.quit();
	});
}
