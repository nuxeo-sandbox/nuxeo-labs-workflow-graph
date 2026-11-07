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
 * Names shared by the recorder ({@link StepCompletedListener}) and the history reader
 * ({@link WorkflowHistoryReader}). They are also used in {@code OSGI-INF/lwg-audit-contrib.xml}.
 * <p>
 * The audit extended info keys are prefixed: in the OpenSearch audit backend, the extended info of every event share
 * one mapping ({@code extended.<key>}), so a generic name could clash with the key of another add-on.
 *
 * @since 2025.2
 */
public final class WorkflowHistoryConstants {

    /** Event fired on the workflow instance, and audited, each time one of its steps completes. */
    public static final String STEP_COMPLETED_EVENT = "lwgWorkflowStepCompleted";

    /** Event property and audit extended info: id of the completed step ({@code rnode:nodeId}). */
    public static final String NODE_ID_KEY = "lwgNodeId";

    /**
     * Event property and audit extended info: positions of the transitions followed when the step completed, in
     * the definition order of the step ({@code rnode:transitions}), comma separated. Empty for an end step.
     */
    public static final String TRANSITIONS_KEY = "lwgTransitions";

    /** Separator of the positions in {@link #TRANSITIONS_KEY}. */
    public static final String TRANSITIONS_SEPARATOR = ",";

    private WorkflowHistoryConstants() {
        // constants only
    }
}
