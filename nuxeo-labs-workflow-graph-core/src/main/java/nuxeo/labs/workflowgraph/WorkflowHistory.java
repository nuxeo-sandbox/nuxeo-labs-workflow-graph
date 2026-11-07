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

import java.util.List;

/**
 * History of a workflow instance, returned as JSON by {@link GetWorkflowHistoryOp}. Only holds what the graph
 * displays: no actor, comment or variable.
 *
 * @param workflowId id of the workflow instance
 * @param nodes the steps that started at least once
 * @param transitions the transitions followed at least once since the recorder is installed, in the order they were
 *            first followed
 * @since 2025.2
 */
public record WorkflowHistory(String workflowId, List<Step> nodes, List<FollowedTransition> transitions) {

    public WorkflowHistory {
        nodes = List.copyOf(nodes);
        transitions = List.copyOf(transitions);
    }

    /**
     * A step that started at least once.
     *
     * @param id the id of the step ({@code rnode:nodeId}), as in the graph endpoint
     * @param completed true when the step completed at least once ({@code rnode:endDate} is set)
     * @param starts number of times the step started ({@code rnode:count}), including the current run and the runs
     *            canceled by a merge
     */
    public record Step(String id, boolean completed, long starts) {
    }

    /**
     * A transition followed at least once since the recorder is installed.
     *
     * @param source id of the step the transition leaves
     * @param index position of the transition in its step (definition order, the order of the graph endpoint)
     * @param name name of the transition
     * @param target id of the step the transition goes to
     * @param count number of times the transition was followed
     */
    public record FollowedTransition(String source, int index, String name, String target, long count) {
    }
}
