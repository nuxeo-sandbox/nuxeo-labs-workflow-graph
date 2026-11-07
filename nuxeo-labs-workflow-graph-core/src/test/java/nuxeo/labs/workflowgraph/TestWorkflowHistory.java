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
import static nuxeo.labs.workflowgraph.WorkflowHistoryConstants.TRANSITIONS_KEY;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.io.Serializable;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

import jakarta.inject.Inject;

import org.apache.commons.lang3.StringUtils;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.nuxeo.audit.api.LogEntry;
import org.nuxeo.ecm.automation.AutomationService;
import org.nuxeo.ecm.automation.OperationContext;
import org.nuxeo.ecm.core.api.Blob;
import org.nuxeo.ecm.core.api.CoreInstance;
import org.nuxeo.ecm.core.api.CoreSession;
import org.nuxeo.ecm.core.api.DocumentNotFoundException;
import org.nuxeo.ecm.core.api.DocumentSecurityException;
import org.nuxeo.ecm.core.api.IdRef;
import org.nuxeo.ecm.core.api.NuxeoException;
import org.nuxeo.ecm.core.api.impl.UserPrincipal;
import org.nuxeo.ecm.core.test.annotations.Granularity;
import org.nuxeo.ecm.core.test.annotations.RepositoryConfig;
import org.nuxeo.ecm.platform.routing.api.DocumentRoute;
import org.nuxeo.ecm.platform.routing.core.impl.GraphNode;
import org.nuxeo.ecm.platform.routing.core.impl.GraphNode.State;
import org.nuxeo.ecm.platform.routing.core.impl.GraphRoute;
import org.nuxeo.runtime.test.runner.Features;
import org.nuxeo.runtime.test.runner.FeaturesRunner;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * Recorder ({@link StepCompletedListener}) and history ({@link WorkflowHistoryReader}, {@link GetWorkflowHistoryOp}).
 *
 * @since 2025.2
 */
@RunWith(FeaturesRunner.class)
@Features(WorkflowGraphFeature.class)
@RepositoryConfig(cleanup = Granularity.METHOD)
public class TestWorkflowHistory extends AbstractWorkflowHistoryTest {

    @Inject
    protected AutomationService automationService;

    @Test
    public void testSimplePath() {
        createSimpleModel();
        String id = startWorkflow();

        WorkflowHistory history = history(id);
        assertEquals(id, history.workflowId());
        assertEquals(List.of("end:true:1", "start:true:1", "step:true:1"), steps(history));
        assertEquals(List.of("start#0>step(toStep)=1", "step#0>end(toEnd)=1"), transitions(history));

        // one audit entry per completed step, on the workflow instance, the end step has no transition
        List<LogEntry> entries = recorderEntries(id);
        assertEquals(3, entries.size());
        Map<String, LogEntry> byNode = entries.stream()
                                              .collect(Collectors.toMap(e -> e.getExtendedValue(NODE_ID_KEY),
                                                      e -> e));
        assertEquals("0", byNode.get("start").getExtendedValue(TRANSITIONS_KEY));
        assertTrue(StringUtils.isEmpty(byNode.get("end").getExtendedValue(TRANSITIONS_KEY)));
        assertEquals("start -> step (toStep)", byNode.get("start").getComment());
        assertEquals("Routing", byNode.get("start").getCategory());
        // the names documented for custom recorders
        assertEquals("step", byNode.get("step").getExtendedValue("lwgNodeId"));
        assertEquals("0", byNode.get("step").getExtendedValue("lwgTransitions"));
    }

