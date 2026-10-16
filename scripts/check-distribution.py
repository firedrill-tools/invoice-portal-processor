"""Build a deterministic complete source archive and qualify a fresh locked copy."""
from hashlib import sha256
import gzip
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[1]
VERSION = json.loads((ROOT / "package.json").read_text())["version"]
NAME = "invoice-portal-processor-" + VERSION
NODE, NPM = shutil.which("node"), shutil.which("npm")
if not NODE or not NPM:
    raise RuntimeError("Node24+, npm and Python3.9+ are required")
ENV = dict(os.environ)
for key in list(ENV):
    if key.startswith("ANTHROPIC_") or key.startswith("INVOICE_") or key in {"PORT", "NODE_PATH", "NODE_OPTIONS"} or key.lower() == "npm_config_allow_scripts":
        ENV.pop(key)
ENV.update({"NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost"})


def run(command, cwd, extra=None):
    result = subprocess.run([str(part) for part in command], cwd=cwd, env={**ENV, **(extra or {})}, capture_output=True, text=True, timeout=300)
    if result.returncode:
        raise RuntimeError("Failed %s\n%s\n%s" % (command[:3], result.stdout[-3000:], result.stderr[-4000:]))
    return result.stdout


def build():
    entries = [".env.example", ".gitattributes", ".gitignore", ".github", "AGENTS.md", "README.md", "PLAN.md", "COMPATIBILITY.md", "SOURCE.md", "DATA.md", "package.json", "package-lock.json", "src", "public", "fixtures", "data", "scenarios", "scripts", "tests"]
    files = {}
    for entry in entries:
        target = ROOT / entry
        if not target.exists():
            raise RuntimeError("Missing required source " + entry)
        for path in sorted(target.rglob("*") if target.is_dir() else [target]):
            relative = path.relative_to(ROOT)
            if "__pycache__" in relative.parts or path.name == ".DS_Store" or path.suffix == ".pyc":
                continue
            if path.is_symlink():
                raise RuntimeError("Unqualified source symlink: " + str(relative))
            if path.is_file():
                files[relative.as_posix()] = sha256(path.read_bytes()).hexdigest()
    if (ROOT / ".git").exists():
        tracked = run(["git", "ls-files", "--cached", "--others", "--exclude-standard"], ROOT).splitlines()
        missing = set(tracked) - set(files)
        if missing:
            raise RuntimeError("Source archive excludes repository files: " + str(sorted(missing)))
    artifact = ROOT / "dist" / (NAME + "-source.tar.gz")
    artifact.parent.mkdir(exist_ok=True)
    with artifact.open("wb") as output, gzip.GzipFile(filename="", fileobj=output, mode="wb", mtime=0) as compressed, tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
        for relative in sorted(files):
            path = ROOT / relative
            info = archive.gettarinfo(str(path), NAME + "/" + relative)
            info.uid = info.gid = info.mtime = 0
            info.uname = info.gname = ""
            info.mode = 0o644
            with path.open("rb") as source:
                archive.addfile(info, source)
    return artifact, files


proof_directory = ROOT / "dist"
for previous in [proof_directory / "distribution-proof.json", proof_directory / (NAME + "-source.tar.gz.sha256")]:
    previous.unlink(missing_ok=True)
artifact, files = build()
first_digest = sha256(artifact.read_bytes()).hexdigest()
repeated_artifact, repeated_files = build()
assert repeated_files == files and sha256(repeated_artifact.read_bytes()).hexdigest() == first_digest, "Repeated source archive differs"
with TemporaryDirectory(prefix="firedrill-invoice-distribution-") as temporary:
    base = Path(temporary).resolve()
    workspace = base / NAME
    with tarfile.open(artifact) as archive:
        members = archive.getmembers()
        if len(members) != len(files) or len({member.name for member in members}) != len(files):
            raise RuntimeError("Duplicate or missing archive records")
        for member in members:
            prefix = NAME + "/"
            if not member.isfile() or not member.name.startswith(prefix) or member.name[len(prefix):] not in files:
                raise RuntimeError("Unexpected archive member")
            target = workspace / member.name[len(prefix):]
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(member) as source:
                target.write_bytes(source.read())
    assert {path.relative_to(workspace).as_posix(): sha256(path.read_bytes()).hexdigest() for path in workspace.rglob("*") if path.is_file()} == files
    run([NPM, "ci", "--ignore-scripts", "--no-audit", "--no-fund"], workspace)
    for dependency in ["@anthropic-ai/sdk", "playwright", "express"]:
        resolved = Path(run([NODE, "-p", "require.resolve(" + json.dumps(dependency) + ")"], workspace).strip()).resolve()
        resolved.relative_to(workspace)
    run([NPM, "exec", "--no", "--", "playwright", "install", "chromium"], workspace)
    cli = [NODE, workspace / "src/datasets.js"]
    manifest = json.loads(run(cli + ["list"], base))
    assert len(manifest["cases"]) == 12
    for command in [cli, [NODE, workspace / "src/operator.js"], [NODE, workspace / "src/server.js"]]:
        run(command + ["--help"], base)
    destinations = base / "private-cases"
    destinations.mkdir(mode=0o700)
    for case in manifest["cases"]:
        initialized = json.loads(run(cli + ["init", case["id"], destinations / case["id"]], base))
        assert initialized["source_sha256"] == case["sha256"]
        directory = Path(initialized["directory"])
        assert directory.stat().st_mode & 0o777 == 0o700
        for name in ["workspace.json", "case.json"]:
            assert (directory / name).stat().st_mode & 0o777 == 0o600
        shown = json.loads(run(cli + ["show", directory], base))
        assert not shown["changed_since_initialization"]
    busy = destinations / "busy"
    before = (busy / "workspace.json").read_bytes()
    refused = subprocess.run([str(item) for item in cli + ["init", "starter", busy]], cwd=base, env=ENV, capture_output=True, timeout=15)
    assert refused.returncode == 1 and (busy / "workspace.json").read_bytes() == before
    negative = subprocess.run([NODE, str(workspace / "src/operator.js"), "Inspect the invoice inbox."], cwd=base, env={**ENV, "ANTHROPIC_MODEL": "synthetic-account-model", "INVOICE_OUTPUT_ROOT": str(base / "preflight")}, capture_output=True, text=True, timeout=15)
    assert negative.returncode == 1 and "ANTHROPIC_API_KEY required" in negative.stderr
    tests = run([NPM, "test"], workspace)
    match = re.search(r"(?:#|ℹ) tests (\d+)", tests)
    assert {relative: sha256((workspace / relative).read_bytes()).hexdigest() for relative in files} == files, "Qualification modified bundled source bytes"
report = {"artifact": str(artifact), "version": VERSION, "source_files": len(files), "source_sha256": sha256(artifact.read_bytes()).hexdigest(), "cases": 12, "tests": int(match.group(1)) if match else None, "deterministic_archive": True, "fresh_locked_install": True, "all_case_private_cli": True, "sdk_browser_source_history_cli_and_recovery": True, "live_model": False}
(artifact.parent / "distribution-proof.json").write_text(json.dumps(report, indent=2) + "\n")
Path(str(artifact) + ".sha256").write_text(report["source_sha256"] + "  " + artifact.name + "\n")
print(json.dumps(report))
