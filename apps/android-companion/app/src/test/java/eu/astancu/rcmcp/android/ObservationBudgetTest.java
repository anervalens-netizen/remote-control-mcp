package eu.astancu.rcmcp.android;

import org.junit.Test;

import static org.junit.Assert.*;

public final class ObservationBudgetTest {
    @Test public void truncatesIndividualFieldsWithoutExhaustingTreeTraversal() {
        ObservationBudget budget = new ObservationBudget(4, 100);
        assertEquals("abcd", budget.take("abcdef"));
        assertTrue(budget.fieldTruncated());
        assertFalse(budget.exhausted());
        assertEquals(4, budget.usedChars());
        assertEquals("ghij", budget.take("ghij"));
        assertEquals(8, budget.usedChars());
    }

    @Test public void enforcesAggregateBudgetAcrossFields() {
        ObservationBudget budget = new ObservationBudget(10, 6);
        assertEquals("abcd", budget.take("abcd"));
        assertEquals("ef", budget.take("efgh"));
        assertTrue(budget.fieldTruncated());
        assertTrue(budget.exhausted());
        assertEquals("", budget.take("later"));
        assertEquals(6, budget.usedChars());
    }

    @Test public void nullFieldsDoNotConsumeBudget() {
        ObservationBudget budget = new ObservationBudget(4, 6);
        assertEquals("", budget.take(null));
        assertFalse(budget.fieldTruncated());
        assertEquals(0, budget.usedChars());
    }
}
