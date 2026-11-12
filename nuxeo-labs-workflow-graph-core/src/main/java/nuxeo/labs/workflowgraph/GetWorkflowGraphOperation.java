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

import static nuxeo.labs.workflowgraph.WorkflowHistoryConstants.STEP_COMPLETED_EVENT;
import static nuxeo.labs.workflowgraph.WorkflowHistoryConstants.WORKFLOW_ID_KEY;
import static org.nuxeo.audit.api.LogEntryConstants.LOG_DOC_UUID;
import static org.nuxeo.audit.api.LogEntryConstants.LOG_EVENT_DATE;
import static org.nuxeo.audit.api.LogEntryConstants.LOG_EVENT_ID;
import static org.nuxeo.audit.api.LogEntryConstants.LOG_EXTENDED;
import static org.nuxeo.audit.api.LogEntryConstants.LOG_ID;
import static org.nuxeo.audit.service.AuditBackend.Capability.EXTENDED_INFO_SEARCH;
import static org.nuxeo.audit.service.AuditComponent.DEFAULT_AUDIT_BACKEND;
import static org.nuxeo.ecm.platform.routing.api.DocumentRoutingConstants.DOCUMENT_ROUTE_DOCUMENT_FACET;
import static org.nuxeo.ecm.platform.routing.api.DocumentRoutingConstants.OPERATION_CATEGORY_ROUTING_NAME;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.Function;

