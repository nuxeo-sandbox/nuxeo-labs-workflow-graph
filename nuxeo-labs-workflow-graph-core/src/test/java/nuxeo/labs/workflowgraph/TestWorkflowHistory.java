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

import static java.lang.Boolean.TRUE;
import static java.util.stream.Collectors.toMap;
import static nuxeo.labs.workflowgraph.WorkflowHistoryConstants.NODE_ID_KEY;
import static nuxeo.labs.workflowgraph.WorkflowHistoryConstants.STEP_COMPLETED_EVENT;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.nuxeo.audit.api.LogEntryConstants.LOG_EVENT_ID;
import static org.nuxeo.audit.service.AuditComponent.DEFAULT_AUDIT_BACKEND;

import java.io.Serializable;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.nuxeo.audit.api.AuditQueryBuilder;
import org.nuxeo.audit.api.LogEntry;
import org.nuxeo.audit.service.AuditService;
import org.nuxeo.ecm.core.api.IdRef;
import org.nuxeo.ecm.core.io.registry.MarshallerHelper;
import org.nuxeo.ecm.core.io.registry.context.RenderingContext.CtxBuilder;
import org.nuxeo.ecm.core.query.sql.model.Predicates;
import org.nuxeo.ecm.core.test.annotations.Granularity;
import org.nuxeo.ecm.core.test.annotations.RepositoryConfig;
import org.nuxeo.ecm.platform.routing.api.DocumentRoute;
import org.nuxeo.ecm.platform.routing.core.impl.GraphNode;
import org.nuxeo.ecm.platform.routing.core.impl.GraphNode.State;
import org.nuxeo.ecm.platform.routing.core.impl.GraphRoute;
import org.nuxeo.runtime.api.Framework;
import org.nuxeo.runtime.test.runner.Features;
import org.nuxeo.runtime.test.runner.FeaturesRunner;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * Recorder ({@link StepCompletedListener}): one audit entry per completed step on each document attached to the
 * workflow, as read by {@link GetWorkflowGraphOperation}.
 *
 * @since 2025.2
 */
@RunWith(FeaturesRunner.class)
@Features(WorkflowGraphFeature.class)
@RepositoryConfig(cleanup = Granularity.METHOD)
public class TestWorkflowHistory extends AbstractWorkflowHistoryTest {

    @Test
    public void testSimplePath() {
        createSimpleModel();
        String id = startWorkflow();

        assertEquals(List.of("end", "start#0(toStep)>step", "step#0(toEnd)>end"), recorded(file.getId(), id));

        // one audit entry per completed step, on the attached document
        List<LogEntry> entries = entries(file.getId());
        assertEquals(3, entries.size());
        Map<String, LogEntry> byNode = entries.stream()
                                              .collect(toMap(e -> e.getExtendedValue(NODE_ID_KEY), e -> e));
        LogEntry start = byNode.get("start");
        assertEquals("Routing", start.getCategory());
        assertEquals("start -> step (toStep)", start.getComment());
        assertEquals(file.getId(), start.getDocUUID());
        assertEquals("File", start.getDocType());
        // the end step follows no transition: empty lists
        assertEquals("end", byNode.get("end").getComment());
        assertEquals(List.of(), byNode.get("end").getExtendedValue("lwgTransitions"));
        assertEquals(List.of(), byNode.get("end").getExtendedValue("lwgTransitionNames"));
        assertEquals(List.of(), byNode.get("end").getExtendedValue("lwgTargets"));
        // the names documented for custom recorders and read by the operation
        LogEntry step = byNode.get("step");
        assertEquals(id, step.getExtendedValue("lwgWorkflowId"));
        assertEquals(MODEL_NAME, step.getExtendedValue("lwgModelName"));
        assertEquals("step", step.getExtendedValue("lwgNodeId"));
        assertEquals(List.of(0L), longs(step.getExtendedValue("lwgTransitions")));
        assertEquals(List.of("toEnd"), step.getExtendedValue("lwgTransitionNames"));
        assertEquals(List.of("end"), step.getExtendedValue("lwgTargets"));

        // nothing on the workflow instance
        assertTrue(entries(id).isEmpty());
    }

