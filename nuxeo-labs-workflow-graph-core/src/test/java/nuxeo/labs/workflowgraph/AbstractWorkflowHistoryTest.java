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
import static nuxeo.labs.workflowgraph.WorkflowHistoryConstants.NODE_ID_KEY;
import static nuxeo.labs.workflowgraph.WorkflowHistoryConstants.STEP_COMPLETED_EVENT;
import static org.nuxeo.audit.api.LogEntryConstants.LOG_DOC_UUID;
import static org.nuxeo.audit.api.LogEntryConstants.LOG_EVENT_ID;
import static org.nuxeo.audit.service.AuditComponent.DEFAULT_AUDIT_BACKEND;
import static org.nuxeo.ecm.platform.routing.api.DocumentRoutingConstants.ATTACHED_DOCUMENTS_PROPERTY_NAME;
import static org.nuxeo.ecm.platform.routing.api.DocumentRoutingConstants.DOCUMENT_ROUTE_DOCUMENT_TYPE;
import static org.nuxeo.ecm.platform.routing.api.DocumentRoutingConstants.ROUTE_NODE_DOCUMENT_TYPE;

import java.io.Serializable;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

import jakarta.inject.Inject;

import org.junit.Before;
import org.nuxeo.audit.api.AuditQueryBuilder;
import org.nuxeo.audit.api.LogEntry;
import org.nuxeo.audit.service.AuditService;
import org.nuxeo.ecm.core.api.CoreSession;
import org.nuxeo.ecm.core.api.DocumentModel;
import org.nuxeo.ecm.core.api.DocumentRef;
import org.nuxeo.ecm.core.api.security.ACE;
import org.nuxeo.ecm.core.api.security.SecurityConstants;
import org.nuxeo.ecm.core.query.sql.model.Predicates;
import org.nuxeo.ecm.platform.routing.api.DocumentRoute;
import org.nuxeo.ecm.platform.routing.api.DocumentRoutingService;
import org.nuxeo.ecm.platform.routing.core.impl.GraphNode;
import org.nuxeo.ecm.platform.task.Task;
import org.nuxeo.ecm.platform.task.TaskService;
import org.nuxeo.runtime.api.Framework;
import org.nuxeo.runtime.test.runner.TransactionalFeature;

/**
 * Builds workflow models, runs them and reads their history.
 *
 * @since 2025.2
 */
public abstract class AbstractWorkflowHistoryTest {

    protected static final String MODEL_NAME = "lwgTestModel";

    @Inject
    protected CoreSession session;

    @Inject
    protected DocumentRoutingService routing;

    @Inject
    protected TransactionalFeature txFeature;

    // the document attached to the workflow
    protected DocumentModel file;

    protected DocumentModel model;

    @Before
    public void setUpModel() {
        routing.invalidateRouteModelsCache();
        file = session.createDocument(session.createDocumentModel("/", "file", "File"));
        model = session.createDocumentModel("/", MODEL_NAME, DOCUMENT_ROUTE_DOCUMENT_TYPE);
        model.setPropertyValue("dc:title", MODEL_NAME);
        model.setPropertyValue(ATTACHED_DOCUMENTS_PROPERTY_NAME, (Serializable) List.of(file.getId()));
        model = session.createDocument(model);
    }

    /** Creates a step of the model. */
    protected DocumentModel node(String id, Consumer<DocumentModel> setup) {
        var node = session.createDocumentModel(model.getPathAsString(), id, ROUTE_NODE_DOCUMENT_TYPE);
        node.setPropertyValue(GraphNode.PROP_NODE_ID, id);
        setup.accept(node);
        return session.createDocument(node);
    }

    /** Creates a transition to the target step, followed when the condition is true. */
    protected static Map<String, Serializable> transition(String name, String target, String condition) {
        Map<String, Serializable> transition = new HashMap<>();
        transition.put(GraphNode.PROP_TRANS_NAME, name);
        transition.put(GraphNode.PROP_TRANS_TARGET, target);
        transition.put(GraphNode.PROP_TRANS_CONDITION, condition);
        return transition;
    }

