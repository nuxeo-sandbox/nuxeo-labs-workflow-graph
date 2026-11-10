# AGENTS.md - nuxeo-labs-workflow-graph

Notes for coding agents. This file is committed to the public repository: keep it free of secrets, personal data
and machine-specific paths.

## Project

Nuxeo LTS 2025 Web UI plugin: a simple, read-only replacement of the "View Graph" dialog of Web UI (the
`nuxeo-workflow-graph` element, jsPlumb), plus, since 2025.2, a small Java bundle that records the history of a
workflow (steps already done, transitions already followed) in the audit of its attached documents. It patches
`nuxeo-workflow-graph.show()` once the element is defined (`lwg-override.js`); the default `show()` is kept as a
fallback (dialog not available, layout failure).
There is **no setting** to turn the plugin off (removed on purpose: it needed a restart, like uninstalling the
package); do not add one back.
Data: `GET /api/v1/workflow/{id}/graph` (required), `GET /api/v1/workflow/{id}` (title, model name, attached
documents, optional; 403 for the users who only read the document) and `GET /api/v1/id/{docId}/@audit` (history,
optional), requested in parallel; the graph is drawn once all have answered. An optional call that fails only logs
a `console.warn`. **No server operation, no privileged read** (decided with the user): the history is in the audit
of the documents, readable by their readers. `show()` passes the documents known by the host element (document of
`nuxeo-document-info-bar`, `task.targetDocumentIds` of `nuxeo-document-task`, see `documentHints`); the dialog tries
them, then `attachedDocumentIds` of the workflow entity, skipping 403/404.

Nuxeo may one day audit the followed transitions itself (a possible improvement of Nuxeo: an event fired on the
attached documents by `GraphRunner`). The plugin then needs a new version (use Nuxeo's entries, stop recording,
restrict the target Nuxeo versions); the README has a WARNING about the duplicated entries. Keep reading the
plugin's own event and keys only until then.

It is the simple sibling of `nuxeo-labs-custom-workflow-graph` (interactive version: details panel, Studio layout,
legend...). The two packages conflict (`package.xml`). Names never overlap: namespace `NuxeoLabs.WorkflowGraph`
(`LWG`), files and CSS classes `lwg-*`, i18n keys `labsWorkflowGraph.*`, elements `nuxeo-labs-workflow-graph-*`,
Java package `nuxeo.labs.workflowgraph`, audited event `lwgWorkflowStepCompleted` and its extended info `lwg*`
(`lwgWorkflowId`, `lwgModelName`, `lwgNodeId`, `lwgTransitions`, `lwgTransitionNames`, `lwgTargets`), listener
`lwgStepCompletedListener`, OSGi components `nuxeo.labs.workflowgraph.*`. Only exceptions: the Web UI labels of the
audit entries, `eventType.lwgWorkflowStepCompleted`, `activity.lwgWorkflowStepCompleted` and `eventCategory.Routing`
(missing in Web UI, used by every routing event), in the plugin's `messages*.json`.

### Scope (decided with the user, keep it)

- The graph is **read-only**: steps and labels are not clickable nor focusable, no hover effect, no selection,
  no interactive dimming (only the static dimming of the branches not followed, see History), no details panel,
  no legend.
- **No animation** of any kind (no pulse, no animated dashes, no animated zoom/pan, no CSS transition).
- Highlighted: the current step(s) (state `suspended`: border, ring, "Current" badge) and their **outgoing**
  transitions (thicker, bigger arrow heads, labels emphasized, drawn on top). The ring keeps a minimum screen size
  at low zoom (`--_lwg-inv-scale`) so current steps stay visible when the graph is fitted. Arrow head sizes:
  `ARROW` / `NEXT_ARROW` in `lwg-renderer.js`; the `NEXT_ARROW` width must stay below the gap between nested
  self-loops (`selfLoop` in `lwg-layout.js`, unit tested), or their arrow heads overlap.
