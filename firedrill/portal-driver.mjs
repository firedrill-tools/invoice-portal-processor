import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { initializeCase } from '../src/datasets.js';
import { startServer } from '../src/server.js';
import { ApplicationError, invokeCLI } from './adapter-runtime.mjs';
const [encoded, directory, model] = process.argv.slice(2);
const input = JSON.parse(encoded), controller = new AbortController();
const stop = () => controller.abort(new Error('Portal target interrupted.'));
for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(name, stop);
let file = join(directory, 'workspace.json'), server, failed = false;
const report = { executionKind: input.action === 'inspect' ? 'portal_http_inspection' : 'native_browser_operator' };
try {
  file = initializeCase(input.caseId, join(directory, 'workspace')).workspace_file;
  report.workspaceFile = file;
  report.before = JSON.parse(await readFile(file, 'utf8'));
  controller.signal.throwIfAborted();
  server = await new Promise((resolve, reject) => startServer(file, 0).then(resolve, reject));
  const origin = `http://127.0.0.1:${server.address().port}`;
  if (input.action === 'inspect') {
    const response = await fetch(origin, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) }), html = await response.text();
    const path = join(directory, 'portal-inspection.html');
    await writeFile(path, html, { flag: 'wx', mode: 0o600, flush: true });
    report.http = { status: response.status, title: /<title>([^<]+)<\/title>/.exec(html)?.[1] ?? null, htmlFile: path, url: response.url };
    failed = response.status !== 200;
  } else {
    const argv = [process.execPath, 'src/operator.js', input.task];
    report.operator = await invokeCLI(argv, { signal: controller.signal, env: { ...process.env, INVOICE_PORTAL_URL: origin, INVOICE_OUTPUT_ROOT: join(directory, 'evidence'), ...(model ? { ANTHROPIC_MODEL: model } : {}) }, timeoutMs: 180000 });
  }
} catch (error) {
  failed = true; report.error = { message: error.message, ...(error instanceof ApplicationError ? { application: error.evidence } : {}) };
} finally {
  try { if (report.workspaceFile) report.after = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { failed = true; report.stateError = error.message; }
  try { if (server) { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); report.serverClosed = !server.listening; } }
  catch (error) { failed = true; report.cleanupError = error.message; }
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(name, stop);
}
console.log(JSON.stringify(report));
if (failed || controller.signal.aborted || report.serverClosed !== true) process.exitCode = 1;
