package eu.astancu.rcmcp.android;

/** Prerequisites only: protected windows and individual capture failures remain possible. */
final class CaptureReadiness {
    private CaptureReadiness() {}
    static String reason(int sdk, boolean accessibility, String projection) {
        if (!accessibility) return "accessibility_unavailable";
        if (sdk >= 30) return "accessibility_ready";
        if (sdk < 29) return "screenshot_unsupported";
        if ("active".equals(projection)) return "projection_active";
        if ("screen_sharing_consent_required".equals(projection)
                || "screen_sharing_consent_denied".equals(projection))
            return "screen_sharing_consent_required";
        return "screen_sharing_unavailable";
    }
}