- Transition colors, as in Web UI's default graph: the transitions of a step with **2 or more** outgoing
  transitions get a palette color from their rank in the step (definition order, `edge.colorIndex` in
  `LWG.buildModel`): `--lwg-transition-1` to `-5` (`LWG.TRANSITION_COLOR_COUNT`), reused in turn (7 transitions:
  1, 2, 3, 4, 5, 1, 2). A single transition is neutral (`--lwg-edge`), or the highlight color when it leaves a
  current step. Next transitions keep their palette color (no halo). Labels: border + light tint of the color,
  text keeps the text color; the label border width never changes (sizes are computed in core). Classes:
  `is-next`, `lwg-tc lwg-tc-N`, color in `--_lwg-tc`. The graph endpoint has no transition id: colors cannot
  depend on the meaning of a transition.
- Only layout: dagre, top to bottom (default) or left to right. No Studio layout.
- Direction: two toolbar buttons (`↓` `→`, the active one has `aria-pressed="true"`) and two keys, Down arrow =
  TB, Right arrow = LR (`DIRECTION_KEYS` in `lwg-renderer.js`, ignored with Shift/Ctrl/Alt/Meta, shown in the
  button tooltips); **no configuration property**. Toolbar and keys share `_chooseDirection`. The user's choice is
  kept in `localStorage` per workflow model (`workflowModelName`, instance id when the workflow cannot be read),
  see `LWG.directionStorageKey`; TB is never stored (the entry is removed). Switching resets the view as at
  opening. The renderer only calls `onDirectionChange`; the dialog (and the demo) do the storage.
- View controls only: zoom (`+`/`=`, `-`, toolbar, pinch, Ctrl/Cmd + wheel, Safari gesture events), fit (`f`,
  toolbar), center on the current step (`c`, toolbar, cycles through parallel current steps), pan (drag, wheel).
  Zoom range 5%-250%, step 1.25. Arrow keys never pan: only Down/Right are used (direction), Left/Up do nothing.
  No double-click zoom.
- Opening (and direction switch): fit; if the fitted zoom is under 50% and a step is current, zoom to 80%
  centered on it.
- History (2025.2), a "trail" in `--lwg-passed` (default teal `#0d9488`): steps done (an audit entry of the
  recorder, i.e. completed at least once since the installation) get a 2px border (padding 1px less, size
  unchanged) and a round check badge (`lwg-node-check`, `role="img"`, `labsWorkflowGraph.passedStep`); followed
  transitions get `is-taken`: color `--lwg-passed` whatever their palette color, stroke 2.4, `TAKEN_ARROW`, label
  tinted, drawn above the others and below the next ones. **The current look wins**: a current step is never
  `isPassed`, a transition leaving a current step is never `isTaken` (it is `is-next`). Steps only from the history,
  no count shown (no "xN"), no guessed path: transitions only come from the recorder. Model:
  `LWG.historyFromAudit(entries, workflowId)` (keeps our event for this workflow, counts) -> `LWG.normalizeHistory`
  format `{ nodes: [{ id, completed, count }], transitions: [{ source, index, name, target, count }] }`,
  `node.isPassed`, `edge.isTaken`, `edge.sourceIndex` (position in the step counting the ignored transitions,
  matched with the history `index`; a target mismatch is ignored with a warning).
- Branches not followed (asked by the user, 2025.2), only with a **complete** history (`model.historyComplete`: a
  start step is completed in the history or is current; otherwise the workflow started before the installation and
  its past is unknown: mark what is known, dim nothing): dim what was not done **and cannot happen anymore**; the
  steps still to come (the "future") keep their normal look, the current step and its transitions never change.
  Future = the current and `waiting` steps plus every step a transition leads to from them, loops included (so a
  loop back to an early step makes everything after it future). Reached = current, in the history nodes, `waiting`,
  or target of a followed transition. `node.isDimmed` = not reached and not future. `edge.isDimmed` = not next, not
  taken, and (source dimmed, or source not future and target not reached: never followed, cannot be anymore). Do
  not dim a transition between two reached steps that was not recorded: the recorder may have failed (it never
  breaks a workflow). Workflow done: every step never reached is dimmed.
  Look: `is-dimmed`, steps `opacity: var(--_lwg-dimmed)` + `grayscale(0.7)` + no shadow, transitions 80% of it,
  labels faded with `color-mix()` but opaque (their line passes below them). `--lwg-dimmed-opacity`, default 0.4.
  Drawing order of the transitions: dimmed, others, taken, next. Samples showing it: parallel (Stop after
  Cancelation), large (Rejected, only from phase 4); serial and contract dim no step (everything can still
  happen).