    /** Returns a condition that is true when the step is resumed with this button. */
    protected static String button(String name) {
        return "NodeVariables[\"button\"] == \"%s\"".formatted(name);
    }

    @SafeVarargs
    protected static void setTransitions(DocumentModel node, Map<String, Serializable>... transitions) {
        node.setPropertyValue(GraphNode.PROP_TRANSITIONS, (Serializable) List.of(transitions));
    }

    /** Creates the model start -> step -> end, automatic steps only. */
    protected void createSimpleModel() {
        node("start", n -> {
            n.setPropertyValue(GraphNode.PROP_START, TRUE);
            setTransitions(n, transition("toStep", "step", "true"));
        });
        node("step", n -> setTransitions(n, transition("toEnd", "end", "true")));
        node("end", n -> n.setPropertyValue(GraphNode.PROP_STOP, TRUE));
    }

    /** Validates the model, then creates and starts an instance. Returns its id. */
    protected String startWorkflow() {
        var route = model.getAdapter(DocumentRoute.class);
        if (!route.isValidated()) {
            routing.validateRouteModel(route, session);
        }
        session.save();
        String id = routing.createNewInstance(MODEL_NAME, List.of(file.getId()), session, true);
        session.save();
        return id;
    }

    /** Resumes a suspended step as if its task was completed with the button. */
    protected void resume(String workflowId, String nodeId, String buttonName) {
        routing.resumeInstance(workflowId, nodeId, new HashMap<>(), buttonName, session);
        session.save();
    }

    /** Reads the history once the audit is written (after the commit). */
    protected WorkflowHistory history(String workflowId) {
        txFeature.nextTransaction();
        return WorkflowHistoryReader.read(session, workflowId);
    }

    /** Returns the audit entries written by the recorder for the workflow instance. */
    protected List<LogEntry> recorderEntries(String workflowId) {
        txFeature.nextTransaction();
        var backend = Framework.getService(AuditService.class).getAuditBackend(DEFAULT_AUDIT_BACKEND);
        return backend.queryLogs(new AuditQueryBuilder().predicate(Predicates.eq(LOG_DOC_UUID, workflowId))
                                                        .and(Predicates.eq(LOG_EVENT_ID, STEP_COMPLETED_EVENT)));
    }

    /** Returns the steps recorded as completed (one audit entry per completion), sorted, duplicates kept. */
    protected List<String> recordedSteps(String workflowId) {
        return recorderEntries(workflowId).stream()
                                          .map(e -> e.<String> getExtendedValue(NODE_ID_KEY))
                                          .sorted()
                                          .toList();
    }

    /** Returns the open tasks of a step. */
    protected List<Task> openTasks(String workflowId, String nodeId) {
        return Framework.getService(TaskService.class).getAllTaskInstances(workflowId, nodeId, session);
    }

    /** Grants READ to the user on the document, then commits. */
    protected void grantRead(DocumentRef ref, String username) {
        var acp = session.getACP(ref);
        acp.getOrCreateACL("lwgtest").add(new ACE(username, SecurityConstants.READ, true));
        session.setACP(ref, acp, true);
        session.save();
        txFeature.nextTransaction();
    }

    /** Returns the steps of the history as sorted "id:completed:starts" strings. */
    protected static List<String> steps(WorkflowHistory history) {
        return history.nodes()
                      .stream()
                      .map(s -> "%s:%s:%d".formatted(s.id(), s.completed(), s.starts()))
                      .sorted()
                      .toList();
    }

    /** Returns the followed transitions of the history as sorted "source#index>target(name)=count" strings. */
    protected static List<String> transitions(WorkflowHistory history) {
        return history.transitions()
                      .stream()
                      .map(t -> "%s#%d>%s(%s)=%d".formatted(t.source(), t.index(), t.target(), t.name(), t.count()))
                      .sorted()
                      .toList();
    }
}
