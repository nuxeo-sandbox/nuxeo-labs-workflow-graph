# Nuxeo Labs Workflow Graph

An alternative for the **"View Graph"** dialog of Nuxeo Web UI (Nuxeo LTS 2025):

## TL;DR

* Replaces the default graph ("View Graph" links)
* Drawing top to bottom or left to right
* With themed cards
* Current step and transitions are highlighted.
* Steps already done and transitions already followed are marked, branches not followed are dimmed (the
  transitions are recorded by the server part of the plugin in the audit of the documents, from its installation on).
* Controls to read large graphs:
  * Zoom
  * Fit to screen,
  * Center on the current step
  * Direction of the layout.
* Colors can be changed with CSS

![The graph in the Web UI dialog](README-Images/serial-review-2-fit.png)

| A large workflow opens zoomed on its current steps | `f`: the whole workflow (`c` to switch back to current node) |
| --- | --- |
| ![Large workflow, current steps](README-Images/complex-workflow-1-opening.png) | ![Large workflow, fitted](README-Images/complex-workflow-2-fit.png) |
| `Right arrow` to swith Left to Right | |
| ![Left to right](README-Images/complex-workflow-3-LR-opening.png) | ![Left to right, Hyland dark theme](README-Images/complex-workflow-4-LR-fit.png) |

## Requirements