import org.apache.commons.lang3.StringUtils;
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;
import org.nuxeo.audit.api.AuditQueryBuilder;
import org.nuxeo.audit.api.LogEntry;
import org.nuxeo.audit.service.AuditBackend;
import org.nuxeo.audit.service.AuditService;
import org.nuxeo.common.utils.ExceptionUtils;
import org.nuxeo.ecm.automation.core.annotations.Context;
import org.nuxeo.ecm.automation.core.annotations.Operation;
import org.nuxeo.ecm.automation.core.annotations.OperationMethod;
import org.nuxeo.ecm.automation.core.annotations.Param;
import org.nuxeo.ecm.core.api.Blob;
import org.nuxeo.ecm.core.api.Blobs;
import org.nuxeo.ecm.core.api.CoreInstance;
import org.nuxeo.ecm.core.api.CoreSession;
import org.nuxeo.ecm.core.api.DocumentNotFoundException;
import org.nuxeo.ecm.core.api.IdRef;
import org.nuxeo.ecm.core.api.NuxeoException;
import org.nuxeo.ecm.core.api.security.SecurityConstants;
import org.nuxeo.ecm.core.query.sql.model.OrderByExprs;
import org.nuxeo.ecm.core.query.sql.model.Predicates;
import org.nuxeo.ecm.platform.routing.core.impl.GraphRoute;
import org.nuxeo.ecm.platform.routing.core.impl.jsongraph.JsonGraphRoute;
import org.nuxeo.runtime.api.Framework;
import org.nuxeo.runtime.transaction.TransactionHelper;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * Returns, in one call, what the graph dialog draws: the workflow, its graph and its history.
 * <p>
 * The JSON blob returned holds:
 * <ul>
 * <li>{@code workflow}: {@code id}, {@code name}, {@code title}, {@code state} and {@code workflowModelName}, as in
 * {@code GET /api/v1/workflow/{id}};</li>
 * <li>{@code graph}: {@code nodes} and {@code transitions}, as in {@code GET /api/v1/workflow/{id}/graph};</li>
 * <li>{@code history}: the steps done and the transitions followed (see {@link WorkflowHistory}), read from the audit
 * of the first document attached to the workflow that the user can read, null when there is none.</li>
 * </ul>
 * <b>Permissions.</b> As Nuxeo's graph endpoint does, the workflow is read with a privileged session, so the users who
 * only read the attached documents (and not the workflow instance) get its title and model name too. Only a document
 * with the {@code DocumentRoute} facet is read this way: any other id is answered as an unknown workflow. The ids of
 * the attached documents are never returned: they are only used to find a document that the user can read
 * ({@code READ}, checked with the user's session), whose audit holds the history, as Web UI's History tab requires.
 * <p>
 * Failures: an unknown workflow raises a {@link DocumentNotFoundException} (404). The history is optional: when it
 * cannot be read, the error is logged and {@code history} is null.
 *
 * @since 2025.3
 */
@Operation(id = GetWorkflowGraphOperation.ID, category = OPERATION_CATEGORY_ROUTING_NAME, label = "Get Workflow Graph",
        description = "Returns the workflow (title, model name), its graph (steps, transitions) and its history (steps"
                + " done, transitions followed, from the audit of a document attached to the workflow that the user"
                + " can read), as a JSON blob. Used by the graph dialog of the Nuxeo Labs Workflow Graph.",
        addToStudio = false)
public class GetWorkflowGraphOperation {

    public static final String ID = "LabsWorkflowGraph.GetWorkflowGraph";

    /**
     * Maximum number of audit entries read on a document, most recent first: the oldest ones are ignored (and the
     * history is flagged as truncated). It is also the largest result window of the OpenSearch audit backend.
     */
    public static final int MAX_HISTORY_ENTRIES = 10_000;

    /** Maximum number of attached documents checked to find one that the user can read. */
    public static final int MAX_DOCUMENTS_TRIED = 1_000;

    private static final Logger log = LogManager.getLogger(GetWorkflowGraphOperation.class);

    // the graph is serialized as Nuxeo does it (JsonGraphRoute uses a default ObjectMapper)
    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Context
    protected CoreSession session;

    @Param(name = "workflowId", description = "Id of the workflow instance.")
    protected String workflowId;

    @Param(name = "language", required = false, description = "Language of the labels translated by the server, e.g."
            + " \"fr\" or \"fr-FR\". English by default.")
    protected String language;

    /**
     * Data read with the privileged session: the properties of the workflow, its graph, and the ids of its attached
     * documents (never returned).
     */
    protected record WorkflowData(Map<String, Object> workflow, Map<String, Object> graph,
            List<String> attachedDocumentIds) {
    }

    @OperationMethod
    public Blob run() {
        Locale locale = toLocale(language);
        Function<CoreSession, WorkflowData> reader = s -> readWorkflow(s, workflowId, locale);
        WorkflowData data = CoreInstance.doPrivileged(session, reader);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("workflow", data.workflow());
        result.put("graph", data.graph());
        result.put("history", readHistory(data.attachedDocumentIds()));
        try {
            return Blobs.createJSONBlob(MAPPER.writeValueAsString(result));
        } catch (JsonProcessingException e) {
            throw new NuxeoException("Cannot write the graph of the workflow " + workflowId, e);
        }
    }

    /**
     * Reads the workflow with a privileged session. Throws a {@link DocumentNotFoundException} when the id is not the
     * one of a workflow (a document with the {@code DocumentRoute} facet), whether the document exists or not: the
     * privileged session never reads another document.
     */
    protected static WorkflowData readWorkflow(CoreSession privileged, String workflowId, Locale locale) {
        GraphRoute route = null;
        if (StringUtils.isNotBlank(workflowId)) {
            var ref = new IdRef(workflowId);
            if (privileged.exists(ref)) {
                var doc = privileged.getDocument(ref);
                route = doc.hasFacet(DOCUMENT_ROUTE_DOCUMENT_FACET) ? doc.getAdapter(GraphRoute.class) : null;
            }
        }
        if (route == null) {
            throw new DocumentNotFoundException("Unknown workflow: " + workflowId);
        }
        var doc = route.getDocument();
        Map<String, Object> workflow = new LinkedHashMap<>();
        workflow.put("id", doc.getId());
        workflow.put("name", route.getName());
        workflow.put("title", route.getTitle());
        workflow.put("state", doc.getCurrentLifeCycleState());
        workflow.put("workflowModelName", route.getModelName());
        // the nodes and transitions are built here: they read the steps (children of the workflow)
        Map<String, Object> graph = JsonGraphRoute.getGraphElementsAsMap(route, locale);
        List<String> attached = route.getAttachedDocuments();
        List<String> ids = attached == null ? List.of()
                : attached.stream().filter(StringUtils::isNotBlank).distinct().toList();
        return new WorkflowData(workflow, graph, ids);
    }

    /**
     * Returns the history read from the audit of the first attached document that the user can read, null when there
     * is none or when the audit cannot be read (the error is logged). As in the event service, an error is only
     * rethrown when the transaction fails anyway (interrupted thread, transaction marked rollback-only).
     */
    protected WorkflowHistory readHistory(List<String> documentIds) {
        try {
            var docId = documentIds.stream().limit(MAX_DOCUMENTS_TRIED).filter(this::canRead).findFirst();
            if (docId.isEmpty()) {
                log.debug("No attached document of the workflow {} can be read by {}: no history", workflowId,
                        session.getPrincipal().getName());
                return null;
            }
            List<LogEntry> entries = queryEntries(docId.get());
            if (entries.size() >= MAX_HISTORY_ENTRIES) {
                log.warn("More than {} history entries on the document {}, the oldest ones are ignored",
                        MAX_HISTORY_ENTRIES, docId.get());
            }
            return WorkflowHistory.fromAudit(entries, workflowId, entries.size() >= MAX_HISTORY_ENTRIES);
        } catch (RuntimeException e) {
            // an interrupt is never swallowed
            ExceptionUtils.checkInterrupt(e);
            if (TransactionHelper.isTransactionMarkedRollback()) {
                throw e;
            }
            log.error("Cannot read the history of the workflow {}", workflowId, e);
            return null;
        }
    }

    /** Returns true when the document exists and the user can read it (as required to read its audit). */
    protected boolean canRead(String docId) {
        var ref = new IdRef(docId);
        return session.exists(ref) && session.hasPermission(ref, SecurityConstants.READ);
    }

    /**
     * Returns the entries of the recorder on the document, most recent first, at most {@link #MAX_HISTORY_ENTRIES}.
     * The backends that can filter on extended info keep the entries of this workflow only; the others return the
     * entries of every workflow, filtered by {@link WorkflowHistory#fromAudit}.
     */
    protected List<LogEntry> queryEntries(String docId) {
        AuditBackend backend = Framework.getService(AuditService.class).getAuditBackend(DEFAULT_AUDIT_BACKEND);
        var query = new AuditQueryBuilder().predicate(Predicates.eq(LOG_DOC_UUID, docId))
                                           .and(Predicates.eq(LOG_EVENT_ID, STEP_COMPLETED_EVENT));
        if (backend.hasCapability(EXTENDED_INFO_SEARCH)) {
            query.and(Predicates.eq(LOG_EXTENDED + "/" + WORKFLOW_ID_KEY, workflowId));
        }
        query.orders(OrderByExprs.desc(LOG_EVENT_DATE), OrderByExprs.desc(LOG_ID)).limit(MAX_HISTORY_ENTRIES);
        return backend.queryLogs(query);
    }

    /** Returns the locale of the language (a language tag, e.g. "fr" or "fr-FR"), English by default. */
    protected static Locale toLocale(String language) {
        if (StringUtils.isNotBlank(language)) {
            var locale = Locale.forLanguageTag(language.trim().replace('_', '-'));
            if (!locale.getLanguage().isEmpty()) {
                return locale;
            }
        }
        return Locale.ENGLISH;
    }
}
