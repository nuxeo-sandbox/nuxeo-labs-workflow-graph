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

import java.io.IOException;

import org.nuxeo.ecm.automation.core.Constants;
import org.nuxeo.ecm.automation.core.annotations.Context;
import org.nuxeo.ecm.automation.core.annotations.Operation;
import org.nuxeo.ecm.automation.core.annotations.OperationMethod;
import org.nuxeo.ecm.automation.core.annotations.Param;
import org.nuxeo.ecm.core.api.Blob;
import org.nuxeo.ecm.core.api.Blobs;
import org.nuxeo.ecm.core.api.CoreSession;

/**
 * Returns the history of a graph workflow instance as JSON, used by the workflow graph of Web UI to mark the steps
 * already done and the transitions already followed. See {@link WorkflowHistory} for the format and
 * {@link WorkflowHistoryReader#read(CoreSession, String)} for the access rules.
 *
 * @since 2025.2
 */
@Operation(id = GetWorkflowHistoryOp.ID, category = Constants.CAT_WORKFLOW, label = "Labs Workflow Graph: Get History",
        description = "Returns the history of a graph workflow instance as JSON: the steps that started at least once "
                + "(id, completed, starts) and the transitions followed since nuxeo-labs-workflow-graph is installed "
                + "(source, index, name, target, count). Allowed to administrators and to the users who can read "
                + "the workflow instance or one of its attached documents.")
public class GetWorkflowHistoryOp {

    public static final String ID = "LabsWorkflowGraph.GetHistory";

    @Context
    protected CoreSession session;

    @Param(name = "workflowId", description = "Id of the workflow instance")
    protected String workflowId;

    @OperationMethod
    public Blob run() throws IOException {
        return Blobs.createJSONBlobFromValue(WorkflowHistoryReader.read(session, workflowId));
    }
}
