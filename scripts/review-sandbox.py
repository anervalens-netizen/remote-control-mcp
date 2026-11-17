#!/usr/bin/env python3
"""Linux review source-probe runner: a separate PID/network/filesystem namespace.

The pinned production policy is root-owned and contains no credentials. This
isolates review *probes*, not the DSH model session or its other tools.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
from typing import Any

POLICY = Path("/etc/remote-control-mcp/inv05-review-sandbox.json")
BWRAP = "/usr/bin/bwrap"
MAX_ARGS = 64
MAX_ARG_BYTES = 4096


class SandboxError(Exception):
    pass


# Every ancestor is opened relative to a pinned directory descriptor. O_NOFOLLOW
# on the final component alone is insufficient when a writable parent can be
# substituted after path validation.
_DIR_FLAGS = os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW


def _pinned_absolute_dir(raw: str) -> int:
    if not isinstance(raw, str) or not raw.startswith("/") or "\0" in raw:
        raise SandboxError("invalid_directory")
    path = Path(raw)
    if ".." in path.parts:
        raise SandboxError("nonphysical_directory")
    fd = os.open("/", _DIR_FLAGS)
    try:
        for component in path.parts[1:]:
            next_fd = os.open(component, _DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        if not stat.S_ISDIR(os.fstat(fd).st_mode):
            raise SandboxError("not_directory")
        return fd
    except Exception as error:
        os.close(fd)
        if isinstance(error, SandboxError):
            raise
        raise SandboxError("nonphysical_directory") from None


def _absolute_directory(raw: str) -> Path:
    fd = _pinned_absolute_dir(raw)
    os.close(fd)
    return Path(raw)


def _policy_from_file(path: Path = POLICY) -> dict[str, Any]:
    if path.is_symlink():
        raise SandboxError("policy_symlink")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or (st.st_mode & 0o022) or st.st_size > 4096:
            raise SandboxError("untrusted_policy_file")
        data = os.read(fd, 4097)
        if len(data) > 4096:
            raise SandboxError("oversized_policy_file")
    finally:
        os.close(fd)
    try:
        policy = json.loads(data)
    except (ValueError, UnicodeDecodeError):
        raise SandboxError("invalid_policy_json") from None
    return validate_policy(policy)


def validate_policy(policy: Any) -> dict[str, Any]:
    fields = {"workspaceRoot", "workspaceRootDev", "workspaceRootIno", "runtimeDirs", "timeoutSeconds"}
    if not isinstance(policy, dict) or set(policy) != fields:
        raise SandboxError("invalid_policy_shape")
    root = _absolute_directory(policy["workspaceRoot"])
    if len(root.parts) < 3 or root == Path.home() or root in (
        Path("/"), Path("/home"), Path("/root"), Path("/etc"),
        Path("/usr"), Path("/var"), Path("/run"),
    ):
        raise SandboxError("workspace_root_too_broad")
    dev, ino = policy["workspaceRootDev"], policy["workspaceRootIno"]
    if type(dev) is not int or type(ino) is not int or dev < 1 or ino < 1:
        raise SandboxError("invalid_root_identity")
    fd = _pinned_absolute_dir(str(root))
    try:
        st = os.fstat(fd)
        if (st.st_dev, st.st_ino) != (dev, ino):
            raise SandboxError("trusted_root_identity_mismatch")
    finally:
        os.close(fd)
    runtimes = policy["runtimeDirs"]
    if not isinstance(runtimes, list) or len(runtimes) > 3 or len(set(map(str, runtimes))) != len(runtimes):
        raise SandboxError("invalid_runtime_roots")
    for entry in runtimes:
        dirname = _absolute_directory(entry)
        if not dirname.is_relative_to(Path("/opt/runtimes")):
            raise SandboxError("runtime_root_not_permitted")
    seconds = policy["timeoutSeconds"]
    if isinstance(seconds, bool) or not isinstance(seconds, int) or not 1 <= seconds <= 900:
        raise SandboxError("invalid_timeout")
    return {"workspaceRoot": str(root), "workspaceRootDev": dev, "workspaceRootIno": ino,
            "runtimeDirs": list(runtimes), "timeoutSeconds": seconds}


def _workspace(root: Path, path: str) -> Path:
    if not isinstance(path, str) or not path.startswith("/") or "\0" in path or ".." in Path(path).parts:
        raise SandboxError("invalid_workspace")
    dest = Path(path)
    if dest == root or not dest.is_relative_to(root):
        raise SandboxError("workspace_outside_trusted_root")
    return dest


def open_review_workspace(policy: dict[str, Any], workspace: str) -> int:
    validated = validate_policy(policy)
    root = Path(validated["workspaceRoot"])
    dest = _workspace(root, workspace)
    fd = _pinned_absolute_dir(str(root))
    try:
        st = os.fstat(fd)
        if (st.st_dev, st.st_ino) != (validated["workspaceRootDev"], validated["workspaceRootIno"]):
            raise SandboxError("trusted_root_identity_mismatch")
        for component in dest.relative_to(root).parts:
            next_fd = os.open(component, _DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        if os.fstat(fd).st_uid != os.getuid():
            raise SandboxError("workspace_owner_mismatch")
        return fd
    except Exception as error:
        os.close(fd)
        if isinstance(error, SandboxError):
            raise
        raise SandboxError("nonphysical_workspace") from None


def build_command(policy: dict[str, Any], workspace: str, requested: list[str], workspace_fd: int | None = None) -> list[str]:
    validated = validate_policy(policy)
    _workspace(Path(validated["workspaceRoot"]), workspace)
    if not 1 <= len(requested) <= MAX_ARGS or any(
        not isinstance(a, str) or not a or "\0" in a or len(os.fsencode(a)) > MAX_ARG_BYTES for a in requested
    ):
        raise SandboxError("invalid_arguments")
    if workspace_fd is None or type(workspace_fd) is not int or workspace_fd < 3:
        raise SandboxError("pinned_fd_required")
    try:
        st = os.fstat(workspace_fd)
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid():
            raise SandboxError("invalid_pinned_workspace")
    except OSError:
        raise SandboxError("invalid_pinned_workspace") from None
    # The FD is an immutable inode reference opened by open_review_workspace.
    # Do not resolve a mutable pathname as the source mount.
    cmd = [BWRAP, "--unshare-user", "--unshare-pid", "--unshare-net", "--unshare-ipc",
           "--unshare-uts", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
           "--clearenv"]
    for directory in ("/usr", "/bin", "/lib", "/lib64"):
        if Path(directory).exists():
            cmd.extend(["--ro-bind", directory, directory])
    cmd.extend(["--dir", "/etc"])
    for filename in ("/etc/passwd", "/etc/group", "/etc/nsswitch.conf", "/etc/hosts"):
        if Path(filename).is_file():
            cmd.extend(["--ro-bind", filename, filename])
    if Path("/etc/ssl/certs").is_dir():
        cmd.extend(["--dir", "/etc/ssl", "--ro-bind", "/etc/ssl/certs", "/etc/ssl/certs"])
    for runtime in validated["runtimeDirs"]:
        relative = Path(runtime).relative_to("/")
        parent = Path("/")
        for segment in relative.parts[:-1]:
            parent = parent / segment
            cmd.extend(["--dir", str(parent)])
        cmd.extend(["--ro-bind", runtime, runtime])
    cmd.extend([
        "--tmpfs", "/tmp", "--proc", "/proc", "--dev", "/dev",
        "--dir", "/home", "--dir", "/work", "--bind", f"/proc/self/fd/{workspace_fd}", "/work",
        "--setenv", "HOME", "/tmp", "--setenv", "TMPDIR", "/tmp",
        "--setenv", "XDG_CACHE_HOME", "/tmp/cache", "--setenv", "XDG_CONFIG_HOME", "/tmp/config",
        "--setenv", "RCMCP_STATE_DIR", "/tmp/rcmcp-tests", "--setenv", "CI", "true",
        "--setenv", "PATH", ":".join(
            [str(Path(runtime) / "bin") for runtime in validated["runtimeDirs"]] + ["/usr/local/bin", "/usr/bin", "/bin"]
        ),
        "--chdir", "/work", "--",
        *requested,
    ])
    return cmd


def run_probe(policy: dict[str, Any], workspace: str, requested: list[str]) -> int:
    fd = open_review_workspace(policy, workspace)
    try:
        command = build_command(policy, workspace, requested, workspace_fd=fd)
        if not Path(BWRAP).is_file():
            raise SandboxError("bwrap_missing")
        process = subprocess.Popen(command, start_new_session=True, pass_fds=(fd,))
    finally:
        os.close(fd)
    # Its process group is owned by this launcher only; timeout never signals
    # an unrelated service or searches for a process by an untrusted PID.
    try:
        return process.wait(timeout=policy["timeoutSeconds"])
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()
        return 124


def main() -> int:
    if os.geteuid() == 0:
        raise SandboxError("owner_only")
    args = sys.argv[1:]
    if len(args) < 4 or args[0] != "--workspace" or args[2] != "--":
        raise SandboxError("usage_workspace_then_command")
    return run_probe(_policy_from_file(), args[1], args[3:])


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (SandboxError, OSError) as exc:
        code = str(exc) if isinstance(exc, SandboxError) else "runtime_unavailable"
        print("review_sandbox: " + code, file=sys.stderr)
        raise SystemExit(125)
