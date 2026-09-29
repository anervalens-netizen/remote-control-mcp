package eu.astancu.rcmcp.android;

import java.util.IdentityHashMap;
import java.util.Map;

/** Process-local guard for our remote UI input only, never for physical input or shell. */
final class LocalConsentBoundary {
    static final LocalConsentBoundary INSTANCE = new LocalConsentBoundary();
    private final Map<Object, Boolean> owners = new IdentityHashMap<>();

    synchronized void update(Object owner, boolean foreground, boolean pending) {
        owners.put(owner, foreground || pending);
    }

    synchronized void destroy(Object owner) { owners.remove(owner); }

    synchronized boolean allows(String operation) {
        if ("observe".equals(operation)) return true;
        if (BackgroundConfigurationImport.blocksRemoteMutation()) return false;
        for (boolean blocked : owners.values()) if (blocked) return false;
        return true;
    }
}
