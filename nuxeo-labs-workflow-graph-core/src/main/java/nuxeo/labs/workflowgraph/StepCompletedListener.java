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
import static java.util.stream.Collectors.joining;
import static nuxeo.labs.workflowgraph.WorkflowHistoryConstants.NODE_ID_KEY;
import static nuxeo.labs.workflowgraph.WorkflowHistoryConstants.STEP_COMPLETED_EVENT;
import static nuxeo.labs.workflowgraph.WorkflowHistoryConstants.TRANSITIONS_KEY;
import static nuxeo.labs.workflowgraph.WorkflowHistoryConstants.TRANSITIONS_SEPARATOR;
import static org.nuxeo.ecm.core.api.event.CoreEventConstants.PREVIOUS_DOCUMENT_MODEL;
import static org.nuxeo.ecm.platform.routing.api.DocumentRoutingConstants.DOCUMENT_ROUTE_DOCUMENT_FACET;
import static org.nuxeo.ecm.platform.routing.api.DocumentRoutingConstants.ROUTE_NODE_DOCUMENT_TYPE;
import static org.nuxeo.ecm.platform.routing.api.DocumentRoutingConstants.ROUTING_CATEGORY;
import static org.nuxeo.ecm.platform.routing.core.impl.GraphNode.PROP_EXECUTE_ONLY_FIRST_TRANSITION;
import static org.nuxeo.ecm.platform.routing.core.impl.GraphNode.PROP_NODE_END_DATE;
import static org.nuxeo.ecm.platform.routing.core.impl.GraphNode.PROP_NODE_ID;
import static org.nuxeo.ecm.platform.routing.core.impl.GraphNode.PROP_STOP;
import static org.nuxeo.ecm.platform.routing.core.impl.GraphNode.PROP_TRANSITIONS;
import static org.nuxeo.ecm.platform.routing.core.impl.GraphNode.PROP_TRANS_NAME;
import static org.nuxeo.ecm.platform.routing.core.impl.GraphNode.PROP_TRANS_RESULT;
import static org.nuxeo.ecm.platform.routing.core.impl.GraphNode.PROP_TRANS_TARGET;

import java.io.Serializable;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import org.apache.commons.lang3.StringUtils;
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;
import org.nuxeo.common.utils.ExceptionUtils;
import org.nuxeo.ecm.core.api.ConcurrentUpdateException;
import org.nuxeo.ecm.core.api.DocumentModel;
import org.nuxeo.ecm.core.event.Event;
import org.nuxeo.ecm.core.event.EventListener;
import org.nuxeo.ecm.core.event.EventService;
import org.nuxeo.ecm.core.event.impl.DocumentEventContext;
import org.nuxeo.runtime.api.Framework;
import org.nuxeo.runtime.transaction.TransactionHelper;

/**
 * Records the transitions followed by graph workflows, which Nuxeo does not keep.
 * <p>
 * When a step completes, the workflow engine evaluates its transitions ({@code rnode:transitions/*}/result), then
 * saves the step with a new {@code rnode:endDate}. The results are reset as soon as a target step starts, so this
 * synchronous listener reads them at that save ({@code beforeDocumentModification}) and fires
 * {@link WorkflowHistoryConstants#STEP_COMPLETED_EVENT} on the workflow instance. The event is audited (see
 * {@code OSGI-INF/lwg-audit-contrib.xml}), with the id of the step and the positions of the followed transitions.
 * <p>
 * The history is a nice-to-have: an error is logged and does not break the workflow. As in the event service, an
 * error is only rethrown when the transaction fails anyway: a {@link ConcurrentUpdateException}, an interrupted
 * thread, or a transaction already marked rollback-only.
 *
 * @since 2025.2
 */
public class StepCompletedListener implements EventListener {

    private static final Logger log = LogManager.getLogger(StepCompletedListener.class);

    /**
     * Maximum length of the comment of the audit entry: the SQL audit backend stores it in a column of 1024
     * characters, and an entry that cannot be written stops the writing of the audit.
     */
    public static final int MAX_COMMENT_LENGTH = 1000;

    @Override
    public void handleEvent(Event event) {
        if (!(event.getContext() instanceof DocumentEventContext docCtx)) {
            return;
        }
        var node = docCtx.getSourceDocument();
        // called for every saved document: leave as soon as possible
        if (node == null || !ROUTE_NODE_DOCUMENT_TYPE.equals(node.getType())) {
            return;
        }
        try {
            if (isCompletion(node, docCtx)) {
                record(docCtx, node);
            }
        } catch (ConcurrentUpdateException e) {
            // never swallowed, as in the event service: the transaction fails and must be retried
            throw e;
        } catch (RuntimeException e) {
            // an interrupt is never swallowed
            ExceptionUtils.checkInterrupt(e);
            if (TransactionHelper.isTransactionMarkedRollback()) {
                // the transaction fails anyway: report the cause, as the event service does
                throw e;
            }
            log.error("Cannot record the transitions followed by the workflow step of the document {}", node.getId(),
                    e);
        }
    }