## Layout of the sources

- Maven modules: `nuxeo-labs-workflow-graph-core` (Java bundle, see below), `nuxeo-labs-workflow-graph-web` (JAR:
  web resources, OSGI-INF, i18n) and `nuxeo-labs-workflow-graph-package` (marketplace package). Version
  `2025.3.0-SNAPSHOT`, parent `org.nuxeo:nuxeo-parent:2025.24`. Minimum LTS 2025 hotfix: **2025.16**
  (`nuxeo.target.version`, target platform of `package.xml`): the audit `routes` extension point used by
  `lwg-audit-contrib.xml` exists since 2025.16. Do not lower it, nor go back to the deprecated `event` point.
- Java bundle (`nuxeo.labs.workflowgraph`), the recorder only:
  - `StepCompletedListener`: synchronous `beforeDocumentModification` listener on `RouteNode` documents. A step
    completes when it is saved with a new `rnode:endDate` (dirty, and different from `PREVIOUS_DOCUMENT_MODEL`):
    the transitions with `result=true` are the followed ones (only the first with
    `rnode:executeOnlyFirstTransition`, none for an end step). It fires `lwgWorkflowStepCompleted` on **each
    attached document** (`GraphRoute.getAttachedDocumentModels()`, deleted ones skipped; nothing without document),
    category `Routing`, event properties / extended info (`WorkflowHistoryConstants`, built by `properties()`):
    `lwgWorkflowId`, `lwgModelName` (String), `lwgNodeId` (String), `lwgTransitions` (list of Long positions),
    `lwgTransitionNames`, `lwgTargets` (lists of String, same order, never null items: the audit drops null list
    items when reading). Keys prefixed and each key always the same type (one OpenSearch mapping for all extended
    info). Comment abbreviated to `MAX_COMMENT_LENGTH` (SQL audit column of 1024 characters). It must not break
    the workflow engine: errors are logged (`log.error`) and swallowed, except when the transaction fails anyway,
    as in the event service: `ConcurrentUpdateException`, interrupt (`ExceptionUtils.checkInterrupt`), transaction
    marked rollback-only.
  - Nuxeo does not keep the followed transitions (`result` is reset when the target starts): what happened before
    the installation is unknown, do not try to guess it.
- Dialog (`nuxeo-labs-workflow-graph-dialog.html`): `_loadHistory` (candidates, never rejects, stale openings
  ignored) and `_readHistory` (`@audit?eventId=...&pageSize=LWG.HISTORY_PAGE_SIZE&sortBy=eventDate&sortOrder=desc`,
  page by page, at most `LWG.HISTORY_MAX_PAGES`, the oldest entries are dropped with a warning). The audit cannot
  filter on extended info: the client filters on `lwgWorkflowId`.
- Web files: `nuxeo-labs-workflow-graph-web/src/main/resources/web/nuxeo.war/ui/nuxeo-labs-workflow-graph/`,
  script order in `nuxeo-labs-workflow-graph-bundle.html`: `lwg-core.js`, `vendor/dagre.min.js`, `lwg-layout.js`,
  `lwg-icons.js`, `lwg-styles.js`, `lwg-renderer.js`, the Polymer dialog, `lwg-override.js`.
- Plain JavaScript + HTML imports, **no JS build**: Maven only packages the files. Files must run as classic
  scripts (IIFE on `window`/`globalThis`), no ES modules, no npm dependency at runtime.
- `lwg-core.js` and `lwg-layout.js` have no DOM dependency (unit tested in a Node VM). Sizes in `LWG.METRICS`
  (core) must match `lwg-styles.js`.
