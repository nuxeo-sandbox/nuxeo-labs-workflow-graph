# Possible evolution: workflow history records (`LwgWorkflowHistory`)

> **Status: not implemented.** This is a possible future improvement, studied and specified with the user on
> 2026-11-11. For now the plugin stays "light" on the server side: the 2025.2 feature set (step recorder + graph
> dialog). This document gathers the findings, the decisions and the implementation plan, so that a later session
> can start without re-checking the Nuxeo and Web UI sources. Check the line numbers again if the Nuxeo hotfix
> level changed a lot (see section 3 for the versions read).

## 1. Context and goal

What exists today (2025.2):

- Java bundle `nuxeo-labs-workflow-graph-core`, class `StepCompletedListener`: a synchronous
  `beforeDocumentModification` listener on `RouteNode` documents. When a step is saved with a new `rnode:endDate`,
  it fires `lwgWorkflowStepCompleted` on each attached document. The event is audited with `lwgWorkflowId`,
  `lwgModelName`, `lwgNodeId`, `lwgTransitions` (positions), `lwgTransitionNames` and `lwgTargets`
  (`StepCompletedListener.java:95-171, 177-199`, `OSGI-INF/lwg-audit-contrib.xml`).
- Web: the dialog (`nuxeo-labs-workflow-graph-dialog.html:251-325`) loads 3 sources in parallel:
  `GET /api/v1/workflow/{id}/graph` (required), `GET /api/v1/workflow/{id}` (optional) and
  `GET /api/v1/id/{docId}/@audit` (optional, `_loadHistory` / `_readHistory`, `:337-418`), filtered by
  `LWG.historyFromAudit` (`lwg-core.js:505-555`).

Problem: a workflow can only be drawn while its instance exists. Nuxeo deletes done and canceled instances the night
after they end (3.2): the graph call then returns 404 and the dialog closes with an error. Web UI has no entry point
for ended workflows anyway (3.14).

Goal:

- For every workflow that ends (normal end, canceled, or removed while running), keep a record holding everything
  the dialog needs to draw it as it was at the end.
- Configured groups can list and open these records (a tab on documents, a global page). Other configured groups can
  delete them (manual purge).
- The feature can be turned off.

## 2. Decision summary

Take a snapshot at the end of the workflow, **in the same transaction**, into one `LwgWorkflowHistory` document per
workflow:

- When Nuxeo fires `afterWorkflowFinish` or `beforeWorkflowCanceled`, the instance and its steps still exist. A
  synchronous listener collects the same three sources as the dialog (graph, workflow entity, the recorder's audit
  entries) and stores them as JSON.
- The only catch: audit entries are written after the commit (3.5). The steps completed in the transaction that ends
  the workflow are not in the audit yet. So the recorder also keeps, for the duration of the transaction, an
  in-memory copy of what it fires (5.4).

Options studied and rejected:

| Option | Why it was rejected |
|---|---|
| Draw the current model (`GET /api/v1/workflowModel/{name}/graph`) with the audit path | Not exact when the model changed since the run. The model UUID changes at each Studio deployment (3.4), so a change cannot be detected cheaply (it would need a structural fingerprint recorded with each step). |
| Copy the graph into audit extended info | The SQL audit backend stores strings in `VARCHAR(1024)`. A longer value fails the batch and stops the audit writer (3.5). |
| Keep the instances (`nuxeo.routing.disable.cleanup.workflow.instances=true`) | Server-wide, instances, steps and tasks pile up, and it only works for workflows that end after the change. |
| Keep the followed transitions on the `RouteNode` documents (instance facet) | Works, but modifies Nuxeo's documents, and is not needed with the audit plus the in-memory buffer. |
| Write the record asynchronously, after the commit | Safer for the workflow, but the user chose the same transaction (simpler, errors are swallowed). |

## 3. Verified facts

Sources read (read-only): the Nuxeo LTS 2025 source tree (version `2025.28-SNAPSHOT` at the time) and Web UI
(`nuxeo-web-ui` and `nuxeo-elements`, 3.1.35-SNAPSHOT). Path prefixes used below:

- `NX/`: root of the Nuxeo LTS 2025 sources.
- `ROUTING/` = `NX/modules/platform/nuxeo-platform-document-routing/`.
- `RC/` = `ROUTING/nuxeo-routing-core/src/main/java/org/nuxeo/ecm/platform/routing/core/`.
- `RX/` = `ROUTING/nuxeo-routing-core/src/main/resources/`.
- `RREST/` = `ROUTING/nuxeo-routing-rest-api/src/main/java/org/nuxeo/ecm/restapi/server/`.
- `AUDIT/` = `NX/modules/platform/nuxeo-platform-audit/nuxeo-platform-audit-core/src/main/`.
- `CORE/` = `NX/modules/core/`. `TPL/` = `NX/server/nuxeo-nxr-server/src/main/resources/templates/`.
- `WUI/`: the `nuxeo-web-ui` repository. `NXE/`: the `nuxeo-elements` repository.
- Plugin paths are relative to this repository.

### 3.1 Nuxeo does not keep the followed transitions

- `rnode:transitions/*/result` is a runtime flag (`RX/schemas/route_node.xsd:65`, comment `<!-- runtime -->`). It is
  set by `evaluateTransitions()` (`RC/impl/GraphNodeImpl.java:555-584`) and reset to `false` by `starting()` of the
  target step, on all its input transitions (`GraphNodeImpl.java:275-280`). Its only reader is `canMerge()`
  (`GraphNodeImpl.java:627-644`). When the target is not a merge, it starts in the same loop
  (`RC/impl/GraphRunner.java:271-295`), so the `true` value is never even committed.
- The other step fields describe the step, mostly its last run: `rnode:count` (+1 at each start), `startDate`,
  `endDate` (never reset), `lastActor`, `button`, `tasksInfo` (reset at each start), `canceled`
  (`RX/schemas/route_node.xsd:35-47`, `GraphNodeImpl.java:275-294`).
- Step documents are never audited: `RouteNode` is a `SystemDocument` without `ForceAudit`
  (`RX/OSGI-INF/document-routing-core-types-contrib.xml:71-78`), and the audit skips such documents
  (`AUDIT/java/org/nuxeo/audit/service/AuditComponent.java:456-460`). Only `DocumentRoute` gets `ForceAudit`
  (`RX/OSGI-INF/routing-audit-contrib.xml:6-10`).
- No audited routing event holds a transition or a target (`routing-audit-contrib.xml:12-99`).
  `afterWorkflowTaskEnded` (on the task document, button in `action`) is fired before the output chain and the
  evaluation of the transitions (`GraphRunner.java:129-159`, then `:178`). Automatic steps fire nothing.
- Only the two default review workflows log business events (`Audit.LogEvent` in
  `ROUTING/nuxeo-routing-default/src/main/resources/OSGI-INF/extensions.xml:119-125, 172-176`).

### 3.2 Workflow instances are deleted soon after they end

- Nightly cleanup at 23:59 (`RX/OSGI-INF/document-routing-cleanup-contrib.xml:6-10`). It is disabled with
  `nuxeo.routing.disable.cleanup.workflow.instances=true` (`RC/listener/DocumentRoutingWorkflowInstancesCleanup.java:36,
  48-50`; documented in `NX/server/nuxeo-server-tomcat/src/main/resources/tomcat/bin/nuxeo.conf:146-152`).
- It selects done and canceled instances (`ROUTING/nuxeo-routing-api/src/main/java/org/nuxeo/ecm/platform/routing/api/DocumentRoutingConstants.java:39`),
  or all instances with `nuxeo.routing.cleanup.workflow.instances.orphan=true`
  (`RC/impl/DocumentRoutingServiceImpl.java:1014-1024`). Bulk action `garbageCollectWokflows`
  (`RC/bulk/GarbageCollectRoutesAction.java:69-80`) calls `purgeDocumentRoute` (`DocumentRoutingServiceImpl.java:713-731`):
  removed if done, canceled or orphan (no attached document exists; an empty list counts as orphan), with
  `removeDocument` and no cancel.
- Removing an instance removes its steps (its children, `document-routing-core-types-contrib.xml:60-69`).
- Other removals without cancel:
  - `DocumentRouteOrphanedListener` (asynchronous, after commit, on `documentRemoved`,
    `RC/listener/DocumentRouteOrphanedListener.java:52-91`) removes the deleted id from the routes. When the list
    becomes empty, the route is purged, **even if running**. The emptied list is never saved: the removed route
    still holds the old list (`:73-80`).
  - `DELETE /api/v1/management/workflows/orphaned` (all routes, `RREST/management/WorkflowsObject.java:48-59`).
  - `BulkRestartWorkflow` cancels, creates a new instance, then removes the old one
    (`ROUTING/nuxeo-routing-api/src/main/java/org/nuxeo/ecm/platform/routing/api/operation/BulkRestartWorkflow.java:129, 136, 141`).
  - Deleting an ancestor folder removes routes as descendants, with no event per route.
