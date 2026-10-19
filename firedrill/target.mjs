import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { ApplicationError, commandMain, invokeCLI, privateDirectory } from './adapter-runtime.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const cases = new Set(JSON.parse(readFileSync(new URL('../data/manifest.json', import.meta.url))).cases.map(item => item.id));
export async function runApplication(input, parameters, signal, invocation) {
  if (Object.keys(input).some(key => !["caseId", "action", "task"].includes(key)) || !cases.has(input.caseId) || !['operate', 'inspect'].includes(input.action) ||
      typeof input.task !== 'string' || !input.task.trim() || input.task.length > 2000 || input.task.includes('\0')) throw new Error('Supply a reviewed case, explicit action/task and independent caller permissions/target where required.');
  const directory = await privateDirectory(root, invocation);
  try {
    const output = await invokeCLI([process.execPath, 'firedrill/portal-driver.mjs', JSON.stringify(input), directory, parameters.model ?? ''], { cwd: root, signal, timeoutMs: 210000 });
    return { application: output, localState: { directory, workspaceFile: output.workspaceFile } };
  } catch (error) { if (error instanceof ApplicationError) error.evidence.runDirectory = directory; throw error; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await commandMain(runApplication);
