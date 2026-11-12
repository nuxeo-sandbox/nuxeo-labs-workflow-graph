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

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

import org.nuxeo.audit.api.LogEntry;

/**
 * History of a workflow instance, as drawn by the graph: the steps completed at least once and the transitions
 * followed at least once. Built from the audit entries written by the recorder ({@link StepCompletedListener}) on a
 * document attached to the workflow, and returned by {@link GetWorkflowGraphOperation} in the format read by the
 * graph dialog ({@code LWG.normalizeHistory} in {@code lwg-core.js}).
 *
 * @param nodes the steps completed at least once, in the order of their first completion
 * @param transitions the transitions followed at least once, in the order they were first followed
 * @param truncated true when the oldest audit entries may not have been read (too many entries)
 * @since 2025.3
 */
public record WorkflowHistory(List<Step> nodes, List<FollowedTransition> transitions, boolean truncated) {

    /**
     * A step completed at least once.
     *
     * @param id the id of the step ({@code rnode:nodeId})
     * @param completed always true (the graph also accepts steps started and not completed)
     * @param count the number of times the step completed
     */
    public record Step(String id, boolean completed, int count) {
    }

    /**
     * A transition followed at least once.
     *
     * @param source the id of its step
     * @param index its position in the step (definition order, the order of the graph endpoint)
     * @param name its name, null when unknown
     * @param target the id of its target step, null when unknown
     * @param count the number of times it was followed
     */
    public record FollowedTransition(String source, int index, String name, String target, int count) {
    }

    private record Key(String source, int index) {
    }

    private static final Pattern INDEX = Pattern.compile("\\d{1,9}");

    /**
     * Builds the history of the workflow from audit entries, in any order. Only the entries of the recorder's event
     * ({@link WorkflowHistoryConstants#STEP_COMPLETED_EVENT}) for this workflow are kept; invalid values are ignored.
     * The lists of an entry can be lists or comma-separated strings, the positions numbers or strings of digits.
     *
     * @param entries the audit entries of a document attached to the workflow
     * @param workflowId the id of the workflow instance
     * @param truncated true when the oldest entries may not have been read
     */
    public static WorkflowHistory fromAudit(Collection<LogEntry> entries, String workflowId, boolean truncated) {
        Map<String, Integer> nodes = new LinkedHashMap<>();
        Map<Key, FollowedTransition> transitions = new LinkedHashMap<>();
        entries.stream()
               .filter(e -> isEntryOf(e, workflowId))
               .sorted(Comparator.comparing(LogEntry::getEventDate).thenComparingLong(LogEntry::getId))
               .forEach(e -> {
                   String source = text(e.getExtended().get(NODE_ID_KEY));
                   nodes.merge(source, 1, Integer::sum);
                   List<?> positions = list(e.getExtended().get(TRANSITIONS_KEY));
                   List<?> names = list(e.getExtended().get(TRANSITION_NAMES_KEY));
                   List<?> targets = list(e.getExtended().get(TARGETS_KEY));
                   for (int i = 0; i < positions.size(); i++) {
                       int index = index(positions.get(i));
                       if (index < 0) {
                           continue;
                       }
                       var followed = new FollowedTransition(source, index, text(item(names, i)),
                               text(item(targets, i)), 1);
                       transitions.merge(new Key(source, index), followed, (known, again) -> new FollowedTransition(
                               known.source(), known.index(), known.name(), known.target(), known.count() + 1));
                   }
               });
        List<Step> steps = new ArrayList<>();
        nodes.forEach((id, count) -> steps.add(new Step(id, true, count)));
        return new WorkflowHistory(List.copyOf(steps), List.copyOf(transitions.values()), truncated);
    }

    protected static boolean isEntryOf(LogEntry entry, String workflowId) {
        return entry != null && STEP_COMPLETED_EVENT.equals(entry.getEventId()) && entry.getEventDate() != null
                && entry.getExtended() != null && workflowId != null
                && workflowId.equals(text(entry.getExtended().get(WORKFLOW_ID_KEY)))
                && text(entry.getExtended().get(NODE_ID_KEY)) != null;
    }

    /** Returns the value as a trimmed string, null when it is null or blank. */
    protected static String text(Object value) {
        if (value == null) {
            return null;
        }
        String text = value.toString().trim();
        return text.isEmpty() ? null : text;
    }

    /** Returns the value as a list: a collection, an array or a comma-separated string. Never null. */
    protected static List<?> list(Object value) {
        return switch (value) {
            case Collection<?> c -> new ArrayList<>(c);
            case Object[] a -> Arrays.asList(a);
            case String s when !s.isBlank() -> Arrays.stream(s.split(",")).map(String::trim).toList();
            case null, default -> List.of();
        };
    }

    protected static Object item(List<?> list, int i) {
        return i < list.size() ? list.get(i) : null;
    }

    /** Returns the position of a transition in its step: a non-negative integer (or its digits), -1 otherwise. */
    protected static int index(Object value) {
        return switch (value) {
            case Integer i -> i >= 0 ? i : -1;
            case Long l -> l >= 0 && l <= Integer.MAX_VALUE ? l.intValue() : -1;
            case Short s -> s >= 0 ? s : -1;
            case Number n -> {
                double d = n.doubleValue();
                yield d >= 0 && d <= Integer.MAX_VALUE && d == Math.rint(d) ? (int) d : -1;
            }
            case String s when INDEX.matcher(s.trim()).matches() -> Integer.parseInt(s.trim());
            case null, default -> -1;
        };
    }
}