    @Test
    public void testLoopWithTask() {
        node("start", n -> {
            n.setPropertyValue(GraphNode.PROP_START, Boolean.TRUE);
            setTransitions(n, transition("toReview", "review", "true"));
        });
        node("review", n -> {
            n.setPropertyValue(GraphNode.PROP_HAS_TASK, Boolean.TRUE);
            setTransitions(n, transition("reject", "review", button("reject")),
                    transition("validate", "end", button("validate")));
        });
        node("end", n -> n.setPropertyValue(GraphNode.PROP_STOP, Boolean.TRUE));
        String id = startWorkflow();

        // the review is the current step: started, not completed
        WorkflowHistory history = history(id);
        assertEquals(List.of("review:false:1", "start:true:1"), steps(history));
        assertEquals(List.of("start#0>review(toReview)=1"), transitions(history));

        resume(id, "review", "reject");
        history = history(id);
        assertEquals(List.of("review:true:2", "start:true:1"), steps(history));
        assertEquals(List.of("review#0>review(reject)=1", "start#0>review(toReview)=1"), transitions(history));

        resume(id, "review", "reject");
        resume(id, "review", "validate");
        history = history(id);
        assertEquals(List.of("end:true:1", "review:true:3", "start:true:1"), steps(history));
        assertEquals(List.of("review#0>review(reject)=2", "review#1>end(validate)=1", "start#0>review(toReview)=1"),
                transitions(history));
    }

    @Test
    public void testForkAndMerge() {
        node("start", n -> {
            n.setPropertyValue(GraphNode.PROP_START, Boolean.TRUE);
            setTransitions(n, transition("toA", "a", "true"), transition("toB", "b", "true"));
        });
        node("a", n -> setTransitions(n, transition("aToMerge", "merge", "true")));
        node("b", n -> setTransitions(n, transition("bToMerge", "merge", "true")));
        node("merge", n -> {
            n.setPropertyValue(GraphNode.PROP_MERGE, "all");
            n.setPropertyValue(GraphNode.PROP_STOP, Boolean.TRUE);
        });
        String id = startWorkflow();

        WorkflowHistory history = history(id);
        assertEquals(List.of("a:true:1", "b:true:1", "merge:true:1", "start:true:1"), steps(history));
        assertEquals(List.of("a#0>merge(aToMerge)=1", "b#0>merge(bToMerge)=1", "start#0>a(toA)=1",
                "start#1>b(toB)=1"), transitions(history));
    }

    @Test
    public void testExecuteOnlyFirstTransition() {
        node("start", n -> {
            n.setPropertyValue(GraphNode.PROP_START, Boolean.TRUE);
            n.setPropertyValue(GraphNode.PROP_EXECUTE_ONLY_FIRST_TRANSITION, Boolean.TRUE);
            setTransitions(n, transition("never", "a", "false"), transition("first", "b", "true"),
                    transition("second", "c", "true"));
        });
        node("a", n -> setTransitions(n, transition("aToEnd", "end", "true")));
        node("b", n -> setTransitions(n, transition("bToEnd", "end", "true")));
        node("c", n -> setTransitions(n, transition("cToEnd", "end", "true")));
        node("end", n -> n.setPropertyValue(GraphNode.PROP_STOP, Boolean.TRUE));
        String id = startWorkflow();

        WorkflowHistory history = history(id);
        assertEquals(List.of("b:true:1", "end:true:1", "start:true:1"), steps(history));
        assertEquals(List.of("b#0>end(bToEnd)=1", "start#1>b(first)=1"), transitions(history));
    }

    @Test
    public void testCanceledWorkflow() {
        node("start", n -> {
            n.setPropertyValue(GraphNode.PROP_START, Boolean.TRUE);
            setTransitions(n, transition("toReview", "review", "true"));
        });
        node("review", n -> {
            n.setPropertyValue(GraphNode.PROP_HAS_TASK, Boolean.TRUE);
            setTransitions(n, transition("validate", "end", button("validate")));
        });
        node("end", n -> n.setPropertyValue(GraphNode.PROP_STOP, Boolean.TRUE));
        String id = startWorkflow();

        session.getDocument(new IdRef(id)).getAdapter(DocumentRoute.class).cancel(session);
        session.save();

        // the canceled step (it was waiting for its task) is not recorded as completed
        assertEquals(List.of("start"), recordedSteps(id));
        WorkflowHistory history = history(id);
        assertEquals(List.of("review:false:1", "start:true:1"), steps(history));
        assertEquals(List.of("start#0>review(toReview)=1"), transitions(history));
    }