- Step states: a completed step goes back to `ready` (`GraphRunner.java:274-275`); `RUNNING_INPUT` and
  `RUNNING_OUTPUT` are never saved (`RC/impl/GraphNode.java:223-235`). Done: only the route becomes `done`, the steps
  are unchanged (other branches can stay `suspended` or `waiting`). Canceled: every step becomes `canceled`
  (`RC/impl/AbstractRunner.java:54-61`).

### 3.3 What the REST API gives

- `GET /api/v1/workflow/{id}` uses the user session: READ on the instance is needed, so readers of the attached
  document only get 403; 404 once purged (`RREST/routing/WorkflowObject.java:81-92`). JSON: `id`, `name`, `title`,
  `state`, `workflowModelName`, `initiator`, `attachedDocumentIds` (`[{ "id": … }]`), `variables`, `graphResource`
  (`RC/io/DocumentRouteWriter.java:78-123`).
- `GET /api/v1/workflow/{id}/graph`: `JsonGraphRoute extends UnrestrictedSessionRunner`
  (`RC/impl/jsongraph/JsonGraphRoute.java:49, 108-127`), so there is no permission check; 404 once purged (the error
  is raised while the response is written). JSON `{ nodes, transitions }` (`JsonGraphRoute.java:53-69`):
  - nodes: `x`, `y`, `isForkNode`, `isStartNode`, `isEndNode`, `id`, `title` (translated), `state`, `isMerge`,
    `isMultiTask`, `hasSubWorkflow` (`NodeView.java:32-67`);
  - transitions: `nodeSourceId`, `nodeTargetId`, `label` (translated), `path` (`TransitionView.java:34-47`);
  - not exposed: transition id, condition and result; step counts and dates.
- `GET /api/v1/workflowModel/{modelName}/graph` exists (`RREST/routing/WorkflowModelObject.java:59-70`), same format,
  model steps are `validated`. Models are readable by everyone (`RC/impl/DocumentRoutingTreePersister.java:124-136`).
- Instances root ACL: administrator groups Everything, `routeManagers` ReadWrite, Everyone denied
  (`DocumentRoutingTreePersister.java:110-146`); the initiator gets READ on the instance.

### 3.4 Workflow models change UUID at each Studio deployment

- `RC/persistence/RouteModelsZipImporter.java:80-93, 108-115`: MD5 of the whole zip. When it changed, the model is
  removed and imported again, so it gets a **new UUID** (the ACL is restored). This runs at every startup and every
  hot reload (`RouteModelsInitializator`).
- Nuxeo Studio builds the workflow zips anew at every build, and the zip entries carry the build time, so every
  Studio deployment gives a new MD5 and a new model UUID, even when the workflow did not change (from reading the
  code; two builds were not compared). Nuxeo's own `NuxeoArchiveWriter` never sets the entry times
  (`CORE/nuxeo-core-io/src/main/java/org/nuxeo/ecm/core/io/impl/plugins/NuxeoArchiveWriter.java:128-177`): the JDK
  `ZipOutputStream` then stamps the current time.
- So `docri:modelId` (UUID) is not stable. `getModelName()` (instance name before the first dot,
  `RC/impl/DocumentRouteImpl.java:93-97`) is stable.

### 3.5 Audit: timing, limits, access

- **Entries are written after the commit.** Nuxeo's `auditLoggerListener` (synchronous,
  `AUDIT/resources/OSGI-INF/audit-stream-contrib.xml:5-6`) keeps the entries of the transaction in a `ThreadLocal`
  and appends them to the `audit/audit` stream in `afterCompletion`, and nothing on rollback
  (`AUDIT/java/org/nuxeo/audit/listener/StreamAuditEventListener.java:60-62, 87-122`). The `auditWriter` stream
  processor then writes them in batches (`audit-stream-contrib.xml:9-16`; server defaults: 25 entries or 500 ms,
  `TPL/common-base/nuxeo.defaults:233-238`), plus about 1 s of OpenSearch refresh.
  - A query run during the transaction that ends the workflow misses that transaction's entries, and may miss
    entries committed less than about 1 s earlier.
  - Nuxeo has the same effect: `timeSinceWfStarted` is computed by querying the audit at that moment
    (`RC/impl/DocumentRouteImpl.java:59`, `RC/audit/RoutingAuditHelper.java:64-98`).
- **Querying from Java** (no permission check), as `RoutingAuditHelper.java:64-98` and the plugin tests
  (`AbstractWorkflowHistoryTest.java:166-171`) do:
  `Framework.getService(AuditService.class).getAuditBackend(AuditComponent.DEFAULT_AUDIT_BACKEND)`
  `.queryLogs(new AuditQueryBuilder().predicate(Predicates.eq(LogEntryConstants.LOG_DOC_UUID, id)).and(…))`.
  `Predicates.in(name, Iterable)` and `Predicates.gte` exist
  (`NX/modules/core/nuxeo-core-query/src/main/java/org/nuxeo/ecm/core/query/sql/model/Predicates.java:102, 134`).
  The SQL backend cannot filter on extended info
  (`NX/modules/platform/nuxeo-platform-audit/nuxeo-platform-audit-sql/src/main/java/org/nuxeo/audit/sql/SQLAuditBackend.java:138-144`):
  filter `lwgWorkflowId` in Java.
- **SQL backend limits:** extended info strings are `VARCHAR(1024)`
  (`AUDIT/java/org/nuxeo/ecm/platform/audit/impl/ExtendedInfoImpl.java:220`), other values (lists) are serialized in a
  BLOB, the comment is `VARCHAR(1024)` (`LogEntryImpl.java:304`). A longer string fails the batch, and after the
  retries the audit writer stops (`audit-stream-contrib.xml:13-16`, `continueOnFailure="false"`).
- Lists are read back without their null items (`AUDIT/java/org/nuxeo/audit/io/LogEntryJsonReader.java:101-136`):
  this is why the recorder never puts null in its lists.
- **REST `@audit`**
  (`NX/modules/platform/rest-api/nuxeo-rest-api-server/src/main/java/org/nuxeo/ecm/restapi/server/adapters/AuditAdapter.java:48-113`):
  READ on the document is required (403), 404 once the document is deleted. Filters: `eventId`, `category`,
  `principalName`, `startEventDate`, `endEventDate`. `maxPageSize` 1000
  (`AUDIT/resources/OSGI-INF/audit-pageprovider-contrib.xml:56-76`). No filter on extended info.
- Nuxeo never purges audit entries (no retention, no TTL). The in-memory backend (the default without an audit
  package) keeps only the last 10,000 entries and loses them at restart.
- `Audit.QueryWithPageProvider` is restricted to administrators by a REST binding
  (`NX/modules/platform/nuxeo-automation/nuxeo-automation-features/src/main/resources/OSGI-INF/bindings-contrib.xml:7-9`).

### 3.6 End-of-workflow events and removal hooks

**`afterWorkflowFinish` (normal end)**

- `GraphRunner.runGraph` calls `element.setDone(session)` (`GraphRunner.java:312-334`), then
  `DocumentRouteImpl.setDone` (`RC/impl/DocumentRouteImpl.java:99-115`): route to `done`, `afterRouteFinish`, then
  `afterWorkflowFinish` (`:53-75`), then `auditLogRoute` on each attached document.
- Fired by `EventFirer` (`RC/impl/EventFirer.java:39-50`): source = the route document; property
  `documentElementEventContextKey` = the route element (its cached step documents may be stale); category
  `Routing`; plus `workflowInitiator`, `workflowVariables`, `modelId`, `modelName`, and `timeSinceWfStarted` (only
  when found in the audit).
- Synchronous listeners run inline, before the `session.save()` of `GraphRunner.java:333`. The end step was already
  saved (`ending()`, then `READY`, `GraphRunner.java:271-281`), so the recorder already fired its event for it.
- Open tasks of other branches are canceled by `cleanOpenTasksOnWorkflowDone` on `afterRouteFinish` (inline,
  `RX/OSGI-INF/document-routing-listeners-contrib.xml:41-44`, `RC/listener/DocumentRoutingWorkflowDoneListener.java:41-56`).
  Their steps can stay `suspended` or `waiting`.
- A workflow that ends inside `startInstance` / `createNewInstance` fires `afterWorkflowFinish` **before**
  `afterWorkflowStarted` (`DocumentRoutingServiceImpl.java:182-183, 214-215`).

