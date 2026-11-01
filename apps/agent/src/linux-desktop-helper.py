"""Owner-session KDE integration. Private D-Bus replies; no UI data in journals."""
import ctypes as C
import ctypes.util
import json
import os
from pathlib import Path
import select
import sys
import tempfile
import time
import uuid
from gi.repository import Gio, GLib


def kwin(request):
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    owner = bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'GetNameOwner', GLib.Variant('(s)', ('org.kde.KWin',)), None, 0, 3000, None).unpack()[0]
    name = 'rcmcp_' + uuid.uuid4().hex
    loop = GLib.MainLoop()
    result = []
    xml = '<node><interface name="org.rcmcp.DesktopReply"><method name="Reply"><arg type="s" direction="in"/></method></interface></node>'
    def reply(connection, sender, object_path, interface, method, parameters, invocation):
        if sender != owner:
            invocation.return_dbus_error('org.rcmcp.UntrustedSender', 'Unexpected sender')
            return
        result.append(json.loads(parameters.unpack()[0]))
        invocation.return_value(GLib.Variant('()', ()))
        loop.quit()
    registration = bus.register_object('/reply', Gio.DBusNodeInfo.new_for_xml(xml).interfaces[0], reply, None, None)
    def call(method, args):
        return bus.call_sync('org.kde.KWin', '/Scripting', 'org.kde.kwin.Scripting', method, args, None, 0, 3000, None).unpack()
    # Only fixed operations; titles and selectors are JSON data, never executable code.
    script = '''var req = REQ;
var windows = workspace.windowList().filter(function(w) { return w.normalWindow || w.dialog; });
function view(w) { var g=w.frameGeometry; return {handle:String(w.internalId),pid:w.pid,title:w.caption,active:w.active,hidden:w.minimized,bounds:{x:g.x,y:g.y,width:g.width,height:g.height}}; }
var answer;
if(req.operation === 'windows') answer=windows.map(view);
else if(req.operation === 'position') answer={x:workspace.cursorPos.x,y:workspace.cursorPos.y};
else if(req.operation === 'focus') {
 var matches=windows.filter(function(w){return (req.handle===undefined || String(w.internalId)===String(req.handle)) && (req.pid===undefined || w.pid===req.pid) && (req.title===undefined || w.caption.indexOf(req.title)>=0);});
 if(matches.length!==1) answer={ok:false,error:'window_selector_not_unique'};
 else { matches[0].minimized=false; workspace.activeWindow=matches[0]; answer={ok:workspace.activeWindow===matches[0],handle:String(matches[0].internalId),foregroundHandle:workspace.activeWindow?String(workspace.activeWindow.internalId):''}; }
} else answer={ok:false,error:'unsupported_kwin_operation'};
callDBus(DEST, '/reply', 'org.rcmcp.DesktopReply', 'Reply', JSON.stringify(answer));
'''.replace('DEST', json.dumps(bus.get_unique_name())).replace('REQ', json.dumps(request))
    loaded = False
    timer = None
    with tempfile.TemporaryDirectory(prefix='rcmcp-kwin-') as directory:
        file = Path(directory) / 'operation.js'
        file.write_text(script)
        try:
            script_id = call('loadScript', GLib.Variant('(ss)', (str(file), name)))[0]
            if script_id < 0:
                raise RuntimeError('kwin_script_load_failed')
            loaded = True
            # Run only this script, never start other pending scripts.
            bus.call_sync('org.kde.KWin', '/Scripting/Script' + str(script_id), 'org.kde.kwin.Script', 'run', None, None, 0, 3000, None)
            timer = GLib.timeout_add(4000, lambda: (loop.quit(), False)[1])
            loop.run()
            if not result:
                raise RuntimeError('kwin_reply_timeout')
            return result[0]
        finally:
            if timer:
                GLib.source_remove(timer)
            if loaded:
                call('unloadScript', GLib.Variant('(s)', (name,)))
            bus.unregister_object(registration)


