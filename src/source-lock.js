import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { StateError } from "./state-contracts.js";
export function ownedPath(file) {
  const resolved = path.resolve(
      fs.realpathSync(path.dirname(path.resolve(file))),
      path.basename(file),
    ),
    info = fs.lstatSync(resolved);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
    throw new StateError(
      "invalid_state",
      "Source must be one owned regular file without aliases",
    );
  return resolved;
}
export function locked(file, work, guard = () => {}) {
  guard({ phase: "start" });
  const lock = `${file}.lock.sqlite`;
  try {
    fs.closeSync(fs.openSync(lock, "wx", 0o600));
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const inode = fs.lstatSync(lock);
  if (!inode.isFile() || inode.isSymbolicLink() || inode.nlink !== 1)
    throw new StateError("invalid_state", "Source lock inode is not owned");
  const db = new DatabaseSync(lock);
  let began = false;
  try {
    db.exec("PRAGMA busy_timeout=1000; BEGIN IMMEDIATE");
    began = true;
    const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all(),
      version = db.prepare("PRAGMA user_version").get().user_version;
    if (!tables.length && version === 0) {
      db.exec(
        "CREATE TABLE source_mutex(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL CHECK(version=1)); INSERT INTO source_mutex VALUES(1,1); PRAGMA user_version=1",
      );
    } else if (
      version !== 1 ||
      tables.length !== 1 ||
      tables[0].name !== "source_mutex" ||
      db.prepare("SELECT * FROM source_mutex").all().length !== 1 ||
      db.prepare("SELECT version FROM source_mutex WHERE id=1").get()
        ?.version !== 1
    )
      throw new StateError(
        "invalid_state",
        "Source lock format is unsupported",
      );
    const current = fs.lstatSync(lock);
    if (current.ino !== inode.ino || current.dev !== inode.dev)
      throw new StateError(
        "invalid_state",
        "Persistent source lock was replaced",
      );
    guard({ phase: "locked" });
    const value = work(() => {
      const current = fs.lstatSync(lock);
      if (current.ino !== inode.ino || current.dev !== inode.dev)
        throw new StateError(
          "invalid_state",
          "Persistent source lock was replaced",
        );
    });
    db.exec("COMMIT");
    began = false;
    return value;
  } catch (error) {
    if (began)
      try {
        db.exec("ROLLBACK");
      } catch {}
    if (error.errcode === 5 || error.errcode === 6)
      throw new StateError(
        "state_busy",
        "Source is busy; recover the same original request before retrying",
      );
    throw error;
  } finally {
    db.close();
  }
}