**`beforeWorkflowCanceled` (cancel)**

- `GraphRunner.cancel` (`GraphRunner.java:181-211`) fires it on the route **before anything changes** (route
  `running`, steps `ready` / `suspended` / `waiting`, tasks open), with `modelId`, `modelName`, `workflowVariables`,
  `workflowInitiator` and `pendingNodes` = the suspended steps only (`GraphRouteImpl.java:277-286`: **waiting merges
  are not included**).
- Then `super.cancel` (`AbstractRunner.java:54-61`) cancels each child, which **fires `beforeWorkflowCanceled` again
  for each step** (source = the `RouteNode`, only the element and the category), moves the steps then the route to
  `canceled`; tasks and sub-workflows are canceled last (`GraphRunner.java:205-210`).
- Callers:
  - REST `DELETE /api/v1/workflow/{id}` (`RREST/routing/WorkflowObject.java:105-131`: administrators,
    `powerusers` or the initiator; the Web UI "Abandon" button);
  - operation `WorkflowInstance.Cancel` (`RC/api/operation/CancelWorkflowOperation.java:54-64`);
  - `AttachedDocumentsChecker`, run by every `resumeInstance`, when every attached document is gone
    (`DocumentRoutingServiceImpl.java:764-792`);
  - `BulkRestartWorkflow` (`:129`, directly);
  - `GraphNodeImpl.cancelSubRoute` (`GraphNodeImpl.java:836-847`), for every step of a canceled parent,
    **including done sub-workflows**.
- `workflowCanceled` (on the attached documents, properties `wfName`, `wfId`) is fired only by the engine cancel
  (`RC/impl/DocumentRoutingEngineServiceImpl.java:54-72`), not by BulkRestart nor for sub-workflows.
- A `done` route can be canceled later (the lifecycle allows it; REST and the operation do not check the state), so
  one instance can get two "end" events.

**`aboutToRemove` (removal)**

- `CORE/nuxeo-core/src/main/java/org/nuxeo/ecm/core/api/AbstractSession.java:1544-1583`: the event (`:1556`) is fired
  before `doc.remove()` (`:1564`), **inline only** (synchronous `EventListener`s, never post-commit). The subtree (the
  steps) is still readable. The options map is new, so `DISABLE_*` context flags of the document never reach it.
- Fired for the removed root only (not for the removed descendants).
- Model re-imports fire it on `DocumentRoute` models too. Skip them by state: models are `draft` or `validated`,
  instances are `ready`, `running`, `done` or `canceled`.

### 3.7 Sessions, transactions, concurrency

- `endTask` (REST `PUT /task/{id}/{action}`, the `@task` adapter, `WorkflowTask.Complete`) runs inside
  `LockHelper.doAtomically(routeInstanceId, …)` (`DocumentRoutingServiceImpl.java:604-618`). It commits the caller's
  transaction, runs the completion in a new one and commits it
  (`CORE/nuxeo-core-api/src/main/java/org/nuxeo/ecm/core/api/LockHelper.java:68-97`).
- The completion runs in `CompleteTaskRunner.runUnrestricted()` (`DocumentRoutingServiceImpl.java:263-303`): same
  session for administrators, otherwise a system session whose `getActingUser()` is the originating user
  (`CORE/nuxeo-core-api/src/main/java/org/nuxeo/ecm/core/api/UnrestrictedSessionRunner.java:54-66, 100-134`).
- Not locked: `resumeInstance` (`Workflow.ResumeNode`, `resumeParentRoute`), escalation rules (ParallelDocumentReview's
  `forceNext` calls `Workflow.ResumeNode`), cancels, BulkRestart. Two transactions can advance the same instance
  concurrently (last writer wins, no optimistic check). A parent workflow can complete nested inside the transaction
  of its sub-workflow (the lock key is the sub-workflow id).
- All the CoreSessions of a thread share the transaction: the writes done in `CoreInstance.doPrivileged(session, …)`
  are committed or rolled back with the workflow step
  (`CORE/nuxeo-core/src/main/java/org/nuxeo/ecm/core/repository/RepositoryService.java:296-322`).
- **Not safe inside a routing listener:** `LockHelper.doAtomically` and `CoreSession.getOrCreateDocument` (both
  commit the current transaction), `ClusterService.runAtomically` (same).
- **Folder creation is not safe under concurrency:** `TreeHelper.getOrCreate` is `synchronized` within one JVM only
  (`RC/persistence/TreeHelper.java:47-82`). On PostgreSQL, the unique index `hierarchy_unique_child` turns a
  duplicate name into a `ConcurrentUpdateException` at commit (the whole transaction, workflow step included, is
  rolled back). On MongoDB, duplicates are created silently unless `childNameUniqueConstraintEnabled` is set.
- `createDocument` with an existing name: renamed by the `duplicatedNameFixer` listener (suffix `.` + timestamp,
  `CORE/nuxeo-core/src/main/resources/OSGI-INF/CoreExtensions.xml:256-261`) when the existing child is visible in the
  transaction. The storage does not check names on create.

### 3.8 Data available on the instance at the end

