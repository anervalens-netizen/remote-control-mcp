import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

path = Path(__file__).resolve().parents[1] / 'scripts/inspect-linux-startup.py'
spec = importlib.util.spec_from_file_location('startup', path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class StartupEvidenceTests(unittest.TestCase):
    def test_stale_loaded_entry_with_current_running_process(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            old = self.release(root / 'old', 'a' * 40)
            active = self.release(root / 'chosen', 'b' * 40)

            def dbus(args):
                values = {
                    'example.service': ['/org/freedesktop/systemd1/unit/example_2eservice'],
                    'ExecStart': [['/usr/bin/node', ['/usr/bin/node', str(old)]]],
                    'MainPID': 123,
                    'ExecMainStartTimestampMonotonic': 456,
                }
                return json.dumps({'data': values[args[-1]]}).encode()

            def file(path, size):
                if str(path) == '/proc/123/cmdline':
                    return f'/usr/bin/node\0{active}\0'.encode()
                return real_read(path, size)

            real_read = module.read
            with patch.object(module, 'run', dbus), patch.object(module, 'read', file):
                observed = module.observe('example.service', False)
            self.assertEqual(observed['startupEntryMatchesActive'], False)
            self.assertEqual(observed['startupClaim']['manifestCommit'], 'a' * 40)
            self.assertEqual(observed['runningEntryManifestClaim']['manifestCommit'], 'b' * 40)

    def test_missing_manifest_never_derives_identity_from_release_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / ('a' * 40) / 'apps/agent/src/index.ts'
            target.parent.mkdir(parents=True)
            target.write_text('export {};')
            self.assertEqual(module.manifest(target), {'state': 'manifest_or_entry_missing'})

    def test_modified_entry_does_not_qualify_as_installed_proof(self):
        with tempfile.TemporaryDirectory() as directory:
            target = self.release(Path(directory), 'a' * 40)
            target.write_text('export { fake };')
            self.assertEqual(module.manifest(target), {'state': 'entry_digest_mismatch'})

    def test_shell_wrapper_is_unknown(self):
        self.assertIsNone(module.entry(['/bin/sh', '/path/start.sh', '/path/apps/agent/src/index.ts']))

    @staticmethod
    def release(root, sha):
        target = root / 'apps/agent/src/index.ts'
        target.parent.mkdir(parents=True)
        data = b'export {};'
        target.write_bytes(data)
        spec = {'version':1, 'source':{'commit':sha}, 'files':[{
            'path':'apps/agent/src/index.ts', 'kind':'tracked_source',
            'bytes':len(data), 'sha256':hashlib.sha256(data).hexdigest(),
        }]}
        (root / '.rcmcp-release.json').write_text(json.dumps(spec))
        return target

if __name__ == '__main__':
    unittest.main()
