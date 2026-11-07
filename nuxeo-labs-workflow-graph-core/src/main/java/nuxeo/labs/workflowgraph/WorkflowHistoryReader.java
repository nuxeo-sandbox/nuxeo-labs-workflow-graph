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
import static nuxeo.labs.workflowgraph.WorkflowHistoryConstants.TRANSITIONS_KEY;
import static nuxeo.labs.workflowgraph.WorkflowHistoryConstants.TRANSITIONS_SEPARATOR;
import static org.nuxeo.audit.api.LogEntryConstants.LOG_DOC_UUID;
import static org.nuxeo.audit.api.LogEntryConstants.LOG_EVENT_DATE;
import static org.nuxeo.audit.api.LogEntryConstants.LOG_EVENT_ID;
import static org.nuxeo.audit.service.AuditComponent.DEFAULT_AUDIT_BACKEND;
import static org.nuxeo.ecm.platform.routing.api.DocumentRoutingConstants.DOCUMENT_ROUTE_DOCUMENT_FACET;
import static org.nuxeo.ecm.platform.routing.core.impl.GraphNode.PROP_COUNT;
import static org.nuxeo.ecm.platform.routing.core.impl.GraphNode.PROP_NODE_END_DATE;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

import org.apache.commons.lang3.StringUtils;
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;
import org.nuxeo.audit.api.AuditQueryBuilder;
import org.nuxeo.audit.api.LogEntry;
import org.nuxeo.audit.service.AuditService;
import org.nuxeo.common.utils.ExceptionUtils;
import org.nuxeo.ecm.core.api.CoreInstance;
import org.nuxeo.ecm.core.api.CoreSession;
import org.nuxeo.ecm.core.api.DocumentNotFoundException;
import org.nuxeo.ecm.core.api.DocumentRef;
import org.nuxeo.ecm.core.api.DocumentSecurityException;
import org.nuxeo.ecm.core.api.IdRef;
import org.nuxeo.ecm.core.api.NuxeoException;
import org.nuxeo.ecm.core.api.security.SecurityConstants;
import org.nuxeo.ecm.core.query.sql.model.OrderByExprs;
import org.nuxeo.ecm.core.query.sql.model.Predicates;
import org.nuxeo.ecm.platform.routing.core.impl.GraphNode;
import org.nuxeo.ecm.platform.routing.core.impl.GraphNode.Transition;
import org.nuxeo.ecm.platform.routing.core.impl.GraphRoute;
import org.nuxeo.runtime.api.Framework;

/**
 * Reads the history of a graph workflow instance: the steps from their documents ({@code rnode:endDate},
 * {@code rnode:count}), the followed transitions from the audit entries written by {@link StepCompletedListener}.
 *
 * @since 2025.2
 */
public class WorkflowHistoryReader {

    private static final Logger log = LogManager.getLogger(WorkflowHistoryReader.class);

    /** Maximum number of audit entries read for one workflow instance (one entry per completed step). */
    public static final int MAX_AUDIT_ENTRIES = 10_000;

    /** A transition of a step: id of the step and position of the transition in the step. */
    protected record Key(String nodeId, int index) {
    }

    protected WorkflowHistoryReader() {
        // static methods only
    }

    /**
     * Returns the history of a workflow instance.
     * <p>
     * Allowed to administrators and to the users who can read the workflow instance or one of its attached documents
     * (in Web UI, the readers of a document can open the graph of its workflows). The data is then read with a
     * system session: the steps and the audit of a workflow instance are not readable by every participant. When the
     * audit cannot be read, the steps are still returned, without the followed transitions.
     *
     * @throws NuxeoException (400) when the id is blank
     * @throws DocumentNotFoundException when there is no workflow instance with this id (a workflow model is not an
     *             instance)
     * @throws DocumentSecurityException when the user is not allowed
     */
    public static WorkflowHistory read(CoreSession session, String workflowId) {
        if (StringUtils.isBlank(workflowId)) {
            throw new NuxeoException("The id of the workflow instance is required", 400);
        }
        var ref = new IdRef(workflowId);
        List<String> attachedDocumentIds = CoreInstance.doPrivileged(session,
                (CoreSession s) -> getRoute(s, ref).getAttachedDocuments());
        if (!canRead(session, ref, attachedDocumentIds)) {
            throw new DocumentSecurityException(
                    "Not allowed to read the history of the workflow instance " + workflowId);
        }
        return CoreInstance.doPrivileged(session, (CoreSession s) -> build(getRoute(s, ref), workflowId));
    }

