// Vercel function entry. The repo is CommonJS, but the built server is ESM
// (dist/app.mjs), so the only supported bridge is a dynamic import() — a static
// `import` gets compiled to require() (ERR_REQUIRE_ESM) and naming this file
// .mjs makes Vercel's own wrapper reference `module` in ESM scope. The import
// promise is cached per function instance to avoid re-loading on every request.
let appPromise;

module.exports = (req, res) => {
  if (!appPromise) {
    appPromise = import("../artifacts/api-server/dist/app.mjs").then(
      (mod) => mod.default,
    );
  }
  return appPromise.then((app) => app(req, res));
};
