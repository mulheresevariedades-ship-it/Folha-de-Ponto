// CommonJS entry: Vercel does not transform it (no ESM->CJS compile),
// and any module-load failure is surfaced in the response instead of
// the generic FUNCTION_INVOCATION_FAILED.
let app;
try {
	const mod = require("../artifacts/api-server/dist/app.mjs");
	app = mod && mod.default ? mod.default : mod;
} catch (err) {
	app = function (_req, res) {
		res.statusCode = 500;
		res.setHeader("Content-Type", "text/plain; charset=utf-8");
		res.end(
			"BOOT_ERROR node=" +
				process.version +
				" " +
				((err && (err.stack || err.message)) || String(err)),
		);
	};
}
module.exports = app;