- CSS variables: public overrides `--lwg-*` are only read through internal `--_lwg-*` variables defined on
  `.lwg-root`/`.lwg-theme`, so a value set on `html` is never shadowed. Use `var(--_lwg-...)` in the CSS. The
  graph lives in shadow DOM (Web UI's `nuxeo-workflow-graph`, then the dialog): CSS variables are the only
  supported customization; any new public variable must be listed in the README "Colors" table.

## Conventions

- Apache 2.0 header `(C) Copyright 2026 Hyland (http://hyland.com/) and others.` with
  `Contributors: Thibaud Arguillere (with the help of opencode/Claude Opus 5.5)` on every new file (Java, JS, HTML,
  MJS).
- `@since 2025.2` on new files / public API (`@since 2025.1` for what existed in 2025.1).
- JavaScript comments: `//` for 1 to 3 lines, `/* ... */` for 4+ lines or for section separators such as
  `/* ==================== Layout ==================== */`.
- ~120 characters per line, 2-space indentation in JS/HTML, single quotes, trailing commas.
- Never use `innerHTML` with data coming from the server (titles, labels): `textContent` only.
- `MANIFEST.MF`: one `Nuxeo-Component` entry per line, single leading space on continuation lines, newline at EOF.
- No Nuxeo or Web UI source file is modified; their sources are read-only references.
- Third-party code: unmodified files in `vendor/` with their license, listed in the README.
- When a change only touches README / AGENTS.md / .gitignore, do not run the build.

## Tests and tools

`dev/` is not packaged. Nothing is installed by the project. Do NOT use a local Nuxeo server unless asked.

```bash
# unit tests (Node 20+, no dependency)
node --test dev/test

# screenshots (dev/out/demo/*.png) + interaction checks in headless Chrome; fails on console errors/warnings
export LWG_NODE_MODULES=/path/to/node_modules        # must contain puppeteer-core
export CHROME_PATH=/path/to/chrome-headless-shell    # optional, defaults to Google Chrome on macOS
node dev/tools/screenshots.mjs [filter]              # filter "checks": interaction checks only

# build (Java 21, Maven 3.8+), runs the Java tests (JUnit 4, FeaturesRunner, in-memory audit, H2)
mvn clean install

# Java tests with the SQL audit backend (H2) instead of the in-memory one
mvn -pl nuxeo-labs-workflow-graph-core test -Dnuxeo.test.audit=sql
```

Java tests: `WorkflowGraphFeature` (AuditFeature before AutomationFeature), `AbstractWorkflowHistoryTest` (models
built with `RouteNode` documents, steps resumed with `resumeInstance` and a button, tasks ended with `endTask`,
`recorded(docId, workflowId)` = sorted descriptions `step#position(name)>target` of the audit entries of a document),
`TestWorkflowHistory` (keys and values, JSON of the REST API via `MarshallerHelper`, paths, loop, fork/merge, waiting
merge, several tasks, cancellation, several attached documents, attached document deleted while running, no
attached document, comment length, `properties()`), `TestWorkflowHistoryWithoutRecorder` (listener disabled by
`test-recorder-disabled-contrib.xml`).

Demo: `python3 -m http.server 8765` at the project root, then
`http://localhost:8765/dev/demo/index.html?wf=large&theme=dark` (`&dir=LR` forces the direction, `&history=off`
hides the history).

Fixtures: `dev/demo/samples.js` (Serial/Parallel Document Review and MainWF rebuilt from the Nuxeo sources,
synthetic "contract" and "large" workflows), each with `workflowId`, `documentId` and an `audit`: the `@audit`
entries the recorder would write (built by `audit(graph, doneIds, [[source, label]])`, one entry per step done, plus
one entry of another workflow that must be ignored); the demo, the Node tests and `screenshots.mjs` use
`LWG.historyFromAudit(sample.audit, sample.workflowId)`, as the dialog. Anonymise any real graph before adding it.
The interaction checks that test the palette colors use `history: 'off'`.
