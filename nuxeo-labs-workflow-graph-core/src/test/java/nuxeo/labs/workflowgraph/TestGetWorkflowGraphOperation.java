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
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import jakarta.inject.Inject;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.nuxeo.ecm.automation.AutomationService;
import org.nuxeo.ecm.automation.OperationContext;
import org.nuxeo.ecm.core.api.Blob;
import org.nuxeo.ecm.core.api.CoreSession;
import org.nuxeo.ecm.core.api.DocumentModel;
import org.nuxeo.ecm.core.api.DocumentNotFoundException;
import org.nuxeo.ecm.core.api.IdRef;
import org.nuxeo.ecm.core.api.security.ACE;
import org.nuxeo.ecm.core.api.security.SecurityConstants;
import org.nuxeo.ecm.core.test.CoreFeature;
import org.nuxeo.ecm.core.test.annotations.Granularity;
import org.nuxeo.ecm.core.test.annotations.RepositoryConfig;
import org.nuxeo.ecm.platform.routing.core.impl.GraphNode;
import org.nuxeo.ecm.platform.routing.core.impl.GraphRoute;
import org.nuxeo.ecm.platform.routing.core.impl.jsongraph.JsonGraphRoute;
import org.nuxeo.runtime.test.runner.Features;
import org.nuxeo.runtime.test.runner.FeaturesRunner;
import org.nuxeo.runtime.transaction.TransactionHelper;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * {@link GetWorkflowGraphOperation}: the workflow, its graph and its history (written by the recorder) in one call, the
 * permissions, and the unknown workflows.
 *
 * @since 2025.3
 */
@RunWith(FeaturesRunner.class)
@Features(WorkflowGraphFeature.class)
@RepositoryConfig(cleanup = Granularity.METHOD)
public class TestGetWorkflowGraphOperation extends AbstractWorkflowHistoryTest {

    protected static final ObjectMapper MAPPER = new ObjectMapper();

    // can read the documents it is given READ on, not the workflow instances
    protected static final String READER = "jdoe";

    @Inject
    protected AutomationService automation;

    @Inject
    protected CoreFeature coreFeature;

    @Test
    public void testWorkflowGraphAndHistory() throws Exception {
        createSimpleModel();
        String id = startWorkflow();

        JsonNode json = run(session, id, null);
        assertEquals(List.of("workflow", "graph", "history"), fieldNames(json));
        // the fields of GET /api/v1/workflow/{id} used by the graph, never the attached documents
        JsonNode workflow = json.get("workflow");
        assertEquals(List.of("id", "name", "title", "state", "workflowModelName"), fieldNames(workflow));
        assertEquals(id, workflow.get("id").asText());
        assertEquals(MODEL_NAME, workflow.get("title").asText());
        assertEquals(MODEL_NAME, workflow.get("workflowModelName").asText());
        assertEquals("done", workflow.get("state").asText());
        // the graph of GET /api/v1/workflow/{id}/graph
        var route = session.getDocument(new IdRef(id)).getAdapter(GraphRoute.class);
        assertEquals(MAPPER.valueToTree(JsonGraphRoute.getGraphElementsAsMap(route, Locale.ENGLISH)),
                json.get("graph"));
        assertEquals(3, json.get("graph").get("nodes").size());
        assertEquals(2, json.get("graph").get("transitions").size());
        // the format read by the graph dialog (LWG.normalizeHistory)
        assertEquals(MAPPER.readTree("""
                {
                  "nodes": [
                    { "id": "start", "completed": true, "count": 1 },
                    { "id": "step", "completed": true, "count": 1 },
                    { "id": "end", "completed": true, "count": 1 }
                  ],
                  "transitions": [
                    { "source": "start", "index": 0, "name": "toStep", "target": "step", "count": 1 },
                    { "source": "step", "index": 0, "name": "toEnd", "target": "end", "count": 1 }
                  ],
                  "truncated": false
                }
                """), json.get("history"));
    }