    @Test
    public void testStepWithSeveralTasks() {
        node("start", n -> {
            n.setPropertyValue(GraphNode.PROP_START, Boolean.TRUE);
            setTransitions(n, transition("toReview", "review", "true"));
        });
        node("review", n -> {
            n.setPropertyValue(GraphNode.PROP_HAS_MULTIPLE_TASKS, Boolean.TRUE);
            n.setPropertyValue(GraphNode.PROP_TASK_ASSIGNEES, new String[] { "john", "jane" });
            setTransitions(n, transition("validate", "end", "true"));
        });
        node("end", n -> n.setPropertyValue(GraphNode.PROP_STOP, Boolean.TRUE));
        String id = startWorkflow();
        assertEquals(2, openTasks(id, "review").size());

        // the step completes with its last task only
        routing.endTask(session, openTasks(id, "review").get(0), new HashMap<>(), "validate");
        session.save();
        assertEquals(List.of("start"), recordedSteps(id));

        routing.endTask(session, openTasks(id, "review").get(0), new HashMap<>(), "validate");
        session.save();
        assertEquals(List.of("end", "review", "start"), recordedSteps(id));
        assertEquals(List.of("review#0>end(validate)=1", "start#0>review(toReview)=1"), transitions(history(id)));
    }

    @Test
    public void testMergeWaitingForAnotherBranch() {
        node("start", n -> {
            n.setPropertyValue(GraphNode.PROP_START, Boolean.TRUE);
            setTransitions(n, transition("toA", "a", "true"), transition("toB", "b", "true"));
        });
        node("a", n -> setTransitions(n, transition("aToMerge", "merge", "true")));
        node("b", n -> {
            n.setPropertyValue(GraphNode.PROP_HAS_TASK, Boolean.TRUE);
            setTransitions(n, transition("bToMerge", "merge", button("done")));
        });
        node("merge", n -> {
            n.setPropertyValue(GraphNode.PROP_MERGE, "all");
            setTransitions(n, transition("toEnd", "end", "true"));
        });
        node("end", n -> n.setPropertyValue(GraphNode.PROP_STOP, Boolean.TRUE));
        String id = startWorkflow();

        // "a" is done, "b" waits for its task: the merge waits for "b", it never started
        GraphRoute graph = session.getDocument(new IdRef(id)).getAdapter(GraphRoute.class);
        assertEquals(State.WAITING, graph.getNode("merge").getState());
        assertEquals(List.of("a", "start"), recordedSteps(id));
        WorkflowHistory history = history(id);
        assertEquals(List.of("a:true:1", "b:false:1", "start:true:1"), steps(history));
        assertEquals(List.of("a#0>merge(aToMerge)=1", "start#0>a(toA)=1", "start#1>b(toB)=1"), transitions(history));

        // once "b" is done, the merge completes once
        resume(id, "b", "done");
        assertEquals(List.of("a", "b", "end", "merge", "start"), recordedSteps(id));
        history = history(id);
        assertEquals(List.of("a:true:1", "b:true:1", "end:true:1", "merge:true:1", "start:true:1"), steps(history));
        assertEquals(List.of("a#0>merge(aToMerge)=1", "b#0>merge(bToMerge)=1", "merge#0>end(toEnd)=1",
                "start#0>a(toA)=1", "start#1>b(toB)=1"), transitions(history));
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
    public void testOperationReturnsJson() throws Exception {
        createSimpleModel();
        String id = startWorkflow();
        txFeature.nextTransaction();

        JsonNode json;
        try (OperationContext ctx = new OperationContext(session)) {
            Blob blob = (Blob) automationService.run(ctx, GetWorkflowHistoryOp.ID, Map.of("workflowId", id));
            assertEquals("application/json", blob.getMimeType());
            json = new ObjectMapper().readTree(blob.getString());
        }
        assertEquals(id, json.get("workflowId").asText());
        assertEquals(3, json.get("nodes").size());
        JsonNode start = json.get("nodes").get(0);
        assertEquals("start", start.get("id").asText());
        assertTrue(start.get("completed").asBoolean());
        assertEquals(1, start.get("starts").asLong());
        assertEquals(2, json.get("transitions").size());
        JsonNode first = sortedBySource(json.get("transitions")).get(0);
        assertEquals("start", first.get("source").asText());
        assertEquals(0, first.get("index").asInt());
        assertEquals("toStep", first.get("name").asText());
        assertEquals("step", first.get("target").asText());
        assertEquals(1, first.get("count").asLong());
    }

    @Test
    public void testAccessOfTheReadersOfTheAttachedDocument() {
        createSimpleModel();
        String id = startWorkflow();
        txFeature.nextTransaction();

        CoreSession john = CoreInstance.getCoreSession(session.getRepositoryName(),
                new UserPrincipal("john", List.of(), false, false));
        assertThrows(DocumentSecurityException.class, () -> WorkflowHistoryReader.read(john, id));

        grantRead(file.getRef(), "john");
        assertEquals(List.of("start#0>step(toStep)=1", "step#0>end(toEnd)=1"),
                transitions(WorkflowHistoryReader.read(john, id)));
    }

    @Test
    public void testAccessOfTheReadersOfTheWorkflowInstance() {
        createSimpleModel();
        String id = startWorkflow();
        txFeature.nextTransaction();

        CoreSession jane = CoreInstance.getCoreSession(session.getRepositoryName(),
                new UserPrincipal("jane", List.of(), false, false));
        assertThrows(DocumentSecurityException.class, () -> WorkflowHistoryReader.read(jane, id));

        grantRead(new IdRef(id), "jane");
        assertEquals(3, WorkflowHistoryReader.read(jane, id).nodes().size());
    }

    @Test
    public void testAccessOfAdministrators() {
        createSimpleModel();
        String id = startWorkflow();
        txFeature.nextTransaction();

        CoreSession admin = CoreInstance.getCoreSession(session.getRepositoryName(),
                new UserPrincipal("boss", List.of(), false, true));
        assertEquals(2, WorkflowHistoryReader.read(admin, id).transitions().size());
    }

    @Test
    public void testInvalidIds() {
        assertThrows(DocumentNotFoundException.class,
                () -> WorkflowHistoryReader.read(session, "00000000-0000-0000-0000-000000000000"));
        // a document that is not a workflow instance
        assertThrows(DocumentNotFoundException.class, () -> WorkflowHistoryReader.read(session, file.getId()));
        NuxeoException e = assertThrows(NuxeoException.class, () -> WorkflowHistoryReader.read(session, " "));
        assertEquals(400, e.getStatusCode());

        // workflow models (draft, then validated) and steps are not workflow instances
        createSimpleModel();
        assertThrows(DocumentNotFoundException.class, () -> WorkflowHistoryReader.read(session, model.getId()));
        String id = startWorkflow();
        assertThrows(DocumentNotFoundException.class, () -> WorkflowHistoryReader.read(session, model.getId()));
        String stepId = session.getDocument(new IdRef(id))
                               .getAdapter(GraphRoute.class)
                               .getNode("step")
                               .getDocument()
                               .getId();
        assertThrows(DocumentNotFoundException.class, () -> WorkflowHistoryReader.read(session, stepId));
        assertEquals(3, WorkflowHistoryReader.read(session, id).nodes().size());
    }

    private static List<JsonNode> sortedBySource(JsonNode array) {
        List<JsonNode> list = new ArrayList<>();
        array.forEach(list::add);
        list.sort(Comparator.comparing((JsonNode n) -> n.get("source").asText()));
        return list;
    }
}
