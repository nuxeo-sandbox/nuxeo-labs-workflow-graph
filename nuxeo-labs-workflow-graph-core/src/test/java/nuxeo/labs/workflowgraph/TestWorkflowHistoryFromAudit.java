/*
 * (C) Copyright 2026 Hyland (http://hyland.com/) and others.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Contributors:
 *     Thibaud Arguillere (with the help of opencode/Claude Opus 5.5)
 */
package nuxeo.labs.workflowgraph;

import static nuxeo.labs.workflowgraph.WorkflowHistoryConstants.NODE_ID_KEY;
import static nuxeo.labs.workflowgraph.WorkflowHistoryConstants.STEP_COMPLETED_EVENT;
import static nuxeo.labs.workflowgraph.WorkflowHistoryConstants.TARGETS_KEY;
import static nuxeo.labs.workflowgraph.WorkflowHistoryConstants.TRANSITIONS_KEY;
import static nuxeo.labs.workflowgraph.WorkflowHistoryConstants.TRANSITION_NAMES_KEY;
import static nuxeo.labs.workflowgraph.WorkflowHistoryConstants.WORKFLOW_ID_KEY;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import org.junit.Test;
import org.nuxeo.audit.api.LogEntry;

import nuxeo.labs.workflowgraph.WorkflowHistory.FollowedTransition;
import nuxeo.labs.workflowgraph.WorkflowHistory.Step;

/**
 * {@link WorkflowHistory#fromAudit}: the audit entries of the recorder for one workflow, in date order, with their
 * counts; the other entries and the invalid values are ignored.
 *
 * @since 2025.3
 */
public class TestWorkflowHistoryFromAudit {

    protected long nextId = 1;

    protected LogEntry entry(String eventId, long time, Map<String, Object> extended) {
        return LogEntry.builder(eventId, new Date(time)).id(nextId++).extended(extended).build();
    }

    /** An entry of the recorder, the null values are not set. */
    protected LogEntry step(long time, String workflowId, String nodeId, Object positions, Object names,
            Object targets) {
        Map<String, Object> extended = new HashMap<>();
        extended.put(WORKFLOW_ID_KEY, workflowId);
        extended.put(NODE_ID_KEY, nodeId);
        extended.values().removeIf(v -> v == null);
        if (positions != null) {
            extended.put(TRANSITIONS_KEY, positions);
        }
        if (names != null) {
            extended.put(TRANSITION_NAMES_KEY, names);
        }
        if (targets != null) {
            extended.put(TARGETS_KEY, targets);
        }
        return entry(STEP_COMPLETED_EVENT, time, extended);
    }

    @Test
    public void testEntriesOfTheWorkflowInDateOrderWithCounts() {
        List<LogEntry> entries = List.of(
                step(3000, "wf", "review", List.of(0L), List.of("reject"), List.of("review")),
                step(4000, "wf", "review", List.of(1L), List.of("validate"), List.of("end")),
                step(1000, "wf", "start", List.of(0L), List.of("toReview"), List.of("review")),
                step(2000, "wf", "review", List.of(0L), List.of("reject"), List.of("review")),
                step(5000, "wf", "end", List.of(), List.of(), List.of()),
                // another workflow, another event, no step: ignored
                step(500, "other", "start", List.of(0L), List.of("x"), List.of("y")),
                entry("documentModified", 600, Map.of(WORKFLOW_ID_KEY, "wf", NODE_ID_KEY, "start")),
                step(700, "wf", null, List.of(0L), List.of("x"), List.of("y")),
                step(800, "wf", " ", List.of(0L), List.of("x"), List.of("y")));

        var history = WorkflowHistory.fromAudit(entries, "wf", false);
        assertEquals(List.of(new Step("start", true, 1), new Step("review", true, 3), new Step("end", true, 1)),
                history.nodes());
        assertEquals(List.of(new FollowedTransition("start", 0, "toReview", "review", 1),
                new FollowedTransition("review", 0, "reject", "review", 2),
                new FollowedTransition("review", 1, "validate", "end", 1)), history.transitions());
        assertFalse(history.truncated());
    }

    @Test
    public void testValuesOfOtherTypes() {
        // lists as comma-separated strings, positions as any number or digits, invalid positions ignored
        List<LogEntry> entries = List.of(step(1000, "wf", "fork", "0, 2", "a,c", "A, C"),
                step(2000, "wf", "split", List.of(1, "3", 4.0, -1, "x", 1.5), List.of("b", "d", "e"), List.of("B")),
                step(3000, "wf", "end", null, null, null));

        var history = WorkflowHistory.fromAudit(entries, "wf", true);
        assertEquals(List.of(new Step("fork", true, 1), new Step("split", true, 1), new Step("end", true, 1)),
                history.nodes());
        assertEquals(List.of(new FollowedTransition("fork", 0, "a", "A", 1),
                new FollowedTransition("fork", 2, "c", "C", 1), new FollowedTransition("split", 1, "b", "B", 1),
                new FollowedTransition("split", 3, "d", null, 1), new FollowedTransition("split", 4, "e", null, 1)),
                history.transitions());
        assertTrue(history.truncated());
    }

    @Test
    public void testNoEntry() {
        var entries = List.of(step(1000, "wf", "start", List.of(0L), List.of("a"), List.of("b")));
        for (var history : List.of(WorkflowHistory.fromAudit(List.of(), "wf", false),
                WorkflowHistory.fromAudit(entries, null, false), WorkflowHistory.fromAudit(entries, "other", false))) {
            assertTrue(history.nodes().isEmpty());
            assertTrue(history.transitions().isEmpty());
        }
    }

    @Test
    public void testIndex() {
        assertEquals(3, WorkflowHistory.index(3L));
        assertEquals(3, WorkflowHistory.index(" 3 "));
        assertEquals(0, WorkflowHistory.index(0.0));
        for (Object invalid : new Object[] { null, -1, -1L, 1.5, Double.NaN, 1L + Integer.MAX_VALUE, "", "-1", "1.0",
                "1234567890", List.of(1) }) {
            assertEquals(String.valueOf(invalid), -1, WorkflowHistory.index(invalid));
        }
    }
}
