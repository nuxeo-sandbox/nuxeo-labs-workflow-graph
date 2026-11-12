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

/**
 * Names of the event fired by the recorder ({@link StepCompletedListener}) and of its properties. They are also used
 * in {@code OSGI-INF/lwg-audit-contrib.xml}, and read back from the audit of the documents attached to the workflow
 * by {@link GetWorkflowGraphOperation} (see {@link WorkflowHistory}).
 * <p>
 * The event properties are stored as audit extended info under the same keys. They are prefixed: in the OpenSearch
 * audit backend, the extended info of every event share one mapping ({@code extended.<key>}), so a generic name
 * could clash with the key of another add-on, or of Nuxeo itself. Each key always holds the same type.
 *
 * @since 2025.2
 */
public final class WorkflowHistoryConstants {

    /** Event fired on each document attached to the workflow, and audited, each time a step completes. */
    public static final String STEP_COMPLETED_EVENT = "lwgWorkflowStepCompleted";

    /** Event property and audit extended info (String): id of the workflow instance. */
    public static final String WORKFLOW_ID_KEY = "lwgWorkflowId";

    /** Event property and audit extended info (String): name of the workflow model, e.g. "SerialDocumentReview". */
    public static final String MODEL_NAME_KEY = "lwgModelName";

    /** Event property and audit extended info (String): id of the completed step ({@code rnode:nodeId}). */
    public static final String NODE_ID_KEY = "lwgNodeId";

    /**
     * Event property and audit extended info (list of Long): positions of the transitions followed when the step
     * completed, in the definition order of the step ({@code rnode:transitions}), the order of the graph endpoint.
     * Empty for an end step.
     */
    public static final String TRANSITIONS_KEY = "lwgTransitions";

    /**
     * Event property and audit extended info (list of String): names of the followed transitions
     * ({@code rnode:transitions/*}/name), in the order of {@link #TRANSITIONS_KEY}.
     */
    public static final String TRANSITION_NAMES_KEY = "lwgTransitionNames";

    /**
     * Event property and audit extended info (list of String): ids of the target steps of the followed transitions,
     * in the order of {@link #TRANSITIONS_KEY}.
     */
    public static final String TARGETS_KEY = "lwgTargets";

    private WorkflowHistoryConstants() {
        // constants only
    }
}
