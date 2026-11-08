async function coreConnection(desktop) {
  return desktop.evaluate(({ app }) => {
    if (!app.__VEACOM_PRIVILEGED_TEST__) throw new Error('This harness requires VEACOM_TEST_MODE=1.');
    return app.__VEACOM_PRIVILEGED_TEST__.coreConnection();
  });
}

async function authorizeImportPaths(desktop, paths) {
  return desktop.evaluate(({ app }, paths) => {
    if (!app.__VEACOM_PRIVILEGED_TEST__) throw new Error('This harness requires VEACOM_TEST_MODE=1.');
    return app.__VEACOM_PRIVILEGED_TEST__.authorizeImportPaths(paths);
  }, paths);
}

async function importPaths(desktop, page, paths) {
  const capabilities = await authorizeImportPaths(desktop, paths);
  await page.evaluate(capabilities => window.__VEACOM_TEST__.importPaths(capabilities), capabilities);
}

// A request to the engine, made by the main process: the engine's pipes never leave it. The answer is
// { status, ok, headers, byteLength, sha256, json, generation }, json for a JSON body (engine-pipe.cjs has the ops).
async function coreRequest(desktop, op, body) {
  return desktop.evaluate(({ app }, { op, body }) => {
    if (!app.__VEACOM_PRIVILEGED_TEST__) throw new Error('This harness requires VEACOM_TEST_MODE=1.');
    return app.__VEACOM_PRIVILEGED_TEST__.coreRequest(op, body);
  }, { op, body });
}

async function readCatalog(desktop) {
  const answer = await coreRequest(desktop, 'series');
  if (!answer.ok) throw new Error(`Native catalog read failed: ${answer.status}`);
  return { catalog: answer.json, generation: answer.generation };
}

module.exports = { coreConnection, coreRequest, authorizeImportPaths, importPaths, readCatalog };
