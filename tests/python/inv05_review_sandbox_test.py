#!/usr/bin/env python3
"""Synthetic INV-05 isolation regression; never uses installed state."""
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

SOURCE = Path(__file__).resolve().parents[2] / "scripts" / "review-sandbox.py"
spec = importlib.util.spec_from_file_location("review_sandbox", SOURCE)
assert spec and spec.loader
sandbox = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sandbox)


class TestReviewSandbox(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="rcmcp-inv05-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "trusted-worktrees"
        self.workspace = self.root / "review-ticket"
        self.workspace.mkdir(parents=True)
        st = self.root.stat()
        self.policy = {"workspaceRoot": str(self.root), "workspaceRootDev": st.st_dev,
                       "workspaceRootIno": st.st_ino, "runtimeDirs": [], "timeoutSeconds": 6}

    def build(self, policy, workspace, requested):
        fd = sandbox.open_review_workspace(policy, workspace)
        try:
            return sandbox.build_command(policy, workspace, requested, workspace_fd=fd)
        finally:
            os.close(fd)

    def assertRejected(self, *args):
        with self.assertRaises(sandbox.SandboxError):
            self.build(*args)

    def test_rejects_workspace_escape_and_symlink(self):
        outsider = Path(self.temp.name) / "installed-service"
        outsider.mkdir()
        self.assertRejected(self.policy, str(outsider), ["/usr/bin/true"])
        self.assertRejected(self.policy, str(self.root), ["/usr/bin/true"])
        (self.root / "redirect").symlink_to(outsider, target_is_directory=True)
        self.assertRejected(self.policy, str(self.root / "redirect"), ["/usr/bin/true"])

    def test_documented_two_segment_review_root_is_supported(self):
        # /srv/review-worktrees has two components after /, like the parent
        # directory of this temporary checkout.
        shallow = Path(self.temp.name)
        st = shallow.stat()
        args = self.build(
            {**self.policy, "workspaceRoot": str(shallow),
             "workspaceRootDev": st.st_dev, "workspaceRootIno": st.st_ino},
            str(self.root), ["/usr/bin/true"],
        )
        self.assertIn("--bind-fd", args)
        self.assertRejected({**self.policy, "workspaceRoot": str(Path.home())},
                            str(self.workspace), ["/usr/bin/true"])

    def test_invalid_policy_or_command_never_dispatches(self):
        for change in (
            {"runtimeDirs": ["/home"]}, {"timeoutSeconds": 901},
            {"timeoutSeconds": True}, {"runtimeDirs": ["/var/lib"]},
            {"workspaceRoot": "/"},
        ):
            with self.subTest(change=change):
                self.assertRejected({**self.policy, **change}, str(self.workspace), ["/usr/bin/true"])
        for command in ([], ["hello\0world"], ["x" * 5000], ["x"] * 65):
            with self.subTest(command=str(command)[:20]):
                self.assertRejected(self.policy, str(self.workspace), command)

    def test_arguments_enforce_sanitization_without_command_allowlist(self):
        cmd = self.build(self.policy, str(self.workspace),
                         ["/usr/bin/python3", "-c", "print('synthetic')"])
        self.assertIn("--clearenv", cmd)
        for flag in ("--unshare-pid", "--unshare-net", "--unshare-user",
                     "--die-with-parent", "--new-session", "--bind-fd", "--proc"):
            self.assertIn(flag, cmd)
        self.assertNotIn("/root", cmd)
        self.assertNotIn("/run/systemd", cmd)
        self.assertNotIn(str(Path.home()), cmd)
        self.assertEqual(cmd[-3:], ["/usr/bin/python3", "-c", "print('synthetic')"])
        # There is no user-defined shell command allowlist. All commands go
        # through the same isolated subprocess boundary.

    def test_launch_pins_approved_workspace_inode_by_inherited_fd(self):
        # This is a pure descriptor/admission test, not a native-bwrap test.
        with mock.patch.object(sandbox, "BWRAP", "/usr/bin/true"), \
             mock.patch.object(sandbox.subprocess, "Popen") as start:
            start.return_value.wait.return_value = 0
            self.assertEqual(sandbox.run_probe(self.policy, str(self.workspace),
                                               ["/usr/bin/true"]), 0)
            arguments, kwargs = start.call_args
            cmd = arguments[0]
            pinned = next(cmd[i + 1] for i in range(len(cmd) - 1)
                          if cmd[i] == "--bind-fd" and cmd[i + 2] == "/work")
            self.assertRegex(pinned, r"^[0-9]+$")
            self.assertEqual(kwargs["pass_fds"], (int(pinned),))
            self.assertTrue(kwargs["start_new_session"])

    def test_symlinked_checkout_ancestor_is_rejected_even_if_it_is_user_owned(self):
        parent = self.root / "swappable-parent"
        child = parent / "ticket"
        child.mkdir(parents=True)
        outside = Path(self.temp.name) / "outside-protected"
        (outside / "ticket").mkdir(parents=True)
        # First validation sees a valid path; immediately before open, a
        # different worker replaces the parent with a link to its own tree.
        sandbox._workspace(self.root, str(child))
        parent.rename(self.root / "original-parent")
        parent.symlink_to(outside, target_is_directory=True)
        try:
            self.assertRejected(self.policy, str(child), ["/usr/bin/true"])
        finally:
            parent.unlink()
            (self.root / "original-parent").rename(parent)

    def test_trusted_root_identity_prevents_directory_replacement(self):
        moved = Path(self.temp.name) / "original-root"
        self.root.rename(moved)
        self.root.mkdir()
        try:
            self.assertRejected(self.policy, str(self.workspace), ["/usr/bin/true"])
        finally:
            self.root.rmdir()
            moved.rename(self.root)

    def test_validation_and_fd_unit_tests_work_without_bubblewrap(self):
        with mock.patch.object(sandbox, "BWRAP", "/invalid/no-bwrap-here"):
            self.assertIn("--bind-fd", self.build(
                self.policy, str(self.workspace), ["/usr/bin/true"]))
            with self.assertRaisesRegex(sandbox.SandboxError, "bwrap_missing"):
                sandbox.run_probe(self.policy, str(self.workspace), ["/usr/bin/true"])

    def test_optional_runtime_requires_a_consumed_pinned_fd(self):
        pseudo = {**self.policy, "runtimeDirs": ["/opt/runtimes/private-synthetic"]}
        workspace_fd = sandbox.open_review_workspace(self.policy, str(self.workspace))
        try:
            with mock.patch.object(sandbox, "validate_policy", return_value=pseudo):
                with self.assertRaisesRegex(sandbox.SandboxError, "runtime_fd_required"):
                    sandbox.build_command(pseudo, str(self.workspace), ["/usr/bin/true"],
                                          workspace_fd=workspace_fd)
        finally:
            os.close(workspace_fd)

    def sandbox_available(self):
        if sys.platform != "linux" or not Path(sandbox.BWRAP).is_file():
            return False
        result = subprocess.run(
            [sandbox.BWRAP, "--unshare-user", "--unshare-pid", "--unshare-net",
             "--ro-bind", "/usr", "/usr", "--ro-bind", "/bin", "/bin",
             "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64",
             "--proc", "/proc", "--dev", "/dev", "/usr/bin/true"],
            capture_output=True, timeout=3)
        return result.returncode == 0

    def test_real_pid_network_state_and_environment_isolation(self):
        if not self.sandbox_available():
            self.skipTest("user/PID/network namespaces unavailable on this runner")
        parent_pid = os.getpid()
        code = """
import os, pathlib, socket, subprocess, tempfile
assert os.environ.get('INV05_TEST_SECRET') is None
assert os.environ.get('HOME') == '/tmp'
assert not pathlib.Path('/proc/' + str(int(os.environ.get('HOST_PID', '0')))).exists()
assert not pathlib.Path('/proc/' + str(""" + str(parent_pid) + """)).exists()
for path in ('__OPERATOR_PRIVATE__', '/root/.remote-control-mcp', '/run/systemd/private', '/var/run/docker.sock'):
    assert not pathlib.Path(path).exists(), path
try:
    os.kill(""" + str(parent_pid) + """, 0)
    raise AssertionError('host PID visible')
except ProcessLookupError: pass
source = pathlib.Path('/work/fixture.py')
source.write_text('assert 6 * 7 == 42\\n')
exec(compile(source.read_text(), str(source), 'exec'))
source.unlink()
with tempfile.TemporaryFile() as f: f.write(b'safe')
sock=socket.socket();sock.bind(('127.0.0.1',0));sock.listen(1)
peer=socket.create_connection(('127.0.0.1',sock.getsockname()[1]),1);peer.close();sock.close()
print('isolated-test-PASS')
"""
        code = code.replace("'__OPERATOR_PRIVATE__'", repr(str(Path.home() / ".dsh")))
        inode = self.workspace.stat()
        # The old /proc/self/fd/N bind exposed the open host workspace FD to
        # the probe. --bind-fd must consume it before executing COMMAND.
        fd_probe = """
import stat
for candidate_fd in range(3, 256):
    try:
        entry = os.fstat(candidate_fd)
    except OSError:
        continue
    assert not (stat.S_ISDIR(entry.st_mode) and
                (entry.st_dev, entry.st_ino) == (%d, %d)), 'host descriptor leaked'
""" % (inode.st_dev, inode.st_ino)
        code = code.replace("print('isolated-test-PASS')", fd_probe + "\nprint('isolated-test-PASS')")
        os.environ["INV05_TEST_SECRET"] = "fake-synthetic-secret"
        try:
            fd = sandbox.open_review_workspace(self.policy, str(self.workspace))
            try:
                result = subprocess.run(sandbox.build_command(
                    self.policy, str(self.workspace), ["/usr/bin/python3", "-c", code],
                    workspace_fd=fd), pass_fds=(fd,),
                    capture_output=True, text=True, timeout=7)
            finally:
                os.close(fd)
        finally:
            os.environ.pop("INV05_TEST_SECRET", None)
        self.assertEqual(result.returncode, 0, result.stderr[:700])
        self.assertIn("isolated-test-PASS", result.stdout)
        self.assertEqual(list(self.workspace.iterdir()), [])

    def test_bounded_timeout_stops_synthetic_worker(self):
        if not self.sandbox_available():
            self.skipTest("user/PID/network namespaces unavailable on this runner")
        policy = {**self.policy, "timeoutSeconds": 1}
        code = ("import pathlib,time\n"
                "p=pathlib.Path('/work/heartbeat')\n"
                "while True:\n p.write_text(str(time.time_ns()))\n time.sleep(0.04)\n")
        result = sandbox.run_probe(policy, str(self.workspace), ["/usr/bin/python3", "-c", code])
        self.assertEqual(result, 124)
        marker = self.workspace / "heartbeat"
        self.assertTrue(marker.is_file())
        prior = marker.read_bytes()
        time.sleep(.35)
        self.assertEqual(marker.read_bytes(), prior, "worker escaped namespace timeout")


if __name__ == "__main__":
    unittest.main(verbosity=2)
