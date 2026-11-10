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

/**
 * Server side of the Nuxeo Labs Workflow Graph: records the transitions followed by graph workflows in the audit of
 * the documents attached to the workflow ({@link nuxeo.labs.workflowgraph.StepCompletedListener}). The graph dialog
 * (Web UI) reads them with the REST API ({@code GET /api/v1/id/{docId}/@audit}).
 *
 * @since 2025.2
 */
package nuxeo.labs.workflowgraph;
