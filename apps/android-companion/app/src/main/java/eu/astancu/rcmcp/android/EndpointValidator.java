package eu.astancu.rcmcp.android;

import java.net.Inet4Address;
import java.net.URI;
import java.net.URISyntaxException;

public final class EndpointValidator {
    private EndpointValidator() {}

    public static String validateAndNormalize(String raw) {
        if (raw == null || raw.isBlank()) throw new IllegalArgumentException("endpoint_required");
        String candidate = raw.trim();
        URI uri;
        try {
            uri = new URI(candidate);
        } catch (URISyntaxException e) {
            throw new IllegalArgumentException("endpoint_invalid", e);
        }
        String scheme = uri.getScheme();
        String host = uri.getHost();
        if (scheme == null || host == null || uri.getUserInfo() != null
                || uri.getQuery() != null || uri.getFragment() != null
                || uri.getPort() == 0 || (uri.getPort() < -1)) {
            throw new IllegalArgumentException("endpoint_invalid");
        }
        boolean https = "https".equalsIgnoreCase(scheme);
        boolean allowedHttp = "http".equalsIgnoreCase(scheme) && isTailscaleIpv4(host);
        if (!https && !allowedHttp) throw new IllegalArgumentException("endpoint_must_be_https_or_tailscale_http");
        String path = uri.getPath() == null ? "" : uri.getPath();
        if (!path.isEmpty() && !"/".equals(path)) throw new IllegalArgumentException("endpoint_path_not_supported");
        try {
            return new URI(scheme.toLowerCase(), null, host, uri.getPort(), "", null, null).toString();
        } catch (URISyntaxException e) {
            throw new IllegalArgumentException("endpoint_invalid", e);
        }
    }

    static void requireSafeTransport(String normalizedEndpoint, boolean activeVpn) {
        URI uri = URI.create(normalizedEndpoint);
        if ("http".equalsIgnoreCase(uri.getScheme()) && isTailscaleIpv4(uri.getHost()) && !activeVpn) {
            throw new IllegalArgumentException("tailscale_vpn_required_for_http");
        }
    }

    static boolean isTailscaleIpv4(String host) {
        if (host == null || !host.matches("\\d{1,3}(\\.\\d{1,3}){3}")) return false;
        try {
            byte[] address = Inet4Address.getByName(host).getAddress();
            int first = address[0] & 0xff;
            int second = address[1] & 0xff;
            return first == 100 && second >= 64 && second <= 127;
        } catch (Exception e) {
            return false;
        }
    }
}