    @Test
    public void testRunningWorkflowWithLoop() throws Exception {
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

        JsonNode json = run(session, id, "fr-FR");
        assertEquals("running", json.get("workflow").get("state").asText());
        assertEquals("suspended", stateOf(json, "review"));
        assertEquals(List.of("start(1)", "start#0(toReview)>review(1)"), history(json));

        resume(id, "review", "reject");
        resume(id, "review", "reject");
        assertEquals(List.of("start(1)", "review(2)", "start#0(toReview)>review(1)", "review#0(reject)>review(2)"),
                history(run(session, id, null)));

        resume(id, "review", "validate");
        assertEquals(List.of("start(1)", "review(3)", "end(1)", "start#0(toReview)>review(1)",
                "review#0(reject)>review(2)", "review#1(validate)>end(1)"), history(run(session, id, null)));
    }

    @Test
    public void testOtherWorkflowsOfTheDocumentAreIgnored() throws Exception {
        createReviewModel();
        String done = startWorkflow();
        resume(done, "review", "validate");
        String running = startWorkflow();

        // both recorded on the same document
        assertEquals(List.of("end", "review#0(validate)>end", "start#0(toReview)>review"),
                recorded(file.getId(), done));
        assertEquals(List.of("start#0(toReview)>review"), recorded(file.getId(), running));

        assertEquals(List.of("start(1)", "start#0(toReview)>review(1)"), history(run(session, running, null)));
        assertEquals(List.of("start(1)", "review(1)", "end(1)", "start#0(toReview)>review(1)",
                "review#0(validate)>end(1)"), history(run(session, done, null)));
    }

    @Test
    public void testReaderOfTheDocument() throws Exception {
        createSimpleModel();
        String id = startWorkflow();
        grantRead(file, READER);
        CoreSession reader = coreFeature.getCoreSession(READER);
        // cannot read the workflow instance (GET /api/v1/workflow/{id} would answer 403)
        assertFalse(reader.exists(new IdRef(id)));
        assertTrue(reader.exists(file.getRef()));

        JsonNode json = run(reader, id, null);
        assertEquals(MODEL_NAME, json.get("workflow").get("title").asText());
        assertEquals(MODEL_NAME, json.get("workflow").get("workflowModelName").asText());
        assertEquals(3, json.get("graph").get("nodes").size());
        assertEquals(List.of("start(1)", "step(1)", "end(1)", "start#0(toStep)>step(1)", "step#0(toEnd)>end(1)"),
                history(json));
    }

    @Test
    public void testUserWhoCannotReadTheDocuments() throws Exception {
        createSimpleModel();
        String id = startWorkflow();
        CoreSession stranger = coreFeature.getCoreSession(READER);
        assertFalse(stranger.exists(file.getRef()));

        // the graph, as Nuxeo's graph endpoint, but not the audit of the document
        JsonNode json = run(stranger, id, null);
        assertEquals(MODEL_NAME, json.get("workflow").get("workflowModelName").asText());
        assertEquals(3, json.get("graph").get("nodes").size());
        assertTrue(json.get("history").isNull());
    }

    @Test
    public void testFirstAttachedDocumentThatCanBeRead() throws Exception {
        var other = session.createDocument(session.createDocumentModel("/", "other", "File"));
        createSimpleModel();
        String id = startWorkflow(List.of(file.getId(), other.getId()));
        grantRead(other, READER);

        JsonNode json = run(coreFeature.getCoreSession(READER), id, null);
        assertEquals(List.of("start(1)", "step(1)", "end(1)", "start#0(toStep)>step(1)", "step#0(toEnd)>end(1)"),
                history(json));
    }

    @Test
    public void testDeletedAttachedDocumentIsSkipped() throws Exception {
        var other = session.createDocument(session.createDocumentModel("/", "other", "File"));
        createSimpleModel();
        String id = startWorkflow(List.of(file.getId(), other.getId()));
        session.removeDocument(file.getRef());
        session.save();
        List<String> expected = List.of("start(1)", "step(1)", "end(1)", "start#0(toStep)>step(1)",
                "step#0(toEnd)>end(1)");

        // Nuxeo removes it from the attached documents after the commit, skipped until then
        txFeature.nextTransaction();
        var operation = new GetWorkflowGraphOperation();
        operation.session = session;
        operation.workflowId = id;
        WorkflowHistory history = operation.readHistory(List.of(file.getId(), other.getId()));
        assertEquals(expected, describeHistory(MAPPER.valueToTree(history)));
        assertNull(operation.readHistory(List.of(file.getId())));

        assertEquals(expected, history(run(session, id, null)));
    }

