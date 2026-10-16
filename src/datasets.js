import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Store } from "./state.js";
import { sha, validateState, timestamp, canonical } from "./state-contracts.js";
const defaultRoot = fileURLToPath(new URL("../data/", import.meta.url));
const family = "ledgerline-invoice-workspace",
  version = "1.0.0";
const profiles = ["starter", "busy", "ambiguous", "boundary"];
const identifier = (value) =>
  typeof value === "string" && /^[a-z][a-z0-9-]{0,79}$/.test(value);
const token = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const uuid = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    value,
  );
const text = (value) =>
  typeof value === "string" &&
  Boolean(value.trim()) &&
  value.length <= 2000 &&
  !/[\u0000-\u001f\u007f]/.test(value);
const need = (value, message) => {
  if (!value) throw new Error(message);
};
function exact(value, keys) {
  need(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join(",") === [...keys].sort().join(","),
    "Unsupported dataset record",
  );
}
function read(file, maximum = 1048576) {
  const info = fs.lstatSync(file);
  need(
    info.isFile() &&
      !info.isSymbolicLink() &&
      info.nlink === 1 &&
      info.size <= maximum,
    "Dataset must be one bounded regular file",
  );
  const bytes = fs.readFileSync(file);
  return {
    bytes,
    value: JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)),
  };
}
const serialized = (value) => JSON.stringify(value, null, 2) + "\n";
function sourceRoot(value) {
  const candidate = path.resolve(value ?? defaultRoot),
    info = fs.lstatSync(candidate);
  need(
    info.isDirectory() && !info.isSymbolicLink(),
    "Dataset root must be an existing directory without a symlink",
  );
  return fs.realpathSync(candidate);
}
export function loadCases(dataRoot) {
  const root = sourceRoot(dataRoot),
    manifest = read(path.join(root, "manifest.json")).value;
  exact(manifest, ["dataset_id", "version", "provenance", "cases"]);
  need(
    manifest.dataset_id === family &&
      manifest.version === version &&
      text(manifest.provenance) &&
      Array.isArray(manifest.cases) &&
      manifest.cases.length >= 1 &&
      manifest.cases.length <= 64,
    "Unsupported dataset family/version/cases",
  );
  const ids = new Set(),
    cases = new Map();
  const directory = path.join(root, "cases"),
    directoryInfo = fs.lstatSync(directory);
  need(
    directoryInfo.isDirectory() && !directoryInfo.isSymbolicLink(),
    "Dataset cases directory must not be a symlink",
  );
  for (const item of manifest.cases) {
    exact(item, ["id", "profile", "file", "sha256", "task", "focus"]);
    need(
      identifier(item.id) &&
        !ids.has(item.id) &&
        profiles.includes(item.profile) &&
        item.file === `${item.id}.json` &&
        token(item.sha256) &&
        text(item.task) &&
        text(item.focus),
      "Invalid dataset case metadata",
    );
    ids.add(item.id);
    const source = read(path.join(directory, item.file));
    need(sha(source.bytes) === item.sha256, "Dataset case hash mismatch");
    exact(source.value, [
      "dataset_id",
      "version",
      "case_id",
      "profile",
      "state",
    ]);
    need(
      source.value.dataset_id === family &&
        source.value.version === version &&
        source.value.case_id === item.id &&
        source.value.profile === item.profile,
      "Dataset case identity mismatch",
    );
    const state = validateState(source.value.state);
    // Templates describe imported business facts, not fabricated previous operator requests.
    need(
      state.submissions.length === 0 &&
        state.audit.length === 0 &&
        state.legacy_entry_ids.length === 0 &&
        state.legacy_audit_count === 0 &&
        state.revision === 1 &&
        state.entries.every(
          (entry) => entry.provenance?.kind === "human_import",
        ),
      "Dataset templates must contain only original imported human history",
    );
    cases.set(item.id, { metadata: item, state, bytes: source.bytes });
  }
  return { root, manifest, cases };
}
export const listCases = (dataRoot) => loadCases(dataRoot).manifest;
function exclusive(file, value) {
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(fd, serialized(value));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function syncDirectory(directory) {
  const fd = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
export function initializeCase(caseId, destination, dataRoot) {
  const data = loadCases(dataRoot),
    selected = data.cases.get(caseId);
  need(selected, "Unknown dataset case");
  need(
    typeof destination === "string" && destination.trim(),
    "New private case directory required",
  );
  const requested = path.resolve(destination),
    parent = fs.realpathSync(path.dirname(requested)),
    directory = path.join(parent, path.basename(requested)),
    relative = path.relative(data.root, directory);
  need(
    relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative),
    "Private case must be outside bundled data",
  );
  // The parent must already exist. Only this newly and exclusively created leaf is owned here.
  fs.mkdirSync(directory, { mode: 0o700 });
  try {
    const state = structuredClone(selected.state);
    state.instance_id = randomUUID();
    validateState(state);
    const metadata = {
      schema_version: 1,
      dataset_id: family,
      version,
      case_id: caseId,
      profile: selected.metadata.profile,
      source_sha256: selected.metadata.sha256,
      instance_id: state.instance_id,
      initial_state_sha256: sha(serialized(state)),
      initialized_at: new Date().toISOString(),
    };
    exclusive(path.join(directory, "workspace.json"), state);
    exclusive(path.join(directory, "case.json"), metadata);
    syncDirectory(directory);
    syncDirectory(parent);
    return {
      directory,
      workspace_file: path.join(directory, "workspace.json"),
      ...metadata,
      task: selected.metadata.task,
      focus: selected.metadata.focus,
    };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
export function showCase(directory, dataRoot) {
  const data = loadCases(dataRoot),
    resolved = path.resolve(directory),
    info = fs.lstatSync(resolved);
  need(
    info.isDirectory() && !info.isSymbolicLink(),
    "Private case directory required",
  );
  const metadata = read(path.join(resolved, "case.json")).value;
  exact(metadata, [
    "schema_version",
    "dataset_id",
    "version",
    "case_id",
    "profile",
    "source_sha256",
    "instance_id",
    "initial_state_sha256",
    "initialized_at",
  ]);
  const selected = data.cases.get(metadata.case_id);
  need(
    metadata.schema_version === 1 &&
      metadata.dataset_id === family &&
      metadata.version === version &&
      selected &&
      metadata.profile === selected.metadata.profile &&
      metadata.source_sha256 === selected.metadata.sha256 &&
      uuid(metadata.instance_id) &&
      token(metadata.initial_state_sha256) &&
      timestamp(metadata.initialized_at),
    "Private case identity/provenance mismatch",
  );
  const original = {
    ...structuredClone(selected.state),
    instance_id: metadata.instance_id,
  };
  need(
    sha(serialized(original)) === metadata.initial_state_sha256,
    "Private initial source binding is invalid",
  );
  const state = new Store(path.join(resolved, "workspace.json"), {
    requireVersioned: true,
  }).read();
  need(
    state.instance_id === metadata.instance_id,
    "Private workspace instance differs from its case",
  );
  return {
    directory: resolved,
    metadata,
    task: selected.metadata.task,
    focus: selected.metadata.focus,
    current_state_sha256: sha(serialized(state)),
    changed_since_initialization: canonical(state) !== canonical(original),
    state,
  };
}
const usage =
  "Usage: npm run cases -- list [--data-root PATH] | init CASE NEW_PRIVATE_DIRECTORY [--data-root PATH] | show PRIVATE_DIRECTORY [--data-root PATH] | --help. The parent directory must already exist.";
export function caseCommand(args) {
  const values = [...args],
    index = values.indexOf("--data-root");
  let dataRoot;
  if (index !== -1) {
    dataRoot = values[index + 1];
    need(dataRoot && !dataRoot.startsWith("--"), "--data-root needs one path");
    values.splice(index, 2);
  }
  need(
    !values.includes("--data-root") &&
      values.every((value) => !value.startsWith("--") || value === "--help"),
    "Unknown or duplicate options",
  );
  const [command, ...rest] = values;
  need(
    !rest.some((value) => value.startsWith("--")),
    "Unexpected positional option",
  );
  if (command === "--help" && !rest.length && dataRoot === undefined)
    return { usage };
  if (command === "list" && !rest.length) return listCases(dataRoot);
  if (command === "init" && rest.length === 2)
    return initializeCase(rest[0], rest[1], dataRoot);
  if (command === "show" && rest.length === 1)
    return showCase(rest[0], dataRoot);
  throw new Error(usage);
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    console.log(JSON.stringify(caseCommand(process.argv.slice(2)), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
