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

import static org.junit.Assert.assertTrue;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.nuxeo.ecm.core.api.IdRef;
import org.nuxeo.ecm.platform.routing.api.DocumentRoute;
import org.nuxeo.runtime.test.runner.Deploy;
import org.nuxeo.runtime.test.runner.Features;
import org.nuxeo.runtime.test.runner.FeaturesRunner;

/**
 * The recorder disabled as documented in the README (or a workflow run before the package was installed): the
 * workflow runs, nothing is recorded.
 *
 * @since 2025.2
 */
@RunWith(FeaturesRunner.class)
@Features(WorkflowGraphFeature.class)
@Deploy("nuxeo.labs.workflowgraph.nuxeo-labs-workflow-graph-core:test-recorder-disabled-contrib.xml")
public class TestWorkflowHistoryWithoutRecorder extends AbstractWorkflowHistoryTest {

    @Test
    public void testNothingRecorded() {
        createSimpleModel();
        String id = startWorkflow();

        assertTrue(session.getDocument(new IdRef(id)).getAdapter(DocumentRoute.class).isDone());
        assertTrue(entries(file.getId()).isEmpty());
    }
}
