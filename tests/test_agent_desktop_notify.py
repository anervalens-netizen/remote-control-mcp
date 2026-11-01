import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("notifier", Path(__file__).resolve().parents[1] / "scripts/agent-desktop-release-notify.py")
notifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notifier)


class ReleaseNotifications(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        (root / "token").write_text("123456:synthetic_test_only")
        self.config = root / "config.json"
        self.config.write_text(json.dumps({"stateDirectory": str(root / "state"), "installedVersion": "1.0.2", "telegramTokenFile": str(root / "token"), "telegramChatId": 123456}))
        self.version = "v1.0.2"
        self.sent = []
        self.uncertain = False
        original = notifier.fetch
        self.addCleanup(setattr, notifier, "fetch", original)
        def fetch(url, data=None):
            if data is None:
                return {"tag_name": self.version, "html_url": "https://github.com/vercel-labs/agent-desktop/releases/tag/" + self.version}
            self.sent.append(data)
            if self.uncertain:
                raise RuntimeError("network_or_response_error")
            return {"ok": True, "result": {"message_id": len(self.sent)}}
        notifier.fetch = fetch

    def run_monitor(self, test=False):
        with contextlib.redirect_stdout(io.StringIO()):
            notifier.main(str(self.config), test)

    def test_unchanged_is_quiet_and_setup_is_sent_once(self):
        self.run_monitor()
        self.assertEqual(self.sent, [])
        self.run_monitor(True)
        self.run_monitor(True)
        self.assertEqual(len(self.sent), 1)

    def test_new_release_is_notified_once_without_installing(self):
        self.version = "v1.0.3"
        self.run_monitor()
        self.run_monitor()
        self.assertEqual(len(self.sent), 1)
        self.assertIn("Nu s-a făcut niciun update automat", self.sent[0]["text"])

    def test_uncertain_delivery_is_not_replayed(self):
        self.version = "v1.0.3"
        self.uncertain = True
        with self.assertRaises(RuntimeError):
            self.run_monitor()
        self.uncertain = False
        self.run_monitor()
        self.assertEqual(len(self.sent), 1)

    def test_unexpected_release_url_is_rejected(self):
        with self.assertRaises(ValueError):
            notifier.release_identity({"tag_name": "v1.0.3", "html_url": "https://example.invalid/release"})


if __name__ == "__main__":
    unittest.main()
