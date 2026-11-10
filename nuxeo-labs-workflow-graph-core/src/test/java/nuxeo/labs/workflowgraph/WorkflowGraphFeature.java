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

import org.nuxeo.audit.test.AuditFeature;
import org.nuxeo.ecm.automation.test.AutomationFeature;
import org.nuxeo.runtime.test.runner.Deploy;
import org.nuxeo.runtime.test.runner.Features;
import org.nuxeo.runtime.test.runner.RunnerFeature;

/**
 * Workflow engine, audit (in-memory backend by default) and this bundle.
 *
 * @since 2025.2
 */
// AuditFeature must come before CoreFeature (pulled by AutomationFeature)
@Features({ AuditFeature.class, AutomationFeature.class })
@Deploy("org.nuxeo.ecm.platform.content.template")
@Deploy("org.nuxeo.ecm.platform.task.api")
@Deploy("org.nuxeo.ecm.platform.task.core")
@Deploy("org.nuxeo.ecm.platform.routing.api")
@Deploy("org.nuxeo.ecm.platform.routing.core")
@Deploy("nuxeo.labs.workflowgraph.nuxeo-labs-workflow-graph-core")
public class WorkflowGraphFeature implements RunnerFeature {
}