- Route:
  - `dc:created`: instance creation, used by Nuxeo as the workflow start time (`DocumentRoutingTreePersister.java:81-82`);
  - `docri:initiator` (`:74-76`);
  - `docri:participatingDocuments`: raw ids, can include deleted documents;
  - `docri:modelId`: model UUID, not stable (3.4);
  - the name, giving `getModelName()`;
  - `dc:title`: the raw label copied from the model (e.g. `wf.serialDocumentReview.SerialDocumentReview`);
  - sub-workflows: `docri:parentRouteInstanceId` (parent instance id) and `docri:parentRouteNodeId` (the parent
    step's **document name**, usually equal to its `rnode:nodeId`, not guaranteed) (`GraphNodeImpl.java:775-776`).
- Steps:
  - `rnode:count`, `startDate`, `endDate` (never reset: `endDate` set means completed at least once; after a loop
    restart, `endDate < startDate`);
  - `lastActor` (set only when a suspended step resumes, `GraphRunner.java:264-267`), `button` (never reset),
    `tasksInfo` (reset at each start), `subRouteInstanceId` (never cleared), the lifecycle state.
- `rnode:canceled` is incremented for every non-loop upstream step each time a merge fires
  (`GraphRunner.java:336-366`), never by a workflow cancel: it is not a "was canceled" flag.

### 3.9 Reading the graph safely from Java

- `GraphRoute.getNodes()` is computed lazily and cached with `document.getCoreSession()`
  (`RC/impl/GraphRouteImpl.java:71-122`). Read the route again from the session in the listener
  (`session.getDocument(routeRef).getAdapter(GraphRoute.class)`) instead of using the element of the event.
- `JsonGraphRoute.getGraphElementsAsMap(route, locale)` is static and read-only (`JsonGraphRoute.java:53-69`) but can
  throw:
  - `NumberFormatException` on `rnode:taskX` / `taskY` (`NodeView.java:55-56`; steps created by API have no
    coordinates);
  - `IllegalArgumentException` for an unknown target (`GraphRouteImpl.java:209-217`);
  - whatever `hasSubRoute()` throws: it evaluates `rnode:subRouteModelExpr` (`expr:` values) with an operation
    context that reads the attached documents (`GraphNodeImpl.java:745-760, 805-834`; NPE when the expression returns
    null).
- So build the snapshot graph with the plugin's own code: same fields as `NodeView` / `TransitionView`, safe parsing,
  `hasSubWorkflow` = `rnode:subRouteModelExpr` not blank or `rnode:subRouteInstanceId` set (no evaluation), and a
  try/catch per step.
- Deleted attached documents: `getAttachedDocumentModels()` skips them without exception
  (`GraphRouteImpl.java:239-252`). The raw list `docri:participatingDocuments` keeps them.

### 3.10 Labels and translations

- The graph endpoint translates step titles and transition labels on the server, with the request locale
  (`JsonGraphRoute.java:71-81`, `I18NUtils.getMessageString("messages", label, null, locale)`). A missing key
  returns the key itself.
- Some keys only exist on the server: `sdr_cancelation` is in
  `NX/modules/platform/nuxeo-platform-lang/src/main/resources/web/nuxeo.war/WEB-INF/classes/messages_en_US.properties:2887`
  (other languages in `nuxeo-platform-lang-ext`) but not in Web UI's `WUI/i18n/messages.json`. Others are in both
  (`wf.serialDocumentReview.*`, `messages.json:1532-1551`). Studio projects usually provide their labels in the Web UI
  bundle.
- The plugin translates titles and labels on the client first (`LWG.translateLabel`, `lwg-core.js:163-179`), then
  makes snake_case keys readable.
- So a snapshot must store the raw key (`dc:title`, transition `label`) **and** the server translation in English
  (`Locale.ENGLISH`). The client then tries Web UI, then the stored English text, then the readable fallback.

### 3.11 Storage, indexing, facets

- **String column type.** An `xs:string` without `maxLength` is "unconstrained"
  (`CORE/nuxeo-core-storage-sql/nuxeo-core-storage-sql/src/main/java/org/nuxeo/ecm/core/storage/sql/ColumnType.java:206-212`):
  PostgreSQL `varchar` (no limit), but **SQL Server `NVARCHAR(4000)`, Oracle `NVARCHAR2(2000)`, MySQL `VARCHAR(255)`**
  (`jdbc/dialect/DialectSQLServer.java:231-237`, `DialectOracle.java:279-285`, `DialectMySQL.java:99-109`,
  `DialectPostgreSQL.java:207-217`).
  - `maxLength` = `999999999` (`ColumnType.CLOB_LENGTH`, `ColumnType.java:42-46`) gives a CLOB / text column on every
    database.
  - VCS never changes the type of an existing column (it only logs an error): the type must be right from the first
    deployment.
  - Alternative: repository configuration `<schema><field type="largetext">…</field></schema>`
    (`TPL/common-sql/nxserver/config/default-repository-config.xml.nxftl:98-102`).
  - MongoDB: stored inline, 16 MB per document.
- **Fulltext.** All string fields are copied into the repository fulltext by default (up to 128 K characters). The
  `NotFulltextIndexable` facet **on the type** excludes the type
  (`CORE/nuxeo-core-storage/src/main/java/org/nuxeo/ecm/core/storage/FulltextConfigurationFactory.java:219-224`). As an
  instance facet, it has no effect.
- **OpenSearch.** Unknown strings are mapped as `keyword`, `ignore_above: 256`, `copy_to: all_field`
  (`NX/packages/nuxeo-search-client-opensearch1-package/src/main/resources/install/templates/opensearch1-search-client/nxserver/config/opensearch1-doc-mapping.json:19-28`).
  `NotFulltextIndexable` does not change that, and there is no supported switch per type.
  - Per event: context data `disableAutoIndexing=true`
    (`CORE/nuxeo-core-search/src/main/java/org/nuxeo/ecm/core/search/index/commands/IndexingCommandsStacker.java:102-107`).
    A full reindex still indexes the documents.
  - Other option: append a mapping with `"index": false` (only applied when the index is created).
- **Facets.**
  - `SystemDocument`: no audit unless `ForceAudit` (`AuditComponent.java:456-460`), no automatic `dc:*` (no
    `dc:created`, no `dc:creator`), no automatic versioning.
  - `HiddenInNavigation` is declared `perDocumentQuery="false"` (`CORE/nuxeo-core/src/main/resources/OSGI-INF/CoreExtensions.xml:69`):
    for repository queries it only works on the type, not as an instance facet. Documents of such a type are excluded
    by the default search, browse, tree and `@children` page providers.
  - `HiddenInCreation`: hidden from the creation menus.
  - `HiddenFolder` = `Folder` + `HiddenInNavigation` (`CoreExtensions.xml:118-120`), no subtypes. The core does not
    check subtypes on create (the subtype listener is off by default).
- **Schemas in REST lists.** Web UI loads documents with all schemas by default
  (`NXE/core/nuxeo-connection.js:162-165`). Lists choose the schemas **by schema name** (header `properties`,
  `MarshallingConstants.java:43-48` in `nuxeo-core-io`): to keep the JSON out of lists, it must be in its own schema.

### 3.12 Validation, vocabulary, permissions, configuration, startup code

- **Document references.** `ref:resolver="documentResolver"` on an `xs:list` of `xs:string` (example:
  `NX/modules/platform/nuxeo-adobe-connector-core/src/main/resources/schemas/compoundDocument.xsd:2-16`).
  - `ref:store="idOnly"` stores the bare id
    (`CORE/nuxeo-core/src/main/java/org/nuxeo/ecm/core/model/DocumentModelResolver.java:102, 143-153, 283-288`).
  - Validation (`:170-181, 207-213`) checks READ for the **current login** (system inside `doPrivileged`): a deleted or
    unknown id is invalid, a trashed document is valid.
  - `createDocument` validates all the fields of the type's schemas; `saveDocument` only the dirty ones
    (`DocumentValidationServiceImpl.java:114-138`).
  - To turn it off for one call:
    `doc.putContextData(DocumentValidationService.CTX_MAP_KEY, DocumentValidationService.Forcing.TURN_OFF)`
    (`DocumentValidationService.java:37`, `DocumentValidationServiceImpl.java:87-95`; activation in
    `CORE/nuxeo-core-api/src/main/resources/OSGI-INF/DocumentValidationService-activation.xml:7-9`). The flag stays in
    the context data of the returned model: reset it before saving it again.
- **Vocabulary.** `ref:resolver="directoryResolver" ref:directory="…"`
  (`CORE/nuxeo-core/src/main/resources/schema/dublincore.xsd:33-37`). Directory:
  `<extension target="org.nuxeo.ecm.directory.GenericDirectory" point="directories">` with
  `<directory name="…" extends="template-vocabulary"><dataFile>….csv</dataFile></directory>`
  (`AUDIT/resources/OSGI-INF/directories-contrib.xml:6-13`). `template-vocabulary` is in the component
  `org.nuxeo.ecm.directories` (`NX/modules/platform/nuxeo-platform-default-config/src/main/resources/OSGI-INF/nxdirectories-contrib.xml:8-11`):
  `<require>` it. Works with SQL and MongoDB directories. CSV columns: `id,label,obsolete`.
- **Permissions.** `removeDocument` needs `Remove` on the document and `RemoveChildren` on the parent
  (`AbstractSession.java:1431-1473`). `ReadRemove` = Read + Remove, which includes RemoveChildren
  (`CORE/nuxeo-core/src/main/resources/OSGI-INF/permissions-contrib.xml:56-59`). Administrators bypass every
  permission check.
- **Configuration.**
  - `<extension target="org.nuxeo.runtime.ConfigurationService" point="configuration">` with
    `<property name="…">${nuxeo.conf.key:=default}</property>`, expanded at registration (example:
    `CORE/nuxeo-core-bulk/src/main/resources/OSGI-INF/bulk-config.xml:53-55`).
  - A nuxeo.conf key identical to a ConfigurationService key logs a deprecation warning at every startup
    (`NX/modules/runtime/nuxeo-runtime/src/main/java/org/nuxeo/runtime/services/config/ConfigurationServiceImpl.java:120-134`):
    use different names.
  - `org.nuxeo.web.ui.*` properties are sent to the browser of **every logged-in user** as `Nuxeo.UI.config`
    (`WUI/plugin/web-ui/addon/src/main/resources/web/nuxeo.war/ui/config.jsp:32`): prefix stripped, keys split on dots
    into nested objects, values stay strings (`ConfigurationServiceImpl.java:154-199`). Read them with
    `Nuxeo.UI.config.get(path, fallback)` (`NXE/core/config.js:24-53`).
  - `list="true"` properties are turned into arrays: keep plain comma-separated strings and split them on both sides.
- **Startup code.** `RepositoryInitializationHandler` (not deprecated,
  `CORE/nuxeo-core/src/main/java/org/nuxeo/ecm/core/repository/RepositoryInitializationHandler.java:29, 57-58, 80, 96-118`)
  runs at every startup, on every node, with a system session, in a transaction. Routing does it in
  `RC/listener/RouteModelsInitializator.java:45-62` with `ClusterService.runAtomically(key, duration, pollDelay, runnable)`
  (`NX/modules/runtime/nuxeo-runtime-cluster/src/main/java/org/nuxeo/runtime/cluster/ClusterService.java:58`): it
  serializes the nodes, but every node runs the code, so it must be idempotent.

### 3.13 Uninstalling a plugin that defines a document type

- Documents whose type is no longer registered:
  - loading them throws `DocumentNotFoundException("Unknown document type")` (MongoDB:
    `CORE/nuxeo-core-storage-dbs/src/main/java/org/nuxeo/ecm/core/storage/dbs/DBSSession.java:457-462`; VCS:
    `CORE/nuxeo-core-storage-sql/nuxeo-core-storage-sql/src/main/java/org/nuxeo/ecm/core/storage/sql/coremodel/SQLSession.java:465-469`);
  - they are skipped by `getChildren`, never returned by NXQL, excluded from reindexing and bulk actions;
  - their data stays in the storage (reinstalling the plugin brings them back).
- Deleting their parent folder: VCS **throws** (each descendant is loaded, `storage/sql/SessionImpl.java:878-901`);
  MongoDB deletes the folder and leaves the orphans in the database.
- A container of the standard `HiddenFolder` type stays readable after the uninstall.
- So: purge every record before uninstalling.

### 3.14 Web UI facts

- `nuxeo-workflow-graph` is only used by `nuxeo-document-info-bar` (running workflows, from
  `contextParameters.runningWorkflows`: `WUI/elements/nuxeo-document-info-bar/nuxeo-document-info-bar.js:88-107, 287-291`)
  and by `nuxeo-document-task` (`WUI/elements/workflow/nuxeo-document-task.js:118, 162`). No Web UI screen lists
  ended workflows or opens their graph. The History tab (`nuxeo-audit-search`) has no extension point.
- **Document tab:** `DOCUMENT_VIEWS_ITEMS` (`<nuxeo-page-item name="x">`) + `DOCUMENT_VIEWS_PAGES` (element with
  `name="x"`), each wrapped in a `nuxeo-filter` (example: `WUI/elements/nuxeo-web-ui-bundle.html:453-471`). Slot model:
  `{ document }`, plus the shared `{ user }`.
- **Full page:** `PAGES` slot + route `page:<name>`, URL `#!/<name>` (`WUI/elements/routing.js:198-201, 263-265`;
  example: `WUI/addons/nuxeo-drive/nuxeo-drive.html:40-51`). A `PAGES` content hidden by a filter gives a 404 page
  after 1 s (`WUI/elements/nuxeo-app.js:1871-1895`).
- **Left drawer:** a `DRAWER_ITEMS` icon (`nuxeo-menu-icon`) opens the `DRAWER_PAGES` panel with the same name
  (`WUI/elements/nuxeo-web-ui-bundle.html:579-588`). `nuxeo-menu-icon` also accepts `route="page:<name>"`
  (`WUI/elements/nuxeo-app/nuxeo-menu-icon.js:148-150, 210-221`), but Web UI has no example of it in the drawer:
  check how it behaves with the drawer's `iron-activate` handler.
- **Administration pages** (`/admin/...`) are only open to administrators and `powerusers`
  (`WUI/elements/routing.js:107-116`): an "auditors" group could not reach them.
- **`nuxeo-filter`:**
  - `group="a,b"` passes when the user is in one of the groups, inherited groups included (`user.extendedGroups`;
    `NXE/ui/nuxeo-filter.js:166-174, 225-240`, `NXE/ui/nuxeo-filters-behavior.js:217-218`);
  - `expression` runs JS with `new Function` (globals in scope), unless `org.nuxeo.web.ui.expressions.eval=false`:
    a sandbox then only sees `this`, `document` and `user` (`nuxeo-filter.js:186-212`);
  - `user.isAdministrator` is missing (not `false`) for other users
    (`NX/modules/platform/nuxeo-platform-usermanager/src/main/java/org/nuxeo/ecm/platform/usermanager/io/NuxeoPrincipalJsonWriter.java:125-127`).
- **Slots:** Web UI replaces the shared model, it does not merge it (`NXE/ui/nuxeo-slots.js:76-80`): a plugin cannot
  add its own key to it. Slot contents registered later (for example created by JS) re-render the slots
  (`nuxeo-slots.js:40-62`).
- **Lists with deletion:** `nuxeo-page-provider` (a `params` object becomes named parameters,
  `NXE/core/nuxeo-page-provider.js:430-449`), `nuxeo-results` + `nuxeo-data-table` with selection, and
  `nuxeo-delete-documents-button` (`hard` gives `Document.Delete`; hidden unless the user has `Remove` on each
  document, which needs the `permissions` enricher). Examples: `WUI/elements/nuxeo-results/nuxeo-document-trash-content.js:87-161, 365-366`,
  `WUI/elements/nuxeo-web-ui-bundle.html:703-707`,
  `WUI/elements/nuxeo-document-bulk-actions/nuxeo-delete-documents-button.js:39-51, 108, 115-142`.
- **Bulk commands** run as their user (`Framework.loginUser(username)`, unless it is `system`):
  `CORE/nuxeo-core-bulk/src/main/java/org/nuxeo/ecm/core/bulk/action/computation/AbstractBaseBulkComputation.java:141-169`,
  session opened in `AbstractBulkComputation.java:60`. Permission checks therefore apply. The `deletion` bulk action
  only works on MongoDB (VCS `removeSingleton` is not implemented) and fires no event: use a custom action calling
  `session.removeDocument`, as `RC/bulk/GarbageCollectRoutesAction.java:69-80` does.

## 4. Decisions taken with the user

| Topic | Decision |
|---|---|
| Graph source | Snapshot at the end of the workflow, same three sources as the dialog, stored as JSON |
| When to write | In the same transaction as the end of the workflow |
| Document type / prefixes | `LwgWorkflowHistory`; schemas `lwg_workflow_history` (prefix `lwgwh`) and `lwg_workflow_snapshot` (prefix `lwgwhs`) |
| Fields | `lwgwh:start`, `lwgwh:end`, `lwgwh:endType` (vocabulary), `lwgwh:workflowName` (raw Studio label, not localized), `lwgwh:documents` (document ids, with a document constraint), `lwgwh:modelName`; JSON in `lwgwhs:snapshot` |
| Title | `dc:title` = `<workflowName>-<start>` |
| End types | Vocabulary `normal`, `canceled`, `removed` (the safety net) |
| Deleted documents | Keep every id; turn validation off for that one write only when an id does not exist anymore |
| Safety net | Yes: a running instance removed without cancel (`aboutToRemove`) gets a `removed` record |
| Entry points | Both: a "Workflow history" tab on documents and a global page |
| Retention | Manual purge only |
| Settings (nuxeo.conf) | `nuxeo.labs.workflowGraph.history.enabled` (default `true`), `.readers` and `.writers` (comma-separated groups, default `administrators`) |
| Scope of `enabled=false` | Records only: no record, no folder created, no tab, no page. The audit recorder of 2025.2 keeps running (the graph of running workflows still shows the history) |
| Initiator, end user | Not separate fields: kept inside the JSON |

## 5. Design

### 5.1 Settings

| nuxeo.conf | Default | Property (ConfigurationService, also `Nuxeo.UI.config`) | Role |
|---|---|---|---|
| `nuxeo.labs.workflowGraph.history.enabled` | `true` | `org.nuxeo.web.ui.labsWorkflowGraph.history.enabled` | Records on or off |
| `nuxeo.labs.workflowGraph.history.readers` | `administrators` | `org.nuxeo.web.ui.labsWorkflowGraph.history.readers` | Groups that can read the records |
| `nuxeo.labs.workflowGraph.history.writers` | `administrators` | `org.nuxeo.web.ui.labsWorkflowGraph.history.writers` | Groups that can delete and purge them |

```xml
<extension target="org.nuxeo.runtime.ConfigurationService" point="configuration">
  <property name="org.nuxeo.web.ui.labsWorkflowGraph.history.enabled">${nuxeo.labs.workflowGraph.history.enabled:=true}</property>
  <property name="org.nuxeo.web.ui.labsWorkflowGraph.history.readers">${nuxeo.labs.workflowGraph.history.readers:=administrators}</property>
  <property name="org.nuxeo.web.ui.labsWorkflowGraph.history.writers">${nuxeo.labs.workflowGraph.history.writers:=administrators}</property>
</extension>
```

- The nuxeo.conf names differ from the property names on purpose (3.12: no deprecation warning). Plain strings, not
  `list="true"`: split on commas, trim, ignore empty values, in Java and in JS.
- In the core bundle (Java needs them). Web UI reads them as `Nuxeo.UI.config.labsWorkflowGraph.history.*`
  (strings: `"true"` / `"false"`).
- A change needs a restart. The group names are visible to every logged-in user (config.jsp): not a secret.
- Administrators bypass permissions on the server; the Web UI also shows the entry points to `user.isAdministrator`
  (proposal, see 9).
- `enabled=false`: the listeners return at once, the recorder keeps no buffer, the startup code creates no folder
  (it still rewrites the ACL of an existing one), the Web UI shows nothing. The type, the schemas and the vocabulary
  stay registered (existing records stay readable through REST), and the purge operation keeps working.

### 5.2 Storage

**Folder `/lwg-workflow-history`** (type `HiddenFolder`, standard, so it stays readable after an uninstall):

- Created at startup by a `RepositoryInitializationHandler` (pattern of `RouteModelsInitializator`, under
  `ClusterService.runAtomically("lwg-workflow-history-" + repositoryName, …)`), only when `enabled`. **Never** created
  inside a workflow transaction (3.7). If it is missing when a workflow ends: log a warning, write nothing.
- At every startup, when it exists, its local ACL is rewritten from the settings
  (`session.setACP(ref, acp, true)`):
  - each readers group: `Read`;
  - each writers group: `ReadRemove`;
  - administrator groups (`UserManager.getAdministratorsGroups()`): `Everything`;
  - `Everyone`: deny `Everything` (blocks inheritance), as `DocumentRoutingTreePersister.java:138-146` does.
- Flat: no date sub-folders (creating them in workflow transactions would race, 3.7). Never browsed: lists use page
  providers.

**Records:** `/lwg-workflow-history/<workflow instance id>`, one per workflow, **write-once** (if the path exists, do
nothing: a done workflow canceled later keeps its first record).

**Type** (core bundle, `<require>org.nuxeo.audit.core.types-contrib</require>` for `ForceAudit`, as
`RX/OSGI-INF/routing-audit-contrib.xml:3-4` does):

```xml
<extension target="org.nuxeo.ecm.core.schema.TypeService" point="schema">
  <schema name="lwg_workflow_history" prefix="lwgwh" src="schemas/lwg_workflow_history.xsd" />
  <schema name="lwg_workflow_snapshot" prefix="lwgwhs" src="schemas/lwg_workflow_snapshot.xsd" />
</extension>
<extension target="org.nuxeo.ecm.core.schema.TypeService" point="doctype">
  <doctype name="LwgWorkflowHistory" extends="Document">
    <schema name="common" />
    <schema name="dublincore" />
    <schema name="lwg_workflow_history" />
    <schema name="lwg_workflow_snapshot" />
    <facet name="HiddenInNavigation" />
    <facet name="HiddenInCreation" />
    <facet name="NotFulltextIndexable" />
    <facet name="SystemDocument" />
    <facet name="ForceAudit" />
  </doctype>
</extension>
```

- `SystemDocument`: no automatic versioning, no automatic `dc:*`. `ForceAudit`: the creation and the deletion of a
  record are audited (`documentCreated`, `documentRemoved`), so auditors can see who purged history.
- Two schemas, so lists can leave the JSON out (3.11).

**Schema `lwg_workflow_history`** (prefix `lwgwh`), sketch:

```xml
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"
  xmlns:ref="http://www.nuxeo.org/ecm/schemas/core/external-references/"
  xmlns:lwgwh="http://nuxeo.labs/schemas/lwg_workflow_history/"
  targetNamespace="http://nuxeo.labs/schemas/lwg_workflow_history/">
  <xs:element name="start" type="xs:date" />        <!-- dc:created of the instance -->
  <xs:element name="end" type="xs:date" />          <!-- time of the end event -->
  <xs:element name="endType">                       <!-- normal / canceled / removed -->
    <xs:simpleType>
      <xs:restriction base="xs:string" ref:resolver="directoryResolver" ref:directory="lwgWorkflowEndType" />
    </xs:simpleType>
  </xs:element>
  <xs:element name="workflowName" type="xs:string" /> <!-- raw dc:title of the instance (Studio label) -->
  <xs:element name="modelName" type="xs:string" />    <!-- getModelName(), stable across deployments -->
  <xs:element name="documents">                       <!-- docri:participatingDocuments, deleted ones included -->
    <xs:simpleType>
      <xs:list>
        <xs:simpleType>
          <xs:restriction base="xs:string" ref:resolver="documentResolver" ref:store="idOnly" />
        </xs:simpleType>
      </xs:list>
    </xs:simpleType>
  </xs:element>
</xs:schema>
```

**Schema `lwg_workflow_snapshot`** (prefix `lwgwhs`): one element `snapshot`, `xs:string` restricted with
`<xs:maxLength value="999999999" />`, so it is a CLOB on every SQL database (3.11).

**Vocabulary `lwgWorkflowEndType`** (`extends="template-vocabulary"`, `<require>org.nuxeo.ecm.directories</require>`),
CSV `id,label,obsolete`: `normal`, `canceled`, `removed`, labels
`labsWorkflowGraph.history.endType.normal` and so on. `dataLoadingPolicy` `update_duplicate`, so a label change is
applied at the next start.

**Title:** `dc:title` = `<workflowName>-<start>`, start in ISO 8601, UTC, to the second (for example
`wf.serialDocumentReview.SerialDocumentReview-2026-11-11T09:12:03Z`).

### 5.3 Snapshot JSON, format version 1

```json
{
  "format": "lwg-workflow-snapshot",
  "version": 1,
  "capturedAt": "2026-11-11T09:12:03.120Z",
  "workflow": {
    "entity-type": "workflow", "id": "…", "name": "SerialDocumentReview", "title": "wf.serialDocumentReview.SerialDocumentReview",
    "state": "running", "workflowModelName": "SerialDocumentReview", "modelId": "…", "initiator": "jdoe",
    "attachedDocumentIds": [{ "id": "…" }], "start": "…", "parentWorkflowId": null, "parentNodeId": null
  },
  "graph": {
    "nodes": [{ "id": "Task542", "title": "Update Document", "titleKey": "wf.serialDocumentReview.updateRequest",
                "state": "ready", "x": 120, "y": 40, "isStartNode": false, "isEndNode": false, "isForkNode": false,
                "isMerge": false, "isMultiTask": false, "hasSubWorkflow": false, "subWorkflowId": null,
                "count": 1, "startDate": "…", "endDate": "…", "lastActor": "jdoe" }],
    "transitions": [{ "nodeSourceId": "Task542", "nodeTargetId": "Task38e", "label": "Submit Modifications",
                      "labelKey": "wf.serialDocumentReview.submit", "name": "sdr_submission", "path": [] }]
  },
  "history": {
    "entries": [{ "eventId": "lwgWorkflowStepCompleted", "eventDate": "…", "principalName": "jdoe",
                  "extended": { "lwgWorkflowId": "…", "lwgModelName": "…", "lwgNodeId": "Task542",
                                "lwgTransitions": [1], "lwgTransitionNames": ["sdr_submission"], "lwgTargets": ["Task38e"] } }],
    "complete": true,
    "missingNodes": []
  },
  "end": { "type": "canceled", "date": "…", "user": "jdoe", "pendingNodes": ["Task6d8"] }
}
```

- `workflow`: the fields of `GET /api/v1/workflow/{id}` used by the dialog, plus `modelId`, `start` and the parent ids
  (sub-workflows). `title` is raw, as REST gives it. `state` is the state at capture time.
- `graph`: same fields as the REST graph (`NodeView`, `TransitionView`, built safely, 3.9). `title` / `label` are the
  English server translations, `titleKey` / `labelKey` the raw keys, `name` the technical transition id. Per step:
  `count`, `startDate`, `endDate`, `lastActor` (for a future tooltip). Transitions are listed step by step, in
  definition order: the order the recorded positions refer to (same order as REST).
- `history.entries`: the recorder's entries for this workflow, in the REST audit shape (subset), oldest first, so the
  client reuses `LWG.historyFromAudit(entries, workflow.id)` unchanged.
- `history.complete` is `false` when a step has an `endDate` but no entry (gap of 3.5, or a workflow started before
  the recorder was installed); `missingNodes` lists them, and the dialog shows a notice.
- `end.pendingNodes`: the steps `suspended` or `waiting` at the end. For a cancel, read before anything changes; for
  a normal end, the branches still open.
- Size: about 1 to 2 KB per step plus about 300 bytes per completion. Long loops can reach hundreds of KB: fine in a
  CLOB. Written with Jackson in Java; the client checks `format` and `version`.

### 5.4 Recording (Java)

**In-memory buffer in `StepCompletedListener`** (only when `enabled`):

- When `record()` fires its events, it also adds one entry (shape of `history.entries`, `eventDate` = now,
  `principalName` = acting user of the event principal) to a per-transaction buffer, keyed by workflow id. One entry
  per completion, not one per attached document.
- Buffer: a `ThreadLocal<Map<String, List<…>>>`, registered once per transaction with
  `TransactionHelper.registerSynchronization`
  (`NX/modules/runtime/nuxeo-runtime-jtajca/src/main/java/org/nuxeo/runtime/transaction/TransactionHelper.java:553-562`)
  and cleared in `afterCompletion`, on commit and on rollback (as `StreamAuditEventListener.java:87-122` does). No
  active transaction: no buffering.
- It only holds the completions of the current transaction, which are not in the audit yet (3.5): merging never
  duplicates an entry.

**Capture listener** (new class, for example `WorkflowEndListener`; synchronous: `async="false" postCommit="false"`),
on `afterWorkflowFinish`, `beforeWorkflowCanceled` and `aboutToRemove`:

1. Return at once when:
   - `enabled` is false;
   - the source document has no `DocumentRoute` facet (this skips the per-step `beforeWorkflowCanceled`, 3.6);
   - `aboutToRemove` on a route that is not `running` (models, `ready`, and `done` / `canceled` routes, which ended
     before the installation or while the feature was off).
2. In `CoreInstance.doPrivileged(session, s -> …)` (same transaction, 3.7):
   1. Folder `/lwg-workflow-history` missing: log a warning and return. Record
      `/lwg-workflow-history/<workflow id>` already there: return (write-once).
   2. Read the route again (`s.getDocument(routeRef).getAdapter(GraphRoute.class)`); return if it is not a
      `GraphRoute`.
   3. Build `workflow`, `graph` (safely, 3.9) and `end`: type from the event (`normal`, `canceled`, `removed`), date =
      now, user = acting user of the event principal, `pendingNodes` = steps whose state is `suspended` or `waiting`.
   4. History:
      - query the audit backend (3.5): `eventId = lwgWorkflowStepCompleted`, `docUUID IN (docri:participatingDocuments)`
        (deleted documents included: their entries stay in the audit), `eventDate >= start`;
      - keep the entries whose `extended.lwgWorkflowId` is this workflow;
      - each completion is recorded once per attached document: **keep the entries of the document that has the
        most** (every document present until the end received all of them; a document deleted during the run only
        has the first ones);
      - add the buffer entries of this workflow, sort by `eventDate`;
      - `complete` / `missingNodes`: steps with an `endDate` but no entry.
   5. Create the record: name = workflow id, `dc:title`, `lwgwh:*`, `lwgwhs:snapshot`. Context data
      `disableAutoIndexing=true` (3.11). When one of the `documents` ids does not exist anymore, also
      `DocumentValidationService.CTX_MAP_KEY` = `Forcing.TURN_OFF` (3.12).
3. Errors: same policy as `StepCompletedListener.handleEvent` (`:104-120`): log and swallow, but rethrow
   `ConcurrentUpdateException`, interrupts, and any error when the transaction is already marked rollback-only.
   **Catch inside the privileged block too**: an exception escaping it marks the transaction rollback-only, which
   would fail the workflow step.
4. Sub-workflows: each one gets its own record (its own end event). The parent ids are in `workflow`, the
   sub-workflow ids in `graph.nodes[].subWorkflowId`.

Listener contribution sketch (core bundle):

```xml
<extension target="org.nuxeo.ecm.core.event.EventServiceComponent" point="listener">
  <listener name="lwgWorkflowEndListener" async="false" postCommit="false"
    class="nuxeo.labs.workflowgraph.WorkflowEndListener">
    <event>afterWorkflowFinish</event>
    <event>beforeWorkflowCanceled</event>
    <event>aboutToRemove</event>
  </listener>
</extension>
```

`aboutToRemove` is fired for every removed document: the listener must leave at once when the source is not a
`DocumentRoute` (check the facet before anything else).

### 5.5 Manual purge

- **Selected records:** Web UI's `nuxeo-delete-documents-button` with `hard` (`Document.Delete`, permission
  `Remove` checked by Nuxeo).
