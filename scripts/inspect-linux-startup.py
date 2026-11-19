"""Capture local systemd startup and process evidence for private comparison.

The manifest check verifies the selected entry bytes against a local manifest
claim. Use the release verifier for whole-release and upstream comparison.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess

ENTRY = re.compile(r"/apps/(?:agent|mcp-server)/src/index\.ts$")
SHA = re.compile(r"^[0-9a-f]{40}(?:[0-9a-f]{24})?$")
UNIT = re.compile(r"(?:user:)?[A-Za-z0-9_.@-]{1,200}\.service")
MAX_MANIFEST_BYTES = 8 * 1024 * 1024
NODE_EXECUTABLES = {"node", "nodejs"}

def run(args):
    return subprocess.run(args, check=True, capture_output=True, timeout=4).stdout

def read(path, limit):
    flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NONBLOCK | os.O_NOFOLLOW
    with os.fdopen(os.open(path, flags), "rb") as file:
        if not stat.S_ISREG(os.fstat(file.fileno()).st_mode):
            raise ValueError("not_regular")
        value = file.read(limit + 1)
        if len(value) > limit:
            raise ValueError("too_large")
        return value

def entry(argv):
    if argv and argv[0] == "/usr/bin/env":
        argv = argv[1:]
        while argv and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", argv[0]):
            argv = argv[1:]
    if len(argv) != 2 or Path(argv[0]).name not in NODE_EXECUTABLES:
        return None
    return Path(argv[1]) if argv[1].startswith("/") and ENTRY.search(argv[1]) else None

def active_entry(executable, argv):
    if not executable.is_absolute() or executable.name not in NODE_EXECUTABLES or not argv:
        return None
    first = Path(argv[0])
    if first.is_absolute():
        if first.resolve(strict=True) != executable:
            return None
    elif argv[0] != executable.name:
        return None
    return entry(argv)

def manifest(target):
    if not target:
        return {"state": "unknown_entry"}
    try:
        folder = target.parents[3].resolve(strict=True)
        relative = target.relative_to(target.parents[3]).as_posix()
        target = folder / relative
        if target.resolve(strict=True) != target:
            return {"state": "symlinked_entry"}
        raw = read(folder / ".rcmcp-release.json", MAX_MANIFEST_BYTES)
        spec = json.loads(raw)
        commit = spec["source"]["commit"]
        listed = [row for row in spec["files"] if row["path"] == relative and row["kind"] == "tracked_source"]
        if spec["version"] != 1 or not SHA.fullmatch(commit) or len(listed) != 1:
            return {"state": "invalid_manifest"}
        data = read(target, 512 * 1024)
        if len(data) != listed[0]["bytes"] or hashlib.sha256(data).hexdigest() != listed[0]["sha256"]:
            return {"state": "entry_digest_mismatch"}
        return {"state": "entry_digest_matches_manifest_claim", "manifestCommit": commit,
                "manifestSha256": hashlib.sha256(raw).hexdigest()}
    except FileNotFoundError:
        return {"state": "manifest_or_entry_missing"}
    except (KeyError, ValueError, TypeError, OSError):
        return {"state": "manifest_unavailable_or_invalid"}

def observe(unit, user):
    manager = ["--user"] if user else []
    try:
        path = json.loads(run(["busctl", *manager, "--json=short", "call", "org.freedesktop.systemd1",
                 "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager", "GetUnit", "s", unit]))["data"][0]
        unit_props = ["busctl", *manager, "--json=short", "get-property", "org.freedesktop.systemd1", path,
                      "org.freedesktop.systemd1.Service"]
        config = json.loads(run([*unit_props, "ExecStart"]))["data"]
        target = None
        if len(config) == 1:
            executable, argv, *_ = config[0]
            # Systemd's @ prefix can set argv[0] independently of the executable.
            if argv and executable == argv[0]:
                target = entry(argv)
        pid = json.loads(run([*unit_props, "MainPID"]))["data"]
        started = json.loads(run([*unit_props, "ExecMainStartTimestampMonotonic"]))["data"]
        target_proof = manifest(target)
        running = None
        if pid:
            try:
                proc = Path(f"/proc/{pid}")
                active_executable = proc.joinpath("exe").readlink()
                cmdline = read(proc / "cmdline", 64 * 1024).decode().removesuffix("\0")
                running = active_entry(active_executable, cmdline.split("\0"))
            except (OSError, ValueError):
                pass
        running_proof = target_proof if target == running else manifest(running)
        if (json.loads(run([*unit_props, "ExecStart"]))["data"] != config
                or json.loads(run([*unit_props, "MainPID"]))["data"] != pid
                or json.loads(run([*unit_props, "ExecMainStartTimestampMonotonic"]))["data"] != started):
            return {"unit": unit, "state": "changed_during_inspection"}
        return {"unit": unit, "scope": "user" if user else "system", "pid": pid,
                "activeEntry": str(running) if running else None, "startupEntry": str(target) if target else None,
                "startupEntryMatchesActive": target == running if running and target else None,
                "startupClaim": target_proof, "runningEntryManifestClaim": running_proof}
    except (OSError, subprocess.SubprocessError, KeyError, IndexError, TypeError, ValueError):
        return {"unit": unit, "state": "service_manager_unavailable"}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("unit", nargs="+", help="Loaded .service unit, prefixed with user: for the user manager")
    args = parser.parse_args()
    if len(args.unit) > 8 or not all(UNIT.fullmatch(unit) for unit in args.unit):
        parser.error("specify at most eight supported service names")
    print(json.dumps({
        "observedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "units": [observe(unit.removeprefix("user:"), unit.startswith("user:")) for unit in args.unit],
    }))


if __name__ == "__main__":
    main()