- Nuxeo LTS 2025, **hotfix 2025.16 or later**: the recorder of the transitions followed (see
  [Server side](#server-side)) uses the audit routes added by this hotfix. The package targets this hotfix and the
  later ones.
- Nuxeo Web UI (package `nuxeo-web-ui`).

> [!WARNING]
> Nuxeo does not record the transitions followed by a workflow, so the plugin records them itself, in its own audit
> event (`lwgWorkflowStepCompleted`, see [Server side](#server-side)). Nuxeo may add an equivalent feature in a
> future hotfix of LTS 2025 (one audit entry on the documents each time a workflow step ends). **When it does, check
> the release notes of this plugin before upgrading Nuxeo**: with this version of the plugin, every completed step
> would then be written twice in the audit of the documents (the plugin's entry and Nuxeo's one), and the History
> tab of the documents would show both. The graph keeps reading the plugin's entries only, so it is not affected. A
> new version of the plugin will then use the entries of Nuxeo and target the matching Nuxeo hotfixes.

## Features

- **Automatic layout** ([dagre](https://github.com/dagrejs/dagre)), top to bottom by default or left to right.
  It ignores the drawing made in Nuxeo Studio.
- **Direction kept per workflow**: the direction chosen in the toolbar (or with the `↓` and `→` keys) is kept in
  the browser (local storage) for the workflow model, so a user can read one workflow top to bottom and another
  one left to right. Every instance of a model (e.g. every "Serial Document Review") then opens the same way.
- **Modern rendering**: cards with an icon per kind of step (step, multiple tasks, sub-workflow, fork, merge),
  Start/End pills, transition labels as chips, curved transitions with arrow heads, dotted background.
- **Current step(s)**: colored border, ring and "Current" badge. The ring stays visible at any zoom level, so
  the current steps can be spotted even when the whole graph is fitted. Parallel branches can have several
  current steps.
- **Transition colors**: as in Web UI's default graph, the transitions leaving a step that has several of them
  get different colors (5 colors, reused in turn), so they are easy to follow. A step with a single transition
  uses a neutral color.
- **Next transitions**: the transitions leaving the current step(s) keep their color and are drawn thicker, with
  bigger arrow heads and emphasized labels, on top of the other transitions. A single one is drawn in the
  highlight color.
- **History** (since 2025.2): the steps already done (completed at least once) get a border and a check badge, the
  transitions already followed are drawn in the same color (`--lwg-passed`), a bit thicker, as a trail from the
  start to the current step(s). The current look wins: a current step that was done before (loop) is shown as
  current, a transition leaving a current step is shown as a next transition. The history is read from the audit of
  a document attached to the workflow: what is recorded since the installation of the plugin, visible to the users
  who can read the document. See [Server side](#server-side) for what is recorded and its limits.
- **Branches not followed** (since 2025.2): what was not done and cannot happen anymore is faded and grayed, so
  the path and what can still happen stand out in a large workflow:
  - a step is dimmed when it never started (not current, not waiting for other branches, not the target of a
    followed transition) **and** cannot be reached anymore: no transition leads to it from a current step (or from
    a merge waiting for other branches). The steps still to come keep their normal look;
  - a transition is dimmed when it was never followed and cannot be followed anymore: its step is dimmed, or its
    step will not run again and its target never started. The current step and its transitions never change.

  Example, Parallel Document Review while the opinions are given: the Stop after "Cancelation" (Choose
  Participants will not run again) is dimmed, the two Stops after "Consolidate the Review" are not. With a loop back
  to an earlier step (e.g. "Changes requested" back to the preparation), everything after that step can happen
  again: nothing is dimmed there. When the workflow is done, every step never reached is dimmed. The strength can be
  changed (`--lwg-dimmed-opacity`). The dimming needs the whole history: it is only applied to the workflows started
  after the installation (their start step is recorded). For a workflow started before, what happened before the
  installation is unknown: the steps done and the transitions followed since are marked, nothing is dimmed. Without
  the history (no attached document can be read), nothing is marked nor dimmed.
- **Opening**: the graph is fitted to the dialog. When it would then be displayed under 50%, the view zooms to
  80% on the current step instead (press `f` key to see the whole graph). Switching the direction resets the view
  the same way.
- **Themes**: follows the Web UI theme (default, dark, Hyland light and dark); the main colors can be changed
  with CSS variables (see [Colors](#colors)).
- **Translations**: English and French. Labels coming from the workflow definition are translated as in Web UI.
- **Safe**: if the graph cannot be drawn, Web UI's default graph is opened.

## Keyboard, mouse and touch

| Action | Toolbar | Keyboard | Mouse / touch |
| --- | --- | --- | --- |
| Zoom in / out | `+` / `−` | `+` (or `=`) / `-` | pinch (touch screen, trackpad), Ctrl/⌘ + wheel |
| Fit to screen | fit button | `f` | |
| Center on the current step | target button | `c` (repeat to go to the next current step) | |
| Top to bottom / left to right | `↓` / `→` (the active one is highlighted) | `↓` / `→` (arrow keys) | |
| Pan | | | drag, wheel (Shift + wheel: horizontally) |
| Close | close button | `Escape` | |

The toolbar shows the zoom level (5% to 250%). The keys work once the graph has the focus: it has it when the
dialog opens, and after a click on the graph.

## How it works

- The data comes from the REST API: `GET /api/v1/workflow/{id}/graph` (steps, kinds, states, transitions and their
  labels), `GET /api/v1/workflow/{id}` (title of the dialog, name of the workflow model and attached documents,
  optional) and `GET /api/v1/id/{docId}/@audit` (history, optional, see [Server side](#server-side)). They are
  requested in parallel, the graph is drawn once all have answered.
- The history is read from the audit of a document attached to the workflow: the document of the page (document
  workflow bar) or the target documents of the task (task view) first, then the attached documents of the workflow.
  A document the user cannot read is skipped.
- Web UI's default graph is the `nuxeo-workflow-graph` element (jsPlumb, fixed 880x720 canvas, Studio positions).
  It is used by the document workflow bar and by the task view, which both only call its `show()` method. The
  element cannot be redefined, so this plugin **patches `show()`** once the element is defined: the plugin's
  dialog is created inside the element (where the default dialog lives) and the original `show()` is kept as a
  fallback. No Web UI file is modified.
- A step is "current" when its state is `suspended` (waiting for its tasks), as in Web UI.
- The direction is stored only when the user chooses left to right, under the key
  `nuxeo-labs-workflow-graph.direction.model.<workflowModelName>` of the browser's local storage (going back to
  top to bottom removes it). Nothing is stored on the server, so the choice is per browser.

| Call | If it fails |
| --- | --- |
| `GET /api/v1/workflow/{id}/graph` | the dialog closes and Web UI's usual error message is shown |
| `GET /api/v1/workflow/{id}` | the title is "Workflow", and the direction is kept for this workflow instance only |
| `GET /api/v1/id/{docId}/@audit` | the next attached document is tried; when none can be read, the graph is drawn without the history (a warning is logged in the browser console) |
| Layout or drawing error | the dialog closes and Web UI's default graph is opened |

> [!WARNING]
> The override of the display of the default graph (the patch of the `show()` method) is done in
> [lwg-override.js](nuxeo-labs-workflow-graph-web/src/main/resources/web/nuxeo.war/ui/nuxeo-labs-workflow-graph/lwg-override.js),
> which **uses the shadow DOM** to find the correct, original, element => it depends on this structure and the display
> **could break with a new version of nuxeo-web-ui**.
>
> Notice this is very unlikely, but it is the only way to patch the original dialog without forking Web UI (and we
> don't want to fork Web UI)

## Server side

Nuxeo does not keep the path followed by a graph workflow: the graph endpoint only tells which steps are current (a
step that is done goes back to the `ready` state, like a step never reached), the result of a transition is reset
as soon as its target step starts, and Nuxeo removes the done and canceled workflow instances with its daily cleanup.
So the plugin (since 2025.2) adds a small Java bundle, `nuxeo-labs-workflow-graph-core`, that records the steps done
and the transitions followed **in the audit of the documents attached to the workflow**. The graph reads them with
the REST API, as Web UI's History tab does: no server operation, no privileged access.

**Recorder: from the installation on.** A synchronous listener (`beforeDocumentModification`) detects that a step
completes (the workflow engine saves it with a new `rnode:endDate`, right after evaluating its transitions) and
records the transitions it follows: one audit entry per completed step, on **each** attached document (the ones that
still exist; nothing is recorded for a workflow without attached document):

| Field | Value |
| --- | --- |
| `eventId` | `lwgWorkflowStepCompleted` |
| `category` | `Routing` |
| `docUUID` | id of the attached document |
| `comment` | readable summary, e.g. `Task6d8 -> Task5c1 (sdr_finishTask6d8)`, abbreviated to 1000 characters |
| `extended.lwgWorkflowId` | id of the workflow instance |
| `extended.lwgModelName` | name of the workflow model, e.g. `SerialDocumentReview` |
| `extended.lwgNodeId` | id of the completed step |
| `extended.lwgTransitions` | positions of the followed transitions in the step (definition order, the order of the graph endpoint), list of numbers, empty for an end step |
| `extended.lwgTransitionNames` | names of the followed transitions, same order |
| `extended.lwgTargets` | ids of their target steps, same order |

As returned by `GET /api/v1/id/{docId}/@audit?eventId=lwgWorkflowStepCompleted` (shortened):

```json
{
  "entity-type": "logEntry",
  "category": "Routing",
  "principalName": "jdoe",
  "comment": "Task6d8 -> Task6d8 (sdr_validationTask6d8)",
  "docUUID": "1b2c3d4e-...",
  "eventId": "lwgWorkflowStepCompleted",
  "eventDate": "2026-11-09T10:15:30.123Z",
  "extended": {
    "lwgWorkflowId": "9f8e7d6c-...",
    "lwgModelName": "SerialDocumentReview",
    "lwgNodeId": "Task6d8",
    "lwgTransitions": [3],
    "lwgTransitionNames": ["sdr_validationTask6d8"],
    "lwgTargets": ["Task6d8"]
  }
}
```

The extended info keys start with `lwg`: in the OpenSearch audit backend, the extended info of every event share one
mapping, a generic name could clash with the one of another add-on, or of a future version of Nuxeo. Each key always
holds the same type.

The listener does not break a workflow: an error is logged and the workflow goes on, unless the transaction fails
anyway (concurrent update, interrupted thread, transaction already marked for rollback), where the error is
rethrown, as Nuxeo's event service does. Besides the fields above, the audit fills the ones of every entry (date,
user who completed the step, path, type and state of the document). Nothing else is stored: no task comment, no
workflow or step variable.

**Who can see it.** The users who can read the document. The graph reads the audit with
`GET /api/v1/id/{docId}/@audit?eventId=lwgWorkflowStepCompleted` (`READ` on the document is required, as for Web
UI's History tab) and keeps the entries of the workflow (`lwgWorkflowId`) itself: the audit cannot filter on extended
info. The entries also appear in the **History** tab and in the **Activity** sidebar of the document. The plugin adds
their labels to Web UI's translations (English and French): "Workflow step completed" (History), "completed a
workflow step" (Activity), and "Workflow" for the `Routing` category, which Web UI otherwise displays as a raw key,
also for its own workflow events.

**Limits.**

- Only what happened after the installation is known: a workflow started before shows the steps done and the
  transitions followed since, and nothing is dimmed (see [Features](#features)).
- The workflow engine evaluates the transitions with the variables of the moment: the recorded transitions are
  the ones it actually followed, a button alone would not tell (several transitions can share a button).
- With loops, a step done several times is marked once (the entries give the counts, the graph does not show them).
- The audit entries are written asynchronously, after the transaction commits: the last step may show up a moment
  after the task is completed.
- One entry per attached document: a workflow on 3 documents writes 3 identical entries per completed step, on
  their 3 audits.
- The dialog reads at most 10,000 entries of the event per document (10 pages of 1,000, most recent first): for a
  document with more, the oldest ones are ignored (a warning is logged in the browser console).
- The plugin deletes nothing: the entries stay in the audit of the documents, as any audit entry, also once Nuxeo has
  removed the workflow instance (Web UI only opens the graph of the running workflows, though).

**Disabling or replacing the recorder.** The recorder is the listener `lwgStepCompletedListener` (component
`nuxeo.labs.workflowgraph.listener`), overridden as any Nuxeo listener: listeners with the same name are merged, the
last deployed wins. Use a Studio XML extension (the `<extension>` element is enough), or a `*-config.xml` file in
`nxserver/config` with the `<require>` below.

- Stop recording:

  ```xml
  <component name="com.example.workflowgraph.recorder.disabled">
    <require>nuxeo.labs.workflowgraph.listener</require>
    <extension target="org.nuxeo.ecm.core.event.EventServiceComponent" point="listener">
      <listener name="lwgStepCompletedListener" enabled="false" />
    </extension>
  </component>
  ```

  No audit entry is written anymore (the audit contribution of the plugin can stay, it only declares the event). The
  entries already written stay in the audit of the documents and are still shown by the graph; the steps done and
  the transitions followed afterwards are unknown, as before the installation.
- Use your own recorder: same `<listener name="lwgStepCompletedListener" class="com.example.MyRecorder" />` (the
  events are kept). It must stay synchronous (an `EventListener`: the results of the transitions are reset as soon
  as the next step starts) and, for the graph to draw the history, fire `lwgWorkflowStepCompleted` on the attached
  documents with the event properties `lwgWorkflowId`, `lwgModelName`, `lwgNodeId`, `lwgTransitions`,
  `lwgTransitionNames` and `lwgTargets` (the audit contribution of the plugin stores them as the extended info of the
  table above). It can extend `StepCompletedListener` (`handleEvent`, `record`, `properties`).

There is no setting to hide the history: its entries are regular audit entries of the documents.

## Colors

By default, the colors derive from the Web UI theme variables (`--nuxeo-text-default`, `--nuxeo-box`,
`--nuxeo-page-background`, `--nuxeo-focus-ring-color`, `--nuxeo-primary-color`...), so the graph follows the theme
without any configuration.

**CSS variables are the way to change them.** The graph is drawn inside shadow DOM (the one of Web UI's
`nuxeo-workflow-graph` element, then the one of the plugin's dialog): a regular CSS rule written in a page, a theme
or a Studio bundle, such as `.lwg-node { border-color: red; }`, never reaches it. CSS custom properties (variables)
are inherited through shadow DOM boundaries: set them on `html`, the graph reads them.

| Variable | Default | Used for |
| --- | --- | --- |
| `--lwg-current` | `--nuxeo-focus-ring-color`, else `--nuxeo-primary-color` | current steps (border, ring, badge), and the transition leaving a current step when it is its only one |
| `--lwg-passed` | `#0d9488` (teal) | steps already done (border, check badge) and transitions already followed (line, arrow, label), whatever their transition color |
| `--lwg-dimmed-opacity` | `0.4` | not a color: opacity of the branches not followed, a number between 0 and 1 (not a percentage); steps use it, their transitions 80% of it, their labels are faded as much |
| `--lwg-transition-1` to `--lwg-transition-5` | `#16a34a` (green), `#ea580c` (orange), `#9333ea` (purple), `#db2777` (pink), `#0891b2` (cyan) | transitions of a step that has several of them, see below |
| `--lwg-edge` | mix of `--lwg-text` and `--lwg-bg` | transitions of a step that has a single one |
| `--lwg-color-start`, `--lwg-color-end` | `#1f9d63`, `#e5484d` | Start and End pills |
| `--lwg-color-step`, `--lwg-color-multi`, `--lwg-color-sub`, `--lwg-color-gateway` | `#3b7ff5`, `#8b5cf6`, `#0f9f96`, `#e8830c` | kinds of steps (icon and caption; gateway = fork and merge) |
| `--lwg-bg` | `--nuxeo-page-background` | canvas |
| `--lwg-card-bg` | `--nuxeo-box` | steps, labels and toolbar |
| `--lwg-text` | `--nuxeo-text-default` | text |
| `--lwg-grid` | mix of `--lwg-text` and `--lwg-bg` | dots of the canvas |

**Transition colors.** The transitions leaving the same step are told apart by their rank in the step (the order
of the workflow definition): the first one uses `--lwg-transition-1`, the second `--lwg-transition-2`, and so on;
after the fifth, the colors are reused (7 transitions: 1, 2, 3, 4, 5, 1, 2). The color depends on the rank only,
not on the meaning of the transition: the graph REST endpoint gives no transition id, only its source, target and
label. The labels get a border and a light background of the transition color; their text keeps the text color, so
it stays readable whatever the color.

**Derived colors.** Some colors have no variable of their own and are computed (`color-mix()`) from the ones
above: borders of the steps and of the labels, muted text (labels, captions), toolbar hover, and the light tints of
the ring, the badge, the labels and the Start/End pills. Change the base colors to change them. The icon of the
Start/End pills and the check of the steps already done are always white.

**Example.** Variables can be set:

- in the custom bundle of a Studio project (`nuxeo-<projectId>-custom-bundle.html`, imported by the main bundle):
  the values apply to every theme;
- in a Web UI theme (`themes/<name>/theme.html`): the values apply to this theme only, e.g. to have different
  colors in a light and in a dark theme.

```html
<custom-style>
  <style is="custom-style">
    html {
      /* current step */
      --lwg-current: #c2410c;
      /* steps already done, transitions already followed */
      --lwg-passed: #4d7c0f;
      /* branches not followed: less faded */
      --lwg-dimmed-opacity: 0.55;
      /* transitions of a step that has several of them */
      --lwg-transition-1: #15803d;
      --lwg-transition-2: #b91c1c;
      --lwg-transition-3: #1d4ed8;
      --lwg-transition-4: #a16207;
      --lwg-transition-5: #6d28d9;
      /* steps and canvas */
      --lwg-card-bg: #fffdf7;
      --lwg-bg: #f4f1ea;
    }
  </style>
</custom-style>
```

To try values without deploying anything, open a graph and run in the browser console:

```js
document.documentElement.style.setProperty('--lwg-transition-1', 'crimson');
```

Variables starting with `--_lwg-` are internal: they are redefined by the graph, setting them has no effect.

## Architecture

```
nuxeo-labs-workflow-graph-core/src/main/
├── java/nuxeo/labs/workflowgraph/
│   ├── StepCompletedListener.java     records the transitions followed (one audit entry per completed step, on
│   │                                  each attached document)
│   └── WorkflowHistoryConstants.java  event name, audit extended info keys
└── resources/
    ├── META-INF/MANIFEST.MF
    └── OSGI-INF/
        ├── lwg-audit-contrib.xml       audited event and its extended info
        └── lwg-listener-contrib.xml    the recorder

nuxeo-labs-workflow-graph-web/src/main/resources/
├── META-INF/MANIFEST.MF
├── OSGI-INF/
│   ├── deployment-fragment.xml        copies the web resources, merges the translations
│   └── lwg-webresources-contrib.xml   registers the bundle HTML with Web UI
└── web/nuxeo.war/ui/
    ├── i18n/messages.json, messages-fr.json   labels of the graph, and of the audit entries (History, Activity)
    └── nuxeo-labs-workflow-graph/
        ├── nuxeo-labs-workflow-graph-bundle.html   entry point (script order)
        ├── lwg-core.js                namespace, directions (storage), translations, text measuring, model, history
        ├── lwg-layout.js              geometry helpers and the layout, top to bottom or left to right (dagre)
        ├── lwg-icons.js               inline SVG icons (Material Icons)
        ├── lwg-styles.js              CSS of the graph (no animation)
        ├── lwg-renderer.js            LWG.Renderer: drawing, zoom, pan, fit, center, direction (framework-free)
        ├── nuxeo-labs-workflow-graph-dialog.html   Polymer dialog: title, loading, graph, history (audit),
        │                                            direction memory
        ├── lwg-override.js            patch of nuxeo-workflow-graph.show()
        └── vendor/dagre.min.js        dagre 3.1.3 (MIT), unmodified
```

Plain JavaScript and HTML imports, like Web UI add-ons built without a JS toolchain: no npm build is needed and
the Maven build only packages the files. The Java bundle has no dependency other than Nuxeo.

## Development

The `dev/` folder is not packaged. Nothing is installed by the project: the browser tool uses an existing
`node_modules` folder and an existing Chrome.

| Command | What it does |
| --- | --- |
| `node --test dev/test` | Unit tests of the directions and their storage, translations, model (including the transition colors and the history read from the audit entries), geometry and layout (every sample in both directions: steps placed without overlap, transitions attached to their steps, labels off the steps). Node 20+, no dependency |
| `python3 -m http.server 8765` then `http://localhost:8765/dev/demo/index.html` | Demo of the renderer with the sample workflows, themes and languages (URL parameters: `wf`, `theme`, `lang`, `dir` to force `TB` or `LR`, otherwise the direction is kept per sample as in the dialog; `history=off` hides the history) |
| `node dev/tools/screenshots.mjs [filter]` | Renders every sample in every theme (and left to right) in headless Chrome and writes `dev/out/demo/*.png`, then checks the interactions: initial view (zoom on the current step for a large graph), `F`, `C` (cycling), `+`, `-`, minimum zoom, toolbar, Ctrl + wheel, wheel, drag, no animation, steps not focusable, transition colors, color overrides, history (steps done, transitions followed, branches not followed, steps still to come not dimmed, sizes, drawing order, `--lwg-passed`, `--lwg-dimmed-opacity`), direction switch (toolbar and `↓` / `→` keys, view reset, kept per workflow, not stored for TB). Fails on any console error or warning. Filter `checks`: interaction checks only |
| `mvn clean install` | Builds the bundles and the package, and runs the Java tests (JUnit 4, in-memory audit): entries written by the recorder on the attached document (values of every key, JSON as returned by the REST API, nothing on the workflow instance) on a simple path, a loop, a fork and merge, a merge waiting for another branch, "execute only the first transition", a step with several tasks, a canceled workflow, several attached documents, an attached document deleted while the workflow runs, a workflow without attached document, the length of the audit comment, the recorder disabled. Add `-Dnuxeo.test.audit=sql` to run them with the SQL audit backend (H2) |

Environment variables of the browser tool:

| Variable | Description |
| --- | --- |
| `LWG_NODE_MODULES` | `node_modules` folder containing `puppeteer-core` |
| `CHROME_PATH` | Chrome or chrome-headless-shell executable (default: Google Chrome on macOS) |

The samples (`dev/demo/samples.js`) are SerialDocumentReview, ParallelDocumentReview and MainWF rebuilt from the
Nuxeo sources, plus two synthetic workflows: "contract" (fork, merge, loops, sub-workflow, long titles) and
"large" (59 steps, two current steps in parallel branches). Each one has an audit: the entries the recorder would
write on an attached document, in the format of `GET /api/v1/id/{docId}/@audit`, plus one entry of another workflow
(ignored).

## Build

### Local Build

After cloning the repo:

```bash
cd /path/to/nuxeo-labs-workflow-graph
mvn clean install
```

The marketplace package is produced at `nuxeo-labs-workflow-graph-package/target/nuxeo-labs-workflow-graph-package-<VERSION>.zip`. To install it:

```bash
nuxeoctl mp-install /path/to/nuxeo-labs-workflow-graph-package-<VERSION>.zip
```

### Nuxeo marketplace

The package is available in Nuxeo Marketplace. So, for example, you can just add `nuxeo-labs-workflow-graph` to your Studio dependencies, or in the `NUXEO_PACKAGES` variable of a Docker deployment.

## Third-party code

- [dagre](https://github.com/dagrejs/dagre) 3.1.3, MIT License (`vendor/dagre.LICENSE.txt`), unmodified
  `dist/dagre.min.js` (SHA-256 `54a503e346f93ca0bb10abe7999587e037262935687aca45eb4e4b0f64bbb578`).
- Material Icons by Google, Apache License 2.0 (SVG paths in `lwg-icons.js`).

## Support

These features are not part of the Nuxeo Production platform. They are not supported, and are provided
without warranty of any kind. Use them at your own risk.

> [!TIP]
> The Nuxeo Product Team *may* integrate the changes in the platform, but there are many other priorities.
> So, if you need this feature,  **we strongly recommend a Nuxeo Partner or your dev team forks the code
> and takes ownership** (tuning, maintenance, support)

## License

[Apache License 2.0](http://www.apache.org/licenses/LICENSE-2.0)

## About Nuxeo

[Nuxeo](https://www.hyland.com/en/products/nuxeo-platform), developed by [Hyland](https://www.hyland.com),
is a Content Services platform. It provides an easy-to-use, highly customizable and extensible
architecture for building content-centric applications.