def eis(request):
    """Use KWin's owner-session EIS connection, without root or uinput permissions."""
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    reply, fds = bus.call_with_unix_fd_list_sync('org.kde.KWin', '/org/kde/KWin/EIS/RemoteDesktop', 'org.kde.KWin.EIS.RemoteDesktop', 'connectToEIS', GLib.Variant('(i)', (3,)), None, 0, 4000, None, None)
    index, cookie = reply.unpack()
    fd = fds.get(index)
    lib = C.CDLL(ctypes.util.find_library('ei'))
    def fn(name, result, *args):
        f = getattr(lib, name)
        f.restype = result
        f.argtypes = list(args)
        return f
    P, I, U, D, B, U64 = C.c_void_p, C.c_int, C.c_uint32, C.c_double, C.c_bool, C.c_uint64
    new = fn('ei_new_sender', P, P)
    configure = fn('ei_configure_name', None, P, C.c_char_p)
    setup = fn('ei_setup_backend_fd', I, P, I)
    dispatch = fn('ei_dispatch', I, P)
    get_event = fn('ei_get_event', P, P)
    event_type = fn('ei_event_get_type', I, P)
    event_seat = fn('ei_event_get_seat', P, P)
    event_device = fn('ei_event_get_device', P, P)
    unref_event = fn('ei_event_unref', P, P)
    seat_has = fn('ei_seat_has_capability', B, P, I)
    device_has = fn('ei_device_has_capability', B, P, I)
    bind = fn('ei_seat_bind_capabilities', None, P)  # Remaining arguments are variadic.
    start = fn('ei_device_start_emulating', None, P, U)
    stop = fn('ei_device_stop_emulating', None, P)
    now = fn('ei_now', U64, P)
    frame = fn('ei_device_frame', None, P, U64)
    move = fn('ei_device_pointer_motion_absolute', None, P, D, D)
    button = fn('ei_device_button_button', None, P, U, B)
    wheel = fn('ei_device_scroll_delta', None, P, D, D)
    key = fn('ei_device_keyboard_key', None, P, U, B)
    text = fn('ei_device_text_utf8', None, P, C.c_char_p)
    new_ping = fn('ei_new_ping', P, P)
    ping = fn('ei_ping', None, P)
    ping_unref = fn('ei_ping_unref', P, P)
    unref = fn('ei_unref', P, P)
    get_fd = fn('ei_get_fd', I, P)
    op = request['operation']
    required = {'move': [2], 'click': [32], 'scroll': [16], 'keys': [4], 'type': [64], 'probe': [2, 4, 16, 32, 64]}[op]
    ctx = new(None)
    devices = {}
    started = set()
    pending_ping = None
    sent = False
    try:
        configure(ctx, b'Remote Control MCP')
        if setup(ctx, fd) < 0:
            raise RuntimeError('eis_connection_failed')
        deadline = time.monotonic() + 6
        while time.monotonic() < deadline:
            dispatch(ctx)
            while True:
                event = get_event(ctx)
                if not event:
                    break
                try:
                    kind = event_type(event)
                    if kind == 2:
                        raise RuntimeError('eis_disconnected')
                    if kind == 3:
                        seat = event_seat(event)
                        # Bind the advertised device groups together: compositors may couple
                        # absolute motion, button and scroll on one logical device.
                        caps = [cap for cap in (1, 2, 4, 16, 32, 64) if seat_has(seat, cap)]
                        bind(seat, *[I(cap) for cap in caps], P())
                    if kind == 8:
                        device = event_device(event)
                        for cap in required:
                            if device_has(device, cap):
                                devices[cap] = device
                        if device not in started and op != 'probe':
                            start(device, 1)
                            started.add(device)
                    if kind in (6, 7) and sent:
                        raise RuntimeError('eis_delivery_uncertain')
                    if kind == 90 and sent:
                        return {'ok': True, 'delivery': 'delivered_unverified'}
                finally:
                    unref_event(event)
            if not sent and all(cap in devices for cap in required):
                if op == 'probe':
                    return {'ok': True, 'capabilities': required}
                sent = True
                if op == 'move':
                    move(devices[2], request['x'], request['y'])
                elif op == 'click':
                    for _ in range(request.get('count', 1)):
                        button(devices[32], request['button'], True)
                        frame(devices[32], now(ctx))
                        button(devices[32], request['button'], False)
                        frame(devices[32], now(ctx))
                        time.sleep(.05)
                elif op == 'scroll':
                    wheel(devices[16], 0, request['delta'])
                elif op == 'keys':
                    for code in request['codes']:
                        key(devices[4], code, True)
                    frame(devices[4], now(ctx))
                    for code in reversed(request['codes']):
                        key(devices[4], code, False)
                elif op == 'type':
                    chunk = ''
                    for char in request['text']:
                        if char == '\0':
                            raise RuntimeError('nul_text_unsupported')
                        if len((chunk + char).encode()) > 240:
                            text(devices[64], chunk.encode())
                            frame(devices[64], now(ctx))
                            chunk = ''
                        chunk += char
                    if chunk:
                        text(devices[64], chunk.encode())
                for device in started:
                    frame(device, now(ctx))
                    stop(device)
                pending_ping = new_ping(ctx)
                ping(pending_ping)
            select.select([get_fd(ctx)], [], [], .05)
        raise RuntimeError('eis_delivery_uncertain' if sent else 'eis_capability_unavailable')
    finally:
        if pending_ping:
            ping_unref(pending_ping)
        unref(ctx)
        bus.call_sync('org.kde.KWin', '/org/kde/KWin/EIS/RemoteDesktop', 'org.kde.KWin.EIS.RemoteDesktop', 'disconnect', GLib.Variant('(i)', (cookie,)), None, 0, 3000, None)


if __name__ == '__main__':
    os.umask(0o077)
    try:
        request = json.load(sys.stdin)
        result = eis(request) if request.pop('backend', None) == 'eis' else kwin(request)
        print(json.dumps(result))
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}))
        sys.exit(1)