    @Test
    public void testWorkflowWithoutAttachedDocument() throws Exception {
        createSimpleModel();
        String id = startWorkflow(List.of());

        JsonNode json = run(session, id, null);
        assertEquals(3, json.get("graph").get("nodes").size());
        assertTrue(json.get("history").isNull());
    }

    @Test
    public void testNotAWorkflow() throws Exception {
        createReviewModel();
        String id = startWorkflow();
        String stepId = session.getChild(new IdRef(id), "review").getId();
        CoreSession reader = coreFeature.getCoreSession(READER);

        // the privileged session reads workflows only, any other id is unknown, whether it exists or not
        for (String unknown : List.of(file.getId(), stepId, "00000000-0000-0000-0000-000000000000", "not-an-id", "")) {
            for (CoreSession user : List.of(session, reader)) {
                var e = assertThrows(DocumentNotFoundException.class, () -> run(user, unknown, null));
                assertTrue(e.getMessage(), e.getMessage().contains("Unknown workflow: " + unknown));
                // the failed operation marked the transaction rollback-only, as in a request
                assertTrue(TransactionHelper.isTransactionMarkedRollback());
                TransactionHelper.commitOrRollbackTransaction();
                TransactionHelper.startTransaction();
            }
        }
    }

    @Test
    public void testLocale() {
        assertEquals(Locale.ENGLISH, GetWorkflowGraphOperation.toLocale(null));
        assertEquals(Locale.ENGLISH, GetWorkflowGraphOperation.toLocale(" "));
        assertEquals(Locale.ENGLISH, GetWorkflowGraphOperation.toLocale("@@"));
        assertEquals(Locale.FRENCH, GetWorkflowGraphOperation.toLocale("fr"));
        assertEquals(Locale.FRANCE, GetWorkflowGraphOperation.toLocale("fr-FR"));
        assertEquals(Locale.FRANCE, GetWorkflowGraphOperation.toLocale(" fr_FR "));
    }

    /** Runs the operation as the user of the session, once the audit is written, and returns its JSON. */
    protected JsonNode run(CoreSession userSession, String workflowId, String language) throws Exception {
        txFeature.nextTransaction();
        Map<String, Object> params = new HashMap<>();
        params.put("workflowId", workflowId);
        if (language != null) {
            params.put("language", language);
        }
        try (var ctx = new OperationContext(userSession)) {
            var blob = (Blob) automation.run(ctx, GetWorkflowGraphOperation.ID, params);
            assertEquals("application/json", blob.getMimeType());
            return MAPPER.readTree(blob.getString());
        }
    }

    /** Describes the history of the JSON returned by the operation, see {@link #describeHistory(JsonNode)}. */
    protected static List<String> history(JsonNode json) {
        assertFalse(json.get("history").get("truncated").asBoolean());
        return describeHistory(json.get("history"));
    }

    /** Describes a history: "step(count)" per step, then "source#index(name)>target(count)" per transition. */
    protected static List<String> describeHistory(JsonNode history) {
        List<String> result = new ArrayList<>();
        history.get("nodes").forEach(n -> {
            assertTrue(n.get("completed").asBoolean());
            result.add("%s(%d)".formatted(n.get("id").asText(), n.get("count").asInt()));
        });
        history.get("transitions")
               .forEach(t -> result.add("%s#%d(%s)>%s(%d)".formatted(t.get("source").asText(), t.get("index").asInt(),
                       t.get("name").asText(), t.get("target").asText(), t.get("count").asInt())));
        return result;
    }

    protected static List<String> fieldNames(JsonNode json) {
        return json.properties().stream().map(Map.Entry::getKey).toList();
    }

    protected static String stateOf(JsonNode json, String nodeId) {
        for (JsonNode node : json.get("graph").get("nodes")) {
            if (nodeId.equals(node.get("id").asText())) {
                return node.get("state").asText();
            }
        }
        throw new AssertionError("No step " + nodeId);
    }

    protected void grantRead(DocumentModel doc, String user) {
        var acp = doc.getACP();
        acp.getOrCreateACL().add(new ACE(user, SecurityConstants.READ, true));
        session.setACP(doc.getRef(), acp, true);
        session.save();
    }
}