    protected static GraphRoute getRoute(CoreSession session, IdRef ref) {
        var doc = session.exists(ref) ? session.getDocument(ref) : null;
        var route = doc != null && doc.hasFacet(DOCUMENT_ROUTE_DOCUMENT_FACET)
                ? doc.getAdapter(GraphRoute.class)
                : null;
        // a workflow model (draft or validated) has the same facet, but it is not an instance
        if (route == null || route.isDraft() || route.isValidated()) {
            throw new DocumentNotFoundException("No workflow instance with the id " + ref.reference());
        }
        return route;
    }

    protected static boolean canRead(CoreSession session, DocumentRef ref, List<String> attachedDocumentIds) {
        if (session.getPrincipal().isAdministrator() || hasRead(session, ref)) {
            return true;
        }
        return attachedDocumentIds != null
                && attachedDocumentIds.stream().filter(StringUtils::isNotBlank).anyMatch(id -> hasRead(session,
                        new IdRef(id)));
    }

    protected static boolean hasRead(CoreSession session, DocumentRef ref) {
        try {
            return session.exists(ref) && session.hasPermission(ref, SecurityConstants.READ);
        } catch (DocumentNotFoundException e) {
            return false;
        }
    }

    protected static WorkflowHistory build(GraphRoute route, String workflowId) {
        List<WorkflowHistory.Step> steps = new ArrayList<>();
        Map<String, GraphNode> nodes = new HashMap<>();
        for (var node : route.getNodes()) {
            nodes.put(node.getId(), node);
            var doc = node.getDocument();
            boolean completed = doc.getPropertyValue(PROP_NODE_END_DATE) != null;
            long starts = doc.getPropertyValue(PROP_COUNT) instanceof Number n ? n.longValue() : 0;
            if (completed || starts > 0) {
                steps.add(new WorkflowHistory.Step(node.getId(), completed, starts));
            }
        }
        return new WorkflowHistory(workflowId, steps, followedTransitions(nodes, workflowId));
    }

    /** Counts the transitions found in the audit entries, in the order they were first followed. */
    protected static List<WorkflowHistory.FollowedTransition> followedTransitions(Map<String, GraphNode> nodes,
            String workflowId) {
        Map<Key, Long> counts = new LinkedHashMap<>();
        for (LogEntry entry : readEntries(workflowId)) {
            Map<String, Object> extended = entry.getExtended();
            if (extended == null) {
                continue;
            }
            String nodeId = Objects.toString(extended.get(NODE_ID_KEY), null);
            String positions = Objects.toString(extended.get(TRANSITIONS_KEY), null);
            if (StringUtils.isBlank(nodeId) || StringUtils.isBlank(positions)) {
                continue;
            }
            for (String position : positions.split(TRANSITIONS_SEPARATOR)) {
                try {
                    counts.merge(new Key(nodeId, Integer.parseInt(position.trim())), 1L, Long::sum);
                } catch (NumberFormatException e) {
                    log.debug("Invalid transition position {} in the audit of workflow {}", position, workflowId);
                }
            }
        }
        List<WorkflowHistory.FollowedTransition> result = new ArrayList<>(counts.size());
        counts.forEach((key, count) -> {
            var node = nodes.get(key.nodeId());
            List<Transition> transitions = node == null ? List.of() : node.getOutputTransitions();
            if (key.index() < 0 || key.index() >= transitions.size()) {
                log.debug("Unknown transition {} of step {} in the audit of workflow {}", key.index(), key.nodeId(),
                        workflowId);
                return;
            }
            var t = transitions.get(key.index());
            result.add(new WorkflowHistory.FollowedTransition(key.nodeId(), key.index(), t.id, t.target, count));
        });
        return result;
    }

    protected static List<LogEntry> readEntries(String workflowId) {
        var query = new AuditQueryBuilder().predicate(Predicates.eq(LOG_DOC_UUID, workflowId))
                                           .and(Predicates.eq(LOG_EVENT_ID, STEP_COMPLETED_EVENT))
                                           .order(OrderByExprs.asc(LOG_EVENT_DATE))
                                           .limit(MAX_AUDIT_ENTRIES);
        List<LogEntry> entries;
        try {
            var backend = Framework.getService(AuditService.class).getAuditBackend(DEFAULT_AUDIT_BACKEND);
            entries = backend.queryLogs(query);
        } catch (RuntimeException e) {
            // an interrupt is never swallowed
            ExceptionUtils.checkInterrupt(e);
            // no audit backend, backend not reachable...: the steps, read from their documents, are still returned
            log.error("Cannot read the audit: the followed transitions of workflow {} are not returned", workflowId,
                    e);
            return List.of();
        }
        if (entries.size() >= MAX_AUDIT_ENTRIES) {
            log.warn("Workflow {} has more than {} completed steps, the most recent ones are ignored", workflowId,
                    MAX_AUDIT_ENTRIES);
        }
        return entries;
    }
}