- **"Purge…" (everything matching filters):** an operation, for example `LabsWorkflowGraph.PurgeHistory`, with
  optional parameters `endedBefore` (date), `modelName`, `endType`, `documentId`.
  - It checks that the user is in a writers group (or is an administrator); otherwise it throws a `NuxeoException`
    with status 403.
  - It builds the NXQL query (`SELECT * FROM LwgWorkflowHistory WHERE ecm:isProxy = 0 AND ecm:isVersion = 0` plus the
    filters) and submits a bulk command **as the current user**: custom action `lwgPurgeWorkflowHistory`, whose
    computation calls `session.removeDocument` for each record (3.14: permissions apply, each deletion is audited).
  - It returns the command id; the UI polls `GET /api/v1/bulk/{id}`.
  - With no filter, it deletes every record (before an uninstall).
- Bulk contribution: pattern of `RX/OSGI-INF/document-routing-cleanup-contrib.xml:21-34` (`org.nuxeo.ecm.core.bulk`
  point `actions` with `defaultScroller="repository"`, plus a `streamProcessor`).
- Works whatever the value of `enabled`.

### 5.6 Web UI

**Access helpers** in `lwg-core.js` (no DOM, Node tested): `LWG.historyRecordsEnabled()`, `LWG.historyReaders()`,
`LWG.historyWriters()`, `LWG.isHistoryReader(user)`, `LWG.isHistoryWriter(user)` (`user.isAdministrator`, or one
of the groups in `user.extendedGroups`). They read `Nuxeo.UI.config.labsWorkflowGraph.history.*`.

