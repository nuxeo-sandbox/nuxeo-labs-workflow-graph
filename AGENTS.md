# AGENTS.md - nuxeo-labs-workflow-graph

Notes for coding agents. This file is committed to the public repository: keep it free of secrets, personal data
and machine-specific paths.

## Project

Nuxeo LTS 2025 Web UI plugin: a simple, read-only replacement of the "View Graph" dialog of Web UI (the
`nuxeo-workflow-graph` element, jsPlumb), plus, since 2025.2, a small Java bundle for the history of a workflow
(steps already done, transitions already followed). It patches `nuxeo-workflow-graph.show()` once the element is
defined (`lwg-override.js`); the default `show()` is kept as a fallback (dialog not available, layout failure).
There is **no setting** to turn the plugin off (removed on purpose: it needed a restart, like uninstalling the
package); do not add one back.
Data: `GET /api/v1/workflow/{id}/graph` (required), `GET /api/v1/workflow/{id}` (title and model name, optional)
and the `LabsWorkflowGraph.GetHistory` operation (history, optional), requested in parallel; the graph is drawn
once all have answered. An optional call that fails only logs a `console.warn`.

It is the simple sibling of `nuxeo-labs-custom-workflow-graph` (interactive version: details panel, Studio layout,
legend...). The two packages conflict (`package.xml`). Names never overlap: namespace `NuxeoLabs.WorkflowGraph`
(`LWG`), files and CSS classes `lwg-*`, i18n keys `labsWorkflowGraph.*`, elements `nuxeo-labs-workflow-graph-*`,
Java package `nuxeo.labs.workflowgraph`, operation `LabsWorkflowGraph.*`, audited event `lwgWorkflowStepCompleted`,
listener `lwgStepCompletedListener`, OSGi components `nuxeo.labs.workflowgraph.*`.

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
- History (2025.2), a "trail" in `--lwg-passed` (default teal `#0d9488`): steps done (`rnode:endDate` set, i.e.
  completed at least once) get a 2px border (padding 1px less, size unchanged) and a round check badge
  (`lwg-node-check`, `role="img"`, `labsWorkflowGraph.passedStep`); followed transitions get `is-taken`: color
  `--lwg-passed` whatever their palette color, stroke 2.4, `TAKEN_ARROW`, label tinted, drawn above the others and
  below the next ones. **The current look wins**: a current step is never `isPassed`, a transition leaving a
  current step is never `isTaken` (it is `is-next`). Steps only from the history, no count shown (no "xN"), no
  guessed path: transitions only come from the recorder. Model: `LWG.normalizeHistory`, `node.isPassed`,
  `edge.isTaken`, `edge.sourceIndex` (position in the step counting the ignored transitions, matched with the
  history `index`; a target mismatch is ignored with a warning).
- Branches not followed (asked by the user, 2025.2), only with a history: dim what was not done **and cannot
  happen anymore**; the steps still to come (the "future") keep their normal look, the current step and its
  transitions never change. Future = the current and `waiting` steps plus every step a transition leads to from
  them, loops included (so a loop back to an early step makes everything after it future). Reached = current,
  in the history nodes (started), `waiting`, or target of a followed transition. `node.isDimmed` = not reached and
  not future. `edge.isDimmed` = not next, not taken, and (source dimmed, or source not future and target not
  reached: never followed, cannot be anymore). Do not dim a transition between two reached steps that was not
  recorded: it may have been followed before the installation. Workflow done: every step never reached is dimmed.
  Look: `is-dimmed`, steps `opacity: var(--_lwg-dimmed)` + `grayscale(0.7)` + no shadow, transitions 80% of it,
  labels faded with `color-mix()` but opaque (their line passes below them). `--lwg-dimmed-opacity`, default 0.4.
  Drawing order of the transitions: dimmed, others, taken, next. Samples showing it: parallel (Stop after
  Cancelation), large (Rejected, only from phase 4); serial and contract dim no step (everything can still
  happen).

## Layout of the sources

- Maven modules: `nuxeo-labs-workflow-graph-core` (Java bundle, see below), `nuxeo-labs-workflow-graph-web` (JAR:
  web resources, OSGI-INF, i18n) and `nuxeo-labs-workflow-graph-package` (marketplace package). Version
  `2025.2.0-SNAPSHOT`, parent `org.nuxeo:nuxeo-parent:2025.24`.
- Java bundle (`nuxeo.labs.workflowgraph`):
  - `StepCompletedListener`: synchronous `beforeDocumentModification` listener on `RouteNode` documents. A step
    completes when it is saved with a new `rnode:endDate` (dirty, and different from `PREVIOUS_DOCUMENT_MODEL`):
    the transitions with `result=true` are the followed ones (only the first with
    `rnode:executeOnlyFirstTransition`, none for an end step). It fires `lwgWorkflowStepCompleted` on the workflow
    instance (category `Routing`, extended info `nodeId`, `transitions` = comma-separated positions). It must never
    throw (it would break the workflow engine): errors are logged.
  - `WorkflowHistoryReader` / `GetWorkflowHistoryOp`: access = administrator, or READ on the workflow instance or
    on one of its attached documents (checked with the user's session); then everything is read with
    `CoreInstance.doPrivileged`. 404 (`DocumentNotFoundException`) when the id is not a workflow instance, 403
    (`DocumentSecurityException`). JSON = the `WorkflowHistory` record. Transitions read from the audit backend
    (`docUUID` + `eventId`, at most `MAX_AUDIT_ENTRIES`).
  - Nuxeo does not keep the followed transitions (`result` is reset when the target starts): transitions before
    the installation are unknown, do not try to guess them.
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
```

Java tests: `WorkflowGraphFeature` (AuditFeature before AutomationFeature, routing deployed without blacklisting
the routing audit), `AbstractWorkflowHistoryTest` (models built with `RouteNode` documents, steps resumed with
`resumeInstance` and a button), `TestWorkflowHistory`, `TestWorkflowHistoryWithoutRecorder` (listener disabled by
`test-recorder-disabled-contrib.xml`).

Demo: `python3 -m http.server 8765` at the project root, then
`http://localhost:8765/dev/demo/index.html?wf=large&theme=dark` (`&dir=LR` forces the direction, `&history=off`
hides the history).

Fixtures: `dev/demo/samples.js` (Serial/Parallel Document Review and MainWF rebuilt from the Nuxeo sources,
synthetic "contract" and "large" workflows), each with a `history` in the format of the operation (built by
`history(graph, doneIds, [[source, label]])`). Anonymise any real graph before adding it. The interaction checks
that test the palette colors use `history: 'off'`.
