"""Deliver an owner-local desktop notification without an AI or external recipient."""
import base64
import os
import sys
from gi.repository import Gio, GLib

message = base64.b64decode(sys.argv[1], validate=True).decode("utf-8")
address = f"unix:path=/run/user/{os.getuid()}/bus"
bus = Gio.DBusConnection.new_for_address_sync(
    address,
    Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
    None,
    None,
)
result = bus.call_sync(
    "org.freedesktop.Notifications", "/org/freedesktop/Notifications",
    "org.freedesktop.Notifications", "Notify",
    GLib.Variant("(susssasa{sv}i)", (
        "Remote Control MCP", 0, "system-software-update", "Agent Desktop", message,
        [], {"urgency": GLib.Variant("y", 1)}, 15000,
    )), None, Gio.DBusCallFlags.NONE, 5000, None,
)
print(result.unpack()[0])