**Showing the entry points only to readers:**

- Recommended: create the `nuxeo-slot-content` elements from JS at load time (only when enabled), with
  `<nuxeo-filter user="[[user]]" group="…">` where the readers groups are set with `setAttribute` (never
  `innerHTML` with server data). This works even with `org.nuxeo.web.ui.expressions.eval=false`, and slot contents
  registered later re-render the slots (3.14). To verify in a real Web UI.
- Simpler fallback: static HTML with `expression="window.LWG && LWG.isHistoryReader(user)"`. It hides everything when
  `expressions.eval=false`.
- `group` cannot be combined with "or administrator": administrators are normally members of `administrators`.

**"Workflow history" tab on documents** (`DOCUMENT_VIEWS_ITEMS` + `DOCUMENT_VIEWS_PAGES`, name
`lwg-workflow-history`):

- Element `nuxeo-labs-workflow-graph-history-list` with the `document`.
- Page provider `lwg_workflow_history_for_document`, core query (runs on the repository: records are not indexed):
  `SELECT * FROM LwgWorkflowHistory WHERE lwgwh:documents/* = ? AND ecm:isProxy = 0 AND ecm:isVersion = 0`, sort
  `lwgwh:end DESC`.
- Request with schemas `dublincore,lwg_workflow_history` (not the snapshot) and the `permissions` enricher.
- Columns: workflow (translated `workflowName`), start, end, end type, model. Clicking a row opens the dialog in record
  mode. Writers get the selection and the delete button.

