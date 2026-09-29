package eu.astancu.rcmcp.android;

import org.junit.Test;
import static org.junit.Assert.*;

public final class ImportGenerationTest {
    @Test public void timeoutRejectsLateParsedResult() {
        ImportGeneration state = new ImportGeneration();
        long task = state.begin();
        assertTrue(state.accepts(task));
        state.cancel();
        assertFalse(state.accepts(task));
    }
    @Test public void destructionRejectsLateParsedResult() {
        ImportGeneration state = new ImportGeneration();
        long task = state.begin();
        state.destroy();
        assertFalse(state.accepts(task));
        assertFalse(state.accepts(state.begin()));
    }
    @Test public void replacementAndCompletionRejectOldResult() {
        ImportGeneration state = new ImportGeneration();
        long old = state.begin();
        long current = state.begin();
        assertFalse(state.accepts(old));
        assertTrue(state.accepts(current));
        state.cancel();
        assertFalse(state.accepts(current));
    }
}