    /**
     * Returns true when the step is being saved with a new end date, which the workflow engine sets only when the
     * step completes (not when it is canceled).
     */
    protected static boolean isCompletion(DocumentModel node, DocumentEventContext docCtx) {
        var endDate = node.getProperty(PROP_NODE_END_DATE);
        if (!endDate.isDirty() || !(endDate.getValue() instanceof Calendar after)) {
            return false;
        }
        if (docCtx.getProperty(PREVIOUS_DOCUMENT_MODEL) instanceof DocumentModel previous
                && previous.getPropertyValue(PROP_NODE_END_DATE) instanceof Calendar before) {
            return before.getTimeInMillis() != after.getTimeInMillis();
        }
        return true;
    }

    protected void record(DocumentEventContext docCtx, DocumentModel node) {
        var session = docCtx.getCoreSession();
        var parentRef = node.getParentRef();
        if (session == null || parentRef == null) {
            return;
        }
        // the workflow engine runs with a system session: the workflow instance (the parent) can be read
        var route = session.getDocument(parentRef);
        if (!route.hasFacet(DOCUMENT_ROUTE_DOCUMENT_FACET)) {
            return;
        }
        var nodeId = (String) node.getPropertyValue(PROP_NODE_ID);
        List<Map<String, Serializable>> transitions = transitions(node);
        List<Integer> followed = followedTransitions(node, transitions);

        Map<String, Serializable> properties = new HashMap<>();
        properties.put(DocumentEventContext.CATEGORY_PROPERTY_KEY, ROUTING_CATEGORY);
        properties.put(DocumentEventContext.COMMENT_PROPERTY_KEY, comment(nodeId, transitions, followed));
        properties.put(NODE_ID_KEY, nodeId);
        properties.put(TRANSITIONS_KEY, followed.stream().map(String::valueOf).collect(joining(TRANSITIONS_SEPARATOR)));
        var ctx = new DocumentEventContext(session, docCtx.getPrincipal(), route);
        ctx.setProperties(properties);
        Framework.getService(EventService.class).fireEvent(ctx.newEvent(STEP_COMPLETED_EVENT));
        log.debug("Step {} of workflow {} completed, followed transitions: {}", nodeId, route.getId(), followed);
    }

    /** Returns the transitions of the step ({@code rnode:transitions}), never null. */
    @SuppressWarnings("unchecked")
    protected static List<Map<String, Serializable>> transitions(DocumentModel node) {
        var value = (List<Map<String, Serializable>>) node.getPropertyValue(PROP_TRANSITIONS);
        return value == null ? List.of() : value;
    }

    /**
     * Returns the positions of the transitions followed by the engine: those evaluated to true, only the first one
     * when the step executes only its first true transition (the ones after it are not evaluated and keep an old
     * result), none for an end step (the workflow ends there, its transitions are ignored).
     */
    protected static List<Integer> followedTransitions(DocumentModel node,
            List<Map<String, Serializable>> transitions) {
        List<Integer> followed = new ArrayList<>();
        if (TRUE.equals(node.getPropertyValue(PROP_STOP))) {
            return followed;
        }
        boolean onlyFirst = TRUE.equals(node.getPropertyValue(PROP_EXECUTE_ONLY_FIRST_TRANSITION));
        for (int i = 0; i < transitions.size(); i++) {
            if (TRUE.equals(transitions.get(i).get(PROP_TRANS_RESULT))) {
                followed.add(i);
                if (onlyFirst) {
                    break;
                }
            }
        }
        return followed;
    }

    /**
     * Returns a human readable summary, stored as the comment of the audit entry and abbreviated to
     * {@link #MAX_COMMENT_LENGTH} characters: "Task1 -> Task2 (validate), Task3 (notify)".
     */
    protected static String comment(String nodeId, List<Map<String, Serializable>> transitions,
            List<Integer> followed) {
        if (followed.isEmpty()) {
            return StringUtils.abbreviate(nodeId, MAX_COMMENT_LENGTH);
        }
        String comment = nodeId + " -> " + followed.stream().map(i -> {
            var t = transitions.get(i);
            return "%s (%s)".formatted(t.get(PROP_TRANS_TARGET), t.get(PROP_TRANS_NAME));
        }).collect(joining(", "));
        return StringUtils.abbreviate(comment, MAX_COMMENT_LENGTH);
    }
}