**Global "Workflow history" page** (`PAGES` slot, name `lwg-workflow-history`, URL `#!/lwg-workflow-history`):

- Reached from a `DRAWER_ITEMS` icon (check the `route` behaviour, 3.14) or a `USER_MENU` item (as `nuxeo-drive`).
  Not under Administration: auditors could not reach it (3.14).
- Page provider `lwg_workflow_history_search` with named parameters: `modelName`, `endType`, `endedAfter`,
  `endedBefore`, `documentId`.
- Writers: delete the selection, and a "Purge…" dialog (same filters, calls the operation, shows the progress).

**Dialog, record mode:**

- New method, for example `openRecord(recordId)`: `GET /api/v1/id/{recordId}` with the schemas
  `lwg_workflow_history,lwg_workflow_snapshot`, then `LWG.parseWorkflowSnapshot` (checks `format` and `version`). No
  call to the workflow endpoints.
- History: `LWG.historyFromAudit(snapshot.history.entries, snapshot.workflow.id)`, unchanged.
- `renderer.setGraph(graph, { direction, history, ended: { type, pendingNodes } })`.
- Header: translated workflow name, "Done / Canceled / Removed on …", and a "History may be incomplete" notice when
  `complete` is false. The direction is stored per `workflowModelName`, as today.
- Where it lives: the list elements create their own `nuxeo-labs-workflow-graph-dialog` in their shadow DOM (today
  it is created inside `nuxeo-workflow-graph`, `lwg-override.js:43-55`).

**`LWG.buildModel` with `ended`:**

- No step is current (`suspended` / `waiting` are not "current"), no `is-next` transition.
- Steps of `pendingNodes` get a marker (`isPendingAtEnd`, badge "Canceled here", "Removed here", or "Pending at end"
  for a normal end with open branches) and are not dimmed.
- Dimming as today with an empty "future": every step never reached is dimmed (only with a complete history, as
  today).
- Labels: Web UI translation of `titleKey` / `labelKey` when it exists, else the stored English `title` / `label`,
  else the readable fallback of the key.

**i18n:** keys `labsWorkflowGraph.history.*` in `messages.json` and `messages-fr.json`, plus the vocabulary labels.

### 5.7 Uninstall

- README procedure: run the purge with no filter, then uninstall the package. The empty `HiddenFolder` can stay, or
  an administrator deletes it.
- Records left behind become unreadable, and on VCS their folder cannot be deleted anymore (3.13). The vocabulary
  table stays (harmless).

