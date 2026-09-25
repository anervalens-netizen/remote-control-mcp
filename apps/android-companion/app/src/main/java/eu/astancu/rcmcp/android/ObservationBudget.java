package eu.astancu.rcmcp.android;

/** Pure bounded text budget for serialized Accessibility observations. */
public final class ObservationBudget {
    public static final int DEFAULT_MAX_FIELD_CHARS = 2048;
    public static final int DEFAULT_MAX_TOTAL_CHARS = 256 * 1024;

    private final int maxFieldChars;
    private final int maxTotalChars;
    private int usedChars;
    private boolean fieldTruncated;

    public ObservationBudget() {
        this(DEFAULT_MAX_FIELD_CHARS, DEFAULT_MAX_TOTAL_CHARS);
    }

    ObservationBudget(int maxFieldChars, int maxTotalChars) {
        if (maxFieldChars < 1 || maxTotalChars < 1) throw new IllegalArgumentException("observation_budget_invalid");
        this.maxFieldChars = maxFieldChars;
        this.maxTotalChars = maxTotalChars;
    }

    public String take(Object raw) {
        if (raw == null) return "";
        String value = raw.toString();
        int remaining = Math.max(0, maxTotalChars - usedChars);
        int allowed = Math.min(Math.min(value.length(), maxFieldChars), remaining);
        if (allowed < value.length()) fieldTruncated = true;
        usedChars += allowed;
        return value.substring(0, allowed);
    }

    public boolean exhausted() {
        return usedChars >= maxTotalChars;
    }

    public boolean fieldTruncated() {
        return fieldTruncated;
    }

    public int usedChars() {
        return usedChars;
    }
}
