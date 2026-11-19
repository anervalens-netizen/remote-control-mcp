#!/usr/bin/env python3
"""Inspect or quarantine one abandoned Linux ingress aggregate writer claim."""

import argparse
from contextlib import ExitStack
import hashlib
import json
import os
import re
import stat
import sys


CLAIM = "aggregate.json.writer"
RECOVERY_LOCK = CLAIM + ".recovery-lock"
LIMIT = 4096
UUID = re.compile(r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}")


def reject_duplicates(pairs):
    value = dict(pairs)
    if len(value) != len(pairs):
        raise ValueError("Duplicate claim fields")
    return value


def identity(metadata):
    return metadata.st_dev, metadata.st_ino


def owned_file(metadata):
    return stat.S_ISREG(metadata.st_mode) and metadata.st_uid == os.geteuid() and not metadata.st_mode & 0o077


def scope_matches(claim):
    with open("/proc/sys/kernel/random/boot_id", encoding="ascii") as stream:
        boot_id = stream.read(128).strip()
    return claim["bootId"] == boot_id and claim["pidNamespace"] == os.readlink("/proc/self/ns/pid")


def disposition(claim):
    if isinstance(claim, dict) and claim.get("version") == 1:
        return "legacy_claim"
    if (not isinstance(claim, dict) or claim.get("version") != 2
            or type(claim.get("pid")) is not int or not 1 <= claim["pid"] < 2**31
            or not all(isinstance(claim.get(key), str) and UUID.fullmatch(claim[key])
                       for key in ("bootId", "instanceId"))
            or not isinstance(claim.get("pidNamespace"), str)
            or not re.fullmatch(r"pid:\[\d+\]", claim["pidNamespace"])):
        return "invalid_claim"
    try:
        if not scope_matches(claim):
            return "different_boot_or_namespace"
    except OSError:
        return "owner_unconfirmed"
    try:
        os.kill(claim["pid"], 0)
    except ProcessLookupError:
        return "recoverable"
    except PermissionError:
        return "owner_unconfirmed"
    except OSError:
        return "owner_unconfirmed"
    return "owner_present"


def recover(directory, expected):
    import fcntl

    with ExitStack() as stack:
        root = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        stack.callback(os.close, root)
        metadata = os.fstat(root)
        if metadata.st_uid != os.geteuid() or metadata.st_mode & 0o077:
            return {"state": "directory_not_private"}
        if expected is not None:
            lock = os.open(RECOVERY_LOCK, os.O_RDONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK,
                           0o600, dir_fd=root)
            stack.callback(os.close, lock)
            if not owned_file(os.fstat(lock)):
                return {"state": "invalid_recovery_lock"}
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return {"state": "recovery_in_progress"}
            if identity(os.stat(RECOVERY_LOCK, dir_fd=root, follow_symlinks=False)) != identity(os.fstat(lock)):
                return {"state": "recovery_lock_changed"}

        try:
            fd = os.open(CLAIM, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=root)
        except FileNotFoundError:
            return {"state": "no_claim"}
        stack.callback(os.close, fd)
        metadata = os.fstat(fd)
        if not owned_file(metadata):
            return {"state": "invalid_claim"}
        with open(fd, "rb", closefd=False) as stream:
            raw = stream.read(LIMIT + 1)
        try:
            if len(raw) > LIMIT:
                raise ValueError("Oversized claim")
            claim = json.loads(raw, object_pairs_hook=reject_duplicates)
        except (ValueError, RecursionError):
            return {"state": "invalid_claim"}
        fingerprint = hashlib.sha256(f"{metadata.st_dev}:{metadata.st_ino}\n".encode() + raw).hexdigest()
        result = {"state": disposition(claim), "fingerprint": fingerprint}
        if expected is None:
            return result
        if expected != fingerprint:
            return {**result, "state": "claim_changed"}
        if result["state"] != "recoverable":
            return result

        # The writer protocol will not create a new claim while this one exists.
        # The flock serializes recoverers until the old path has been removed.
        os.fsync(fd)
        archive = CLAIM + ".recovered-" + fingerprint
        try:
            os.link(CLAIM, archive, src_dir_fd=root, dst_dir_fd=root, follow_symlinks=False)
        except FileExistsError:
            # Resume after a crash between archiving and removing the old name.
            pass
        for name in (archive, CLAIM):
            if identity(os.stat(name, dir_fd=root, follow_symlinks=False)) != identity(metadata):
                return {**result, "state": "claim_changed"}
        os.fsync(root)
        os.unlink(CLAIM, dir_fd=root)
        os.fsync(root)
        return {**result, "state": "recovered", "archive": archive}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", help="Configured agent-ingress-v1 directory")
    parser.add_argument("--apply", metavar="FINGERPRINT", help="Recover exactly the claim reported by inspection")
    args = parser.parse_args()
    if args.apply is not None and not re.fullmatch(r"[0-9a-f]{64}", args.apply):
        parser.error("--apply requires the exact fingerprint from inspection")
    if sys.platform != "linux":
        result = {"state": "unsupported_platform"}
    else:
        try:
            result = recover(args.directory, args.apply)
        except OSError as error:
            result = {"state": "filesystem_error", "errno": error.errno}
    print(json.dumps(result))
    return int(args.apply is not None and result["state"] != "recovered")


if __name__ == "__main__":
    sys.exit(main())
