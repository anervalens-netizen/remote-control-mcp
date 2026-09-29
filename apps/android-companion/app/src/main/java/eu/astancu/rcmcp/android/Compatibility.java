package eu.astancu.rcmcp.android;

/** Java library methods unavailable on API 29, without adding desugaring dependencies. */
final class Compatibility {
    private Compatibility() {}

    static boolean isBlank(String value) {
        for (int offset = 0; offset < value.length();) {
            int point = value.codePointAt(offset);
            if (!Character.isWhitespace(point)) return false;
            offset += Character.charCount(point);
        }
        return true;
    }
}
