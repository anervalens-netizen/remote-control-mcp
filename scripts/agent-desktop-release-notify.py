"""Notify the configured owner about stable releases; never install software."""
import argparse
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import urllib.error
import urllib.request


def release_identity(release):
    tag = release.get("tag_name", "")
    if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", tag) or release.get("draft") or release.get("prerelease"):
        raise ValueError("invalid_stable_release")
    url = "https://github.com/vercel-labs/agent-desktop/releases/tag/" + tag
    if release.get("html_url") != url:
        raise ValueError("unexpected_release_url")
    return tag, url


def save(file, state):
    temp = file.with_suffix(".tmp")
    with temp.open("w") as out:
        json.dump(state, out)
        out.flush()
        os.fsync(out.fileno())
    temp.replace(file)


def fetch(url, data=None):
    request = urllib.request.Request(url, data=json.dumps(data).encode() if data is not None else None,
        headers={"User-Agent": "remote-control-mcp-release-notifier", "Content-Type": "application/json"})
    # Never include exception text: a Telegram URL contains the bot token.
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError("http_" + str(error.code)) from None
    except Exception:
        raise RuntimeError("network_or_response_error") from None


def main(config_file, test=False):
    os.umask(0o077)
    config = json.loads(Path(config_file).read_text())
    root = Path(config["stateDirectory"])
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (root / "lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        file = root / "notifications.json"
        state = json.loads(file.read_text()) if file.exists() else {"events": {}, "baseline": None}

        def notify(key, message):
            if key in state["events"]:
                return
            # Reserve before delivery. A timeout must not blindly duplicate a message.
            state["events"][key] = {"status": "delivery_uncertain"}
            save(file, state)
            token = Path(config["telegramTokenFile"]).read_text().strip()
            if not re.fullmatch(r"[0-9]+:[A-Za-z0-9_-]+", token):
                raise RuntimeError("invalid_bot_configuration")
            result = fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
                "chat_id": config["telegramChatId"], "text": message, "disable_web_page_preview": True,
            })
            if result.get("ok") is not True:
                raise RuntimeError("telegram_delivery_rejected")
            state["events"][key] = {"status": "delivered", "messageId": result["result"]["message_id"]}
            save(file, state)

        try:
            tag, url = release_identity(fetch("https://api.github.com/repos/vercel-labs/agent-desktop/releases/latest"))
        except Exception as error:
            state["lastCheckError"] = type(error).__name__
            save(file, state)
            notify("check-failed", "Agent Desktop: verificarea versiunilor a eșuat. Instalarea existentă nu a fost modificată; este necesară verificarea monitorului.")
            raise RuntimeError("release_check_failed") from None
        state["checkedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        state["latestRelease"] = tag
        state["lastCheckError"] = None
        # A later independent incident can generate a new failure notification.
        if "check-failed" in state["events"] and state["events"]["check-failed"]["status"] == "delivered":
            del state["events"]["check-failed"]
        baseline = "v" + config["installedVersion"].removeprefix("v")
        if state["baseline"] is None:
            state["baseline"] = baseline
        save(file, state)
        if tag != baseline:
            notify("release:" + tag, "Agent Desktop: a apărut " + tag + ".\nVersiunea instalată raportată: " + baseline + ".\n" + url + "\nSpune-mi «actualizează agent-desktop» când dorești instalarea. Nu s-a făcut niciun update automat.")
        if test:
            notify("setup", "Agent Desktop: monitorizarea este activă pe server, fără AI și fără consum de tokenuri. Verific release-urile la fiecare 6 ore și anunț aici versiunile noi. Update-ul se face doar când îmi spui. Versiune curentă: " + baseline + ".")
        result = {"ok": True, "release": tag, "mode": "notify_only", "events": state["events"]}
        print(json.dumps(result))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("config")
    parser.add_argument("--test", action="store_true")
    args = parser.parse_args()
    try:
        main(args.config, args.test)
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error) if isinstance(error, RuntimeError) else type(error).__name__}))
        raise SystemExit(1)