    @Test
    public void testJsonOfTheRestApi() throws Exception {
        createSimpleModel();
        String id = startWorkflow();

        // as returned by GET /api/v1/id/{docId}/@audit
        Map<String, JsonNode> byNode = new HashMap<>();
        for (LogEntry entry : entries(file.getId())) {
            var json = new ObjectMapper().readTree(MarshallerHelper.objectToJson(LogEntry.class, entry,
                    CtxBuilder.get()));
            byNode.put(json.get("extended").get("lwgNodeId").asText(), json);
        }
        assertEquals(3, byNode.size());
        JsonNode start = byNode.get("start");
        assertEquals(STEP_COMPLETED_EVENT, start.get("eventId").asText());
        JsonNode extended = start.get("extended");
        assertEquals(id, extended.get("lwgWorkflowId").asText());
        assertEquals(MODEL_NAME, extended.get("lwgModelName").asText());
        assertEquals("[0]", extended.get("lwgTransitions").toString());
        assertEquals("[\"toStep\"]", extended.get("lwgTransitionNames").toString());
        assertEquals("[\"step\"]", extended.get("lwgTargets").toString());
        JsonNode end = byNode.get("end").get("extended");
        assertEquals("[]", end.get("lwgTransitions").toString());
        assertEquals("[]", end.get("lwgTransitionNames").toString());
        assertEquals("[]", end.get("lwgTargets").toString());
    }

    @Test
    public void testLoopWithTask() {
        node("start", n -> {
            n.setPropertyValue(GraphNode.PROP_START, TRUE);
            setTransitions(n, transition("toReview", "review", "true"));
        });
        node("review", n -> {
            n.setPropertyValue(GraphNode.PROP_HAS_TASK, TRUE);
            setTransitions(n, transition("reject", "review", button("reject")),
                    transition("validate", "end", button("validate")));
        });
        node("end", n -> n.setPropertyValue(GraphNode.PROP_STOP, TRUE));
        String id = startWorkflow();

        // the review is the current step: not completed yet
        assertEquals(List.of("start#0(toReview)>review"), recorded(file.getId(), id));

        resume(id, "review", "reject");
        assertEquals(List.of("review#0(reject)>review", "start#0(toReview)>review"), recorded(file.getId(), id));

        resume(id, "review", "reject");
        resume(id, "review", "validate");
        assertEquals(List.of("end", "review#0(reject)>review", "review#0(reject)>review", "review#1(validate)>end",
                "start#0(toReview)>review"), recorded(file.getId(), id));
    }

    @Test
    public void testForkAndMerge() {
        node("start", n -> {
            n.setPropertyValue(GraphNode.PROP_START, TRUE);
            setTransitions(n, transition("toA", "a", "true"), transition("toB", "b", "true"));
        });
        node("a", n -> setTransitions(n, transition("aToMerge", "merge", "true")));
        node("b", n -> setTransitions(n, transition("bToMerge", "merge", "true")));
        node("merge", n -> {
            n.setPropertyValue(GraphNode.PROP_MERGE, "all");
            n.setPropertyValue(GraphNode.PROP_STOP, TRUE);
        });
        String id = startWorkflow();

        assertEquals(List.of("a#0(aToMerge)>merge", "b#0(bToMerge)>merge", "merge", "start#0(toA)>a#1(toB)>b"),
                recorded(file.getId(), id));
    }

