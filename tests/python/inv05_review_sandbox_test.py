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
        self.policy = {"workspaceRoot": str(self.root), "runtimeDirs": [], "timeoutSeconds": 6}

    def assertRejected(self, *args):
        with self.assertRaises(sandbox.SandboxError):
            sandbox.build_command(*args)

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
        args = sandbox.build_command(
            {**self.policy, "workspaceRoot": str(shallow)},
            str(self.root), ["/usr/bin/true"],
        )
        self.assertIn(str(self.root), args)
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
        if not Path(sandbox.BWRAP).is_file():
            self.skipTest("bubblewrap not installed")
        cmd = sandbox.build_command(self.policy, str(self.workspace),
                                    ["/usr/bin/python3", "-c", "print('synthetic')"])
        self.assertIn("--clearenv", cmd)
        for flag in ("--unshare-pid", "--unshare-net", "--unshare-user",
                     "--die-with-parent", "--new-session", "--bind", "--proc"):
            self.assertIn(flag, cmd)
        self.assertNotIn("/root", cmd)
        self.assertNotIn("/run/systemd", cmd)
        self.assertNotIn(str(Path.home()), cmd)
        self.assertEqual(cmd[-3:], ["/usr/bin/python3", "-c", "print('synthetic')"])
        # There is no user-defined shell command allowlist. All commands go
        # through the same isolated subprocess boundary.

    def test_launch_pins_approved_workspace_inode_by_inherited_fd(self):
        with mock.patch.object(sandbox.subprocess, "Popen") as start:
            start.return_value.wait.return_value = 0
            self.assertEqual(sandbox.run_probe(self.policy, str(self.workspace),
                                               ["/usr/bin/true"]), 0)
            arguments, kwargs = start.call_args
            cmd = arguments[0]
            pinned = next(cmd[i + 1] for i in range(len(cmd) - 1)
                          if cmd[i] == "--bind" and cmd[i + 2] == "/work")
            self.assertRegex(pinned, r"^/proc/self/fd/[0-9]+$")
            self.assertEqual(kwargs["pass_fds"], (int(pinned.rsplit("/", 1)[-1]),))
            self.assertTrue(kwargs["start_new_session"])

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
        os.environ["INV05_TEST_SECRET"] = "fake-synthetic-secret"
        try:
            result = subprocess.run(sandbox.build_command(
                self.policy, str(self.workspace), ["/usr/bin/python3", "-c", code]),
                capture_output=True, text=True, timeout=7)
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