## 6. Implementation plan

Follow the AGENTS.md conventions (headers, `@since`, comment style, `MANIFEST.MF` format, classic scripts, no
`innerHTML` with server data, names prefixed `lwg` / `labsWorkflowGraph` / `nuxeo-labs-workflow-graph-`). Keep each
file edit under about 300 lines, run the tests after each step, and report after each step.

1. **Types and settings** (core bundle):
   - `src/main/resources/schemas/lwg_workflow_history.xsd`, `lwg_workflow_snapshot.xsd`;
   - `OSGI-INF/lwg-history-types-contrib.xml` (schemas, doctype), `lwg-history-directories-contrib.xml` with
     `directories/lwg-workflow-end-type.csv`, `lwg-history-properties-contrib.xml`;
   - Java: settings parsing (enabled, readers, writers); a `RepositoryInitializationHandler` creating the folder and
     rewriting its ACL, installed and uninstalled by a small component (`activate` / `deactivate`, as
     `DocumentRoutingServiceImpl.java:498-503, 523-527` does);
   - `META-INF/MANIFEST.MF`: the new `Nuxeo-Component` entries.
2. **Recording**: buffer in `StepCompletedListener`; the end listener; a snapshot builder (workflow, graph, end, JSON
   with Jackson); the audit reader (query, selection of the document, merge with the buffer);
   `OSGI-INF/lwg-history-listener-contrib.xml`; new keys in `WorkflowHistoryConstants`.
3. **Purge and page providers**: the operation, the bulk action and its computation,
   `OSGI-INF/lwg-history-purge-contrib.xml`, `OSGI-INF/lwg-history-pageproviders-contrib.xml`.
4. **`lwg-core.js` and the renderer**: `parseWorkflowSnapshot`, the `ended` option of `buildModel`, the label
   fallback, the access helpers, the "pending at end" badge (any new public CSS variable goes to the README "Colors"
   table), Node tests.
5. **Dialog**: record mode (`openRecord`), header notices, i18n.
6. **Web UI pages**: `nuxeo-labs-workflow-graph-history-list.html`, `nuxeo-labs-workflow-graph-history-page.html`,
   the slot registration script, the purge dialog, the bundle order, `messages.json` and `messages-fr.json`.
7. **Demo**: done and canceled records in `dev/demo/samples.js` (anonymised), a `record` parameter in
   `dev/demo/index.html`, checks in `dev/tools/screenshots.mjs`.
8. **Docs**: README (feature, settings table, permissions, storage and indexing, purge, uninstall procedure, limits,
   personal data), AGENTS.md (scope beyond the read-only dialog, names, settings, tests; the rule "no setting to turn
   the plugin off" still holds: `history.enabled` only turns the records off).

## 7. Tests

**Java** (JUnit 4, `FeaturesRunner`, `WorkflowGraphFeature`, helpers of `AbstractWorkflowHistoryTest`; let the audit
writer run with `txFeature.nextTransaction()`, as `AbstractWorkflowHistoryTest.java:166-171` does):

- Normal end: one record; fields (start, end, `endType=normal`, raw `workflowName`, `modelName`, `documents`), title;
  JSON (nodes and transitions in definition order, complete history, `end`).
- A workflow that ends in the transaction where it started (automatic steps only): history complete thanks to the
  buffer.
- Steps completed in earlier transactions: read from the audit.
- Loop; fork and merge; `executeOnlyFirstTransition`.
- Cancel with a suspended step and a waiting merge: `pendingNodes` holds both; one record, not one per step.
- Done, then canceled: the record does not change.
- Rollback after the end (transaction marked rollback-only): no record, and no stale buffer entry in the next
  transaction.
- Sub-workflow: two records, linked through the parent and sub-workflow ids.
- `BulkRestartWorkflow`: one `canceled` record, no `removed` record.
- Safety net: delete the last attached document of a running workflow (asynchronous orphan listener) → `removed`
  record that keeps the old document list (validation turned off).
- Attached document deleted during the run: id kept; entries taken from the document with the most entries.
- A step without coordinates (`taskX` null) does not break the capture.
- Permissions: a reader reads and cannot delete; a writer deletes; another user sees nothing. Settings from a test
  contribution (as `src/test/resources/test-recorder-disabled-contrib.xml`) → ACL rewritten at startup.
- `enabled=false` (separate test class): no folder, no record, the audit recorder still writes its entries.
- Purge operation: filters, 403 for non-writers, the bulk command runs as the user.
- Size sanity: a loop with about 200 completions.

Commands (from AGENTS.md): `mvn clean install`, and
`mvn -pl nuxeo-labs-workflow-graph-core test -Dnuxeo.test.audit=sql` for the SQL audit backend.

**JavaScript** (`node --test dev/test`): `parseWorkflowSnapshot` (valid, unknown version, broken JSON); `buildModel`
with `ended` (nothing current, no next transitions, pending markers, dimming); label fallback (Web UI key, stored
English text, readable key); access helpers (groups, inherited groups, administrators, disabled);
`historyFromAudit` on snapshot entries.

**Browser** (`node dev/tools/screenshots.mjs`): done and canceled records, light and dark themes, both directions.

## 8. Known limits and risks

- Workflows that ended before the installation, or while `enabled=false`, have no record.
- Workflows that started before the recorder was installed (2025.2): incomplete history (`complete=false`).
- Audit gap: entries committed less than about 1 s before the end can be missing (for example two parallel tasks
  completed within the same second, or automated chains). Flagged with `complete=false` and `missingNodes`.
- Deleting a folder that contains workflow instances fires no event per instance: no `removed` record.
- Two end events for the same workflow in parallel (done and cancel at the same time): both may create a record. On
  PostgreSQL, the second commit fails with `ConcurrentUpdateException` (a retry then sees the record); on MongoDB, a
  duplicate is created silently. Very unlikely.
- The capture runs in the workflow transaction: it makes the end of a workflow a bit slower. Its errors are
  swallowed (they never fail the workflow), except when the transaction is already failing.
- A full OpenSearch reindex indexes the records (keyword fields and `all_field`). Avoid it with an appended mapping,
  or accept it.
- Personal data: the records keep user ids (initiator, users of the steps, user who ended the workflow) and document
  ids after the documents are deleted, until they are purged. Mention it in the README.
- Volume: one document per ended workflow, kept until purged, in one flat folder.
- Labels: raw keys plus the English text of the time; later translation changes only apply to keys known by Web UI.
- Uninstall: purge first (3.13). The large-text column type must be right at the first deployment (3.11).

## 9. Open questions (to confirm before implementing)

- Show the entry points to administrators even when they are not in a readers group? Proposal: yes
  (`user.isAdministrator`); on the server they have access anyway.
- Exact names: operation (for example `LabsWorkflowGraph.PurgeHistory`), listener and classes, page providers,
  elements, bulk action.
- Add a technical field `lwgwh:workflowId`? Today the record name is the workflow id, which is enough for lookups; a
  field would help if a duplicate name ever happened.
- Keep `principalName` for each step in the snapshot? It is already in the audit, readable by the readers of the
  document. Proposal: yes. Task comments: no.
- Global page entry point: a left drawer icon or a user menu item.
- Version of the implementation and its `@since`.

## 10. Side findings (not part of this evolution)

Current plugin (2025.2):

- `_loadHistory` stops at the first readable document, even when it holds no entry for this workflow
  (`nuxeo-labs-workflow-graph-dialog.html:337-381`, see `:349-350`).
- `normalizeHistory` drops the transition `name` (`lwg-core.js:482-489`), although its comment (`:459`) and AGENTS.md
  list it.
- The `StepCompletedListener` javadoc (`:74-76`) says the history "stays after the workflow instance is removed":
  true for the data, but the dialog cannot show it (the graph call is required).
- The audit reads sort on `eventDate` only, which replaces the SQL default tiebreaker `log.id`.
  `sortBy=eventDate,id` with `sortOrder=desc,desc` should work on every backend (not tested). Keep `pageSize` at
  1000 or less (the offset is computed with the requested size).

Nuxeo:

- The model UUID changes at each Studio deployment (3.4). `GET /api/v1/workflow?workflowModelName=…` may then fail for
  running instances of a replaced model (`DocumentRoutingServiceImpl.java:1139-1146`, inferred).
- `cancelSubRoute` also cancels done sub-workflows; if the cleanup already purged one, the parent cancel may fail
  (inferred, not tested).
- Web UI has no translation for `eventCategory.Routing`, `eventType.afterWorkflow*` and `eventType.workflowCanceled`:
  the History tab shows the raw keys (`WUI/i18n/messages.json`; the plugin adds some of them already).