    @Test
    public void testExecuteOnlyFirstTransition() {
        node("start", n -> {
            n.setPropertyValue(GraphNode.PROP_START, TRUE);
            n.setPropertyValue(GraphNode.PROP_EXECUTE_ONLY_FIRST_TRANSITION, TRUE);
            setTransitions(n, transition("never", "a", "false"), transition("first", "b", "true"),
                    transition("second", "c", "true"));
        });
        node("a", n -> setTransitions(n, transition("aToEnd", "end", "true")));
        node("b", n -> setTransitions(n, transition("bToEnd", "end", "true")));
        node("c", n -> setTransitions(n, transition("cToEnd", "end", "true")));
        node("end", n -> n.setPropertyValue(GraphNode.PROP_STOP, TRUE));
        String id = startWorkflow();

        assertEquals(List.of("b#0(bToEnd)>end", "end", "start#1(first)>b"), recorded(file.getId(), id));
    }

    @Test
    public void testCanceledWorkflow() {
        createReviewModel();
        String id = startWorkflow();

        session.getDocument(new IdRef(id)).getAdapter(DocumentRoute.class).cancel(session);
        session.save();

        // the canceled step (it was waiting for its task) is not recorded as completed
        assertEquals(List.of("start#0(toReview)>review"), recorded(file.getId(), id));
    }

    @Test
    public void testStepWithSeveralTasks() {
        node("start", n -> {
            n.setPropertyValue(GraphNode.PROP_START, TRUE);
            setTransitions(n, transition("toReview", "review", "true"));
        });
        node("review", n -> {
            n.setPropertyValue(GraphNode.PROP_HAS_MULTIPLE_TASKS, TRUE);
            n.setPropertyValue(GraphNode.PROP_TASK_ASSIGNEES, (Serializable) List.of("john", "jane"));
            setTransitions(n, transition("validate", "end", "true"));
        });
        node("end", n -> n.setPropertyValue(GraphNode.PROP_STOP, TRUE));
        String id = startWorkflow();
        assertEquals(2, openTasks(id, "review").size());

        // the step completes with its last task only
        routing.endTask(session, openTasks(id, "review").get(0), new HashMap<>(), "validate");
        session.save();
        assertEquals(List.of("start#0(toReview)>review"), recorded(file.getId(), id));

        routing.endTask(session, openTasks(id, "review").get(0), new HashMap<>(), "validate");
        session.save();
        assertEquals(List.of("end", "review#0(validate)>end", "start#0(toReview)>review"),
                recorded(file.getId(), id));
    }

    @Test
    public void testMergeWaitingForAnotherBranch() {
        node("start", n -> {
            n.setPropertyValue(GraphNode.PROP_START, TRUE);
            setTransitions(n, transition("toA", "a", "true"), transition("toB", "b", "true"));
        });
        node("a", n -> setTransitions(n, transition("aToMerge", "merge", "true")));
        node("b", n -> {
            n.setPropertyValue(GraphNode.PROP_HAS_TASK, TRUE);
            setTransitions(n, transition("bToMerge", "merge", button("done")));
        });
        node("merge", n -> {
            n.setPropertyValue(GraphNode.PROP_MERGE, "all");
            setTransitions(n, transition("toEnd", "end", "true"));
        });
        node("end", n -> n.setPropertyValue(GraphNode.PROP_STOP, TRUE));
        String id = startWorkflow();

        // "a" is done, "b" waits for its task: the merge waits for "b", it never started
        var graph = session.getDocument(new IdRef(id)).getAdapter(GraphRoute.class);
        assertEquals(State.WAITING, graph.getNode("merge").getState());
        assertEquals(List.of("a#0(aToMerge)>merge", "start#0(toA)>a#1(toB)>b"), recorded(file.getId(), id));

        // once "b" is done, the merge completes once
        resume(id, "b", "done");
        assertEquals(List.of("a#0(aToMerge)>merge", "b#0(bToMerge)>merge", "end", "merge#0(toEnd)>end",
                "start#0(toA)>a#1(toB)>b"), recorded(file.getId(), id));
    }

    @Test
    public void testSeveralAttachedDocuments() {
        var other = session.createDocument(session.createDocumentModel("/", "other", "File"));
        createSimpleModel();
        String id = startWorkflow(List.of(file.getId(), other.getId()));

        // the same entries on each attached document
        List<String> expected = List.of("end", "start#0(toStep)>step", "step#0(toEnd)>end");
        assertEquals(expected, recorded(file.getId(), id));
        assertEquals(expected, recorded(other.getId(), id));
        entries(other.getId()).forEach(e -> assertEquals(other.getId(), e.getDocUUID()));
    }

    @Test
    public void testAttachedDocumentDeletedWhileTheWorkflowRuns() {
        var other = session.createDocument(session.createDocumentModel("/", "other", "File"));
        createReviewModel();
        String id = startWorkflow(List.of(file.getId(), other.getId()));
        assertEquals(List.of("start#0(toReview)>review"), recorded(other.getId(), id));

        // still listed by the workflow (Nuxeo removes it after the commit): skipped
        session.removeDocument(other.getRef());
        resume(id, "review", "validate");

        assertEquals(List.of("end", "review#0(validate)>end", "start#0(toReview)>review"),
                recorded(file.getId(), id));
        assertEquals(List.of("start#0(toReview)>review"), recorded(other.getId(), id));
    }

    @Test
    public void testWorkflowWithoutAttachedDocument() {
        createSimpleModel();
        String id = startWorkflow(List.of());

        // the workflow is not disturbed, nothing is recorded
        assertTrue(session.getDocument(new IdRef(id)).getAdapter(DocumentRoute.class).isDone());
        txFeature.nextTransaction();
        var backend = Framework.getService(AuditService.class).getAuditBackend(DEFAULT_AUDIT_BACKEND);
        assertTrue(backend.queryLogs(new AuditQueryBuilder().predicate(
                Predicates.eq(LOG_EVENT_ID, STEP_COMPLETED_EVENT))).isEmpty());
    }

    @Test
    public void testCommentIsAbbreviated() {
        List<Map<String, Serializable>> transitions = new ArrayList<>();
        List<Integer> followed = new ArrayList<>();
        for (int i = 0; i < 50; i++) {
            transitions.add(transition("a_transition_with_a_rather_long_name_" + i, "TargetStep" + i, "true"));
            followed.add(i);
        }
        assertEquals("fork -> TargetStep1 (a_transition_with_a_rather_long_name_1)",
                StepCompletedListener.comment("fork", transitions, List.of(1)));
        String comment = StepCompletedListener.comment("fork", transitions, followed);
        assertEquals(StepCompletedListener.MAX_COMMENT_LENGTH, comment.length());
        assertTrue(comment.startsWith("fork -> TargetStep0 (a_transition_with_a_rather_long_name_0), "));
        assertTrue(comment.endsWith("..."));
    }

    @Test
    public void testPropertiesOfTheEvent() {
        List<Map<String, Serializable>> transitions = List.of(transition("t0", "a", "true"),
                transition("t1", "b", "true"), transition(null, null, "true"));
        Map<String, Serializable> properties = StepCompletedListener.properties("wf", "Model", "fork", transitions,
                List.of(1, 2));
        assertEquals("Routing", properties.get("category"));
        assertEquals("wf", properties.get("lwgWorkflowId"));
        assertEquals("Model", properties.get("lwgModelName"));
        assertEquals("fork", properties.get("lwgNodeId"));
        assertEquals(List.of(1L, 2L), properties.get("lwgTransitions"));
        // never null in the lists, the positions stay aligned
        assertEquals(List.of("t1", ""), properties.get("lwgTransitionNames"));
        assertEquals(List.of("b", ""), properties.get("lwgTargets"));
    }

    /** Returns the numbers of the list as longs (the audit backends may return Integer or Long). */
    protected static List<Long> longs(List<?> values) {
        return values.stream().map(v -> ((Number) v).longValue()).toList();
    }
}