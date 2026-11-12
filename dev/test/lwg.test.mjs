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

// Unit tests of the browser-independent part (core, geometry, layout), run with: node --test dev/test
// The production files are loaded as is into a VM context, no npm dependency is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(here, '..', '..');
const webDir = path.join(
  projectDir,
  'nuxeo-labs-workflow-graph-web/src/main/resources/web/nuxeo.war/ui/nuxeo-labs-workflow-graph',
);
const require = createRequire(import.meta.url);
const samples = require(path.join(projectDir, 'dev/demo/samples.js'));

// Same order as nuxeo-labs-workflow-graph-bundle.html (the DOM-dependent files excepted)
const FILES = ['lwg-core.js', 'vendor/dagre.min.js', 'lwg-layout.js'];

// Loads the production scripts in a fresh context, as classic scripts (dagre needs structuredClone).
function load(globals) {
  const ctx = Object.assign({ console, structuredClone }, globals || {});
  ctx.window = ctx;
  vm.createContext(ctx);
  FILES.forEach((f) => vm.runInContext(fs.readFileSync(path.join(webDir, f), 'utf8'), ctx, { filename: f }));
  return ctx;
}

const ctx = load();
const LWG = ctx.NuxeoLabs.WorkflowGraph;
const G = LWG.geometry;

function boxOf(node, p) {
  return { x1: p.x - node.width / 2, y1: p.y - node.height / 2, x2: p.x + node.width / 2, y2: p.y + node.height / 2 };
}

function overlap(a, b) {
  return a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
}

function distanceToBox(p, b) {
  const dx = Math.max(b.x1 - p.x, 0, p.x - b.x2);
  const dy = Math.max(b.y1 - p.y, 0, p.y - b.y2);
  return Math.hypot(dx, dy);
}

/* ==================== Core ==================== */

test('t: Web UI bundle first, English fallback, never a raw key of the plugin', () => {
  const c = load();
  const L = c.NuxeoLabs.WorkflowGraph;
  assert.equal(L.t('labsWorkflowGraph.toolbar.fit'), 'Fit to screen');
  c.nuxeo = { I18n: { translate: (k) => (k === 'labsWorkflowGraph.toolbar.fit' ? 'Ajuster' : k) } };
  assert.equal(L.t('labsWorkflowGraph.toolbar.fit'), 'Ajuster');
  assert.equal(L.t('labsWorkflowGraph.toolbar.zoomIn'), 'Zoom in');
});

// Labels of the audit entries of the recorder, used by Web UI (History tab, Activity sidebar), not by the plugin
const AUDIT_LABEL_KEYS = [
  'activity.lwgWorkflowStepCompleted',
  'eventCategory.Routing',
  'eventType.lwgWorkflowStepCompleted',
];

test('every fallback message is in both translation files, and the reverse (plus the audit labels)', () => {
  const i18nDir = path.join(webDir, '..', 'i18n');
  const en = JSON.parse(fs.readFileSync(path.join(i18nDir, 'messages.json'), 'utf8'));
  const fr = JSON.parse(fs.readFileSync(path.join(i18nDir, 'messages-fr.json'), 'utf8'));
  const keys = Object.keys(LWG.FALLBACK_MESSAGES).concat(AUDIT_LABEL_KEYS).sort();
  assert.deepEqual(Object.keys(en).sort(), keys);
  assert.deepEqual(Object.keys(fr).sort(), keys);
  Object.keys(LWG.FALLBACK_MESSAGES).forEach((k) => assert.equal(en[k], LWG.FALLBACK_MESSAGES[k], k));
  AUDIT_LABEL_KEYS.forEach((k) => assert.ok(en[k] && fr[k], k));
  // the event of the labels is the one of the recorder (server side)
  const javaDir = path.join(projectDir, 'nuxeo-labs-workflow-graph-core/src/main/java/nuxeo/labs/workflowgraph');
  const constants = fs.readFileSync(path.join(javaDir, 'WorkflowHistoryConstants.java'), 'utf8');
  const event = /STEP_COMPLETED_EVENT = "([^"]+)"/.exec(constants)[1];
  assert.ok(AUDIT_LABEL_KEYS.includes(`eventType.${event}`), event);
  assert.ok(AUDIT_LABEL_KEYS.includes(`activity.${event}`), event);
});

test('translateLabel: client translation, readable snake_case keys, empty values', () => {
  const c = load({ nuxeo: { I18n: { translate: (k) => (k === 'wf.title' ? 'My workflow' : k) } } });
  const L = c.NuxeoLabs.WorkflowGraph;
  assert.equal(L.translateLabel('wf.title'), 'My workflow');
  assert.equal(L.translateLabel('automatic_transition'), 'Automatic transition');
  assert.equal(L.translateLabel('Review Start'), 'Review Start');
  assert.equal(L.translateLabel(null), '');
  assert.equal(L.translateLabel(undefined), '');
});

test('wrapText and truncateToWidth respect the width and the number of lines', () => {
  const measure = (s) => s.length * 7;
  const wrapped = LWG.wrapText('one two three four five six seven eight nine ten', 70, 2, measure);
  assert.equal(wrapped.lines.length, 2);
  assert.equal(wrapped.truncated, true);
  assert.ok(wrapped.lines[1].endsWith('…'));
  wrapped.lines.forEach((l) => assert.ok(measure(l) <= 70, l));
  const long = LWG.wrapText('Supercalifragilisticexpialidocious', 70, 3, measure);
  long.lines.forEach((l) => assert.ok(measure(l) <= 70, l));
  assert.deepEqual(Array.from(LWG.wrapText('', 70, 3, measure).lines), ['']);
  assert.equal(LWG.truncateToWidth('short', 70, measure), 'short');
  assert.ok(measure(LWG.truncateToWidth('a much longer text', 70, measure)) <= 70);
});

test('buildModel: kinds, current steps, next transitions and warnings', () => {
  const model = LWG.buildModel(samples.contract.graph);
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  assert.equal(byId.get('n-start').kind, 'start');
  assert.equal(byId.get('n-stop').kind, 'end');
  assert.equal(byId.get('n-fork').kind, 'fork');
  assert.equal(byId.get('n-merge').kind, 'merge');
  assert.equal(byId.get('n-sign').kind, 'multiTask');
  assert.equal(byId.get('n-board').kind, 'subWorkflow');
  assert.equal(byId.get('n-decision').kind, 'step');
  assert.deepEqual(Array.from(model.currentNodeIds), ['n-legal']);
  // "waiting" (merge) is not current
  assert.equal(byId.get('n-merge').isCurrent, false);
  const next = Array.from(model.edges.filter((e) => e.isNext).map((e) => e.target));
  assert.deepEqual(next.sort(), ['n-merge', 'n-prepare']);
  assert.ok(byId.get('n-legal').titleTruncated);
  assert.equal(model.warnings.length, 0);

  const broken = LWG.buildModel({
    nodes: [{ id: 'a', title: 'A' }, { id: 'a', title: 'A again' }, { title: 'no id' }],
    transitions: [{ nodeSourceId: 'a', nodeTargetId: 'missing', label: 'x' }],
  });
  assert.equal(broken.nodes.length, 1);
  assert.equal(broken.edges.length, 0);
  assert.equal(broken.warnings.length, 3);
  assert.equal(LWG.buildModel(null).nodes.length, 0);
});

test('buildModel: transition colors by rank in their step, neutral when the step has a single one', () => {
  const colors = (model, source) =>
    Array.from(model.edges.filter((e) => e.source === source).map((e) => e.colorIndex));
  const serial = LWG.buildModel(samples.serial.graph);
  // current step with 4 transitions, in the order of the definition
  assert.deepEqual(colors(serial, 'Task6d8'), [1, 2, 3, 4]);
  serial.edges.filter((e) => e.source === 'Task375f').forEach((e) => assert.equal(e.colorIndex, 0, e.id));

  // beyond TRANSITION_COLOR_COUNT the colors are reused in turn; ignored transitions are not counted
  assert.equal(LWG.TRANSITION_COLOR_COUNT, 5);
  const targets = ['b', 'c', 'missing', 'b', 'c', 'b', 'c', 'b'];
  const model = LWG.buildModel({
    nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    transitions: targets
      .map((t) => ({ nodeSourceId: 'a', nodeTargetId: t, label: 'x' }))
      .concat([{ nodeSourceId: 'b', nodeTargetId: 'c', label: 'single' }]),
  });
  assert.deepEqual(colors(model, 'a'), [1, 2, 3, 4, 5, 1, 2]);
  assert.deepEqual(colors(model, 'b'), [0]);
  assert.equal(model.warnings.length, 1);
});

/* ==================== History ==================== */

// History of a sample, in the format returned by the operation LabsWorkflowGraph.GetWorkflowGraph (built by the
// server from the audit entries of the recorder, tested in Java)
const historyOf = (sample) => sample.history;
const plain = (v) => JSON.parse(JSON.stringify(v));

test('normalizeHistory: object or JSON string, invalid entries dropped, null when not a history', () => {
  const raw = {
    nodes: [{ id: 'a', completed: true, count: 2 }, { id: 'b', completed: false }, { completed: true }],
    transitions: [
      { source: 'a', index: 1, name: 'x', target: 'b', count: 3 },
      { source: 'a', index: -1, target: 'b' },
      { source: 'a', index: '1', target: 'b' },
      { index: 0, target: 'b' },
      { source: 'b', index: 0 },
    ],
  };
  const h = LWG.normalizeHistory(raw);
  assert.deepEqual(plain(h), {
    nodes: [
      { id: 'a', completed: true, count: 2 },
      { id: 'b', completed: false, count: 0 },
    ],
    transitions: [
      { source: 'a', index: 1, target: 'b', count: 3 },
      { source: 'b', index: 0, target: null, count: 0 },
    ],
  });
  assert.deepEqual(plain(LWG.normalizeHistory(JSON.stringify(raw))), plain(h));
  for (const invalid of [null, undefined, '', 'not json', 42, {}, { nodes: [] }, { nodes: {}, transitions: [] }]) {
    assert.equal(LWG.normalizeHistory(invalid), null, String(invalid));
  }
});

test('samples: histories in the format of the operation, kept whole by normalizeHistory', () => {
  for (const [name, sample] of Object.entries(samples)) {
    const history = historyOf(sample);
    assert.equal(history.truncated, false, name);
    const normalized = LWG.normalizeHistory(history);
    assert.equal(normalized.nodes.length, history.nodes.length, name);
    assert.equal(normalized.transitions.length, history.transitions.length, name);
    assert.ok(normalized.nodes.every((n) => n.completed && n.count === 1), name);
  }
});

test('buildModel with a history: steps done, transitions followed, the current look wins', () => {
  // serial: Start and Choose Participants done, Validate (current) done once; the self-loop "Rejection" it followed
  // leaves the current step: shown as next, not as followed
  const model = LWG.buildModel(samples.serial.graph, { history: historyOf(samples.serial) });
  assert.equal(model.hasHistory, true);
  assert.equal(model.historyComplete, true);
  assert.equal(model.warnings.length, 0);
  const passed = Array.from(model.nodes.filter((n) => n.isPassed).map((n) => n.id)).sort();
  assert.deepEqual(passed, ['Task375f', 'Task38e']);
  const current = model.nodes.find((n) => n.id === 'Task6d8');
  assert.equal(current.isCurrent && !current.isPassed, true);
  const taken = Array.from(model.edges.filter((e) => e.isTaken).map((e) => `${e.source}>${e.target}:${e.label}`));
  assert.deepEqual(taken.sort(), ['Task375f>Task38e:start', 'Task38e>Task6d8:Review Start']);
  assert.ok(model.edges.every((e) => !(e.isTaken && e.isNext)));
  // positions in the step, in the definition order
  assert.deepEqual(
    Array.from(model.edges.filter((e) => e.source === 'Task6d8').map((e) => e.sourceIndex)),
    [0, 1, 2, 3],
  );

  // without a history, nothing is done or followed
  const none = LWG.buildModel(samples.serial.graph);
  assert.equal(none.hasHistory, false);
  assert.equal(none.historyComplete, false);
  assert.ok(none.nodes.every((n) => !n.isPassed) && none.edges.every((e) => !e.isTaken));

  // every sample history matches its graph, and is complete (the start step is done)
  for (const [name, sample] of Object.entries(samples)) {
    const m = LWG.buildModel(sample.graph, { history: historyOf(sample) });
    assert.equal(m.warnings.length, 0, `${name}: ${m.warnings}`);
    assert.equal(m.historyComplete, true, name);
    assert.ok(m.nodes.some((n) => n.isPassed) && m.edges.some((e) => e.isTaken), name);
  }
});

// Steps a transition leads to from the current and waiting steps, loops included (independent implementation).
function futureOf(model) {
  const future = new Set(model.nodes.filter((n) => n.isCurrent).map((n) => n.id));
  let size = -1;
  while (size !== future.size) {
    size = future.size;
    model.edges.filter((e) => future.has(e.source)).forEach((e) => future.add(e.target));
  }
  return future;
}

test('buildModel with a history: branches not followed are dimmed, the steps still to come are not', () => {
  const ids = (list) => Array.from(list.map((x) => x.id)).sort();
  const dimmedEdges = (m) => Array.from(m.edges.filter((e) => e.isDimmed).map((e) => `${e.source}>${e.target}`));
  const build = (name) => LWG.buildModel(samples[name].graph, { history: historyOf(samples[name]) });

  // serial: Update the Document and Stop can still happen (from the current step): not dimmed. Choose Participants
  // will not run again, its "Cancelation" to Stop was not followed: dimmed, even if Stop is not
  const serial = build('serial');
  assert.deepEqual(ids(serial.nodes.filter((n) => n.isDimmed)), []);
  assert.deepEqual(dimmedEdges(serial), ['Task38e>Task5c1']);
  assert.ok(serial.edges.filter((e) => e.isNext).every((e) => !e.isDimmed));

  // parallel: the Stop after "Cancelation" cannot be reached anymore, the two Stops after the review can
  const parallel = build('parallel');
  assert.deepEqual(ids(parallel.nodes.filter((n) => n.isDimmed)), ['Task2225']);
  assert.deepEqual(dimmedEdges(parallel), ['Task2556>Task2225']);

  // large: only the quality check of phase 4 can reject, it will not run again
  const large = build('large');
  assert.deepEqual(ids(large.nodes.filter((n) => n.isDimmed)), ['l-rejected']);
  assert.deepEqual(dimmedEdges(large), ['l-p4-check>l-rejected']);

  // contract: "Changes requested" loops back to the preparation, from which every step can happen again
  const contract = build('contract');
  assert.equal(contract.nodes.filter((n) => n.isDimmed).length + contract.edges.filter((e) => e.isDimmed).length, 0);
  // a transition between two steps reached, never followed ("Approved"), is not dimmed: the recorder may have failed
  // to record it
  const approved = contract.edges.find((e) => e.label === 'Approved');
  assert.equal(approved.isTaken || approved.isDimmed, false);

  // every sample: a dimmed step is never current, passed, the target of a followed transition or still to come;
  // a dimmed transition is never next nor followed, and cannot be followed anymore
  for (const [name, sample] of Object.entries(samples)) {
    const m = LWG.buildModel(sample.graph, { history: historyOf(sample) });
    const byId = new Map(m.nodes.map((n) => [n.id, n]));
    const future = futureOf(m);
    m.nodes
      .filter((n) => n.isDimmed)
      .forEach((n) => assert.ok(!n.isCurrent && !n.isPassed && !future.has(n.id), `${name}: ${n.id}`));
    m.edges.filter((e) => e.isTaken).forEach((e) => assert.ok(!byId.get(e.target).isDimmed, `${name}: ${e.id}`));
    m.edges
      .filter((e) => e.isDimmed)
      .forEach((e) => assert.ok(!e.isNext && !e.isTaken && !future.has(e.source), `${name}: ${e.id}`));
    // without a history, nothing is dimmed
    const none = LWG.buildModel(sample.graph);
    assert.ok(none.nodes.every((n) => !n.isDimmed) && none.edges.every((e) => !e.isDimmed), name);
  }
});

test('buildModel with a history: dimmed = never reached (current, started, waiting, followed) and not to come', () => {
  const graph = {
    nodes: [
      { id: 'start', state: 'ready', isStartNode: true },
      { id: 'a', state: 'ready' },
      { id: 'current', state: 'suspended' },
      { id: 'next', state: 'ready' },
      { id: 'end', state: 'ready' },
      { id: 'other', state: 'ready' },
      { id: 'otherEnd', state: 'ready' },
      { id: 'started', state: 'ready' },
      { id: 'merge', state: 'waiting' },
      { id: 'afterMerge', state: 'ready' },
    ],
    transitions: [
      { nodeSourceId: 'start', nodeTargetId: 'a', label: 'followed' },
      { nodeSourceId: 'a', nodeTargetId: 'current', label: 'followed too' },
      { nodeSourceId: 'a', nodeTargetId: 'other', label: 'to a branch not followed' },
      { nodeSourceId: 'a', nodeTargetId: 'end', label: 'shortcut not followed' },
      { nodeSourceId: 'current', nodeTargetId: 'next', label: 'next' },
      { nodeSourceId: 'next', nodeTargetId: 'end', label: 'to come' },
      { nodeSourceId: 'other', nodeTargetId: 'otherEnd', label: 'in the branch' },
      { nodeSourceId: 'other', nodeTargetId: 'merge', label: 'from the branch' },
      { nodeSourceId: 'started', nodeTargetId: 'merge', label: 'not recorded' },
      { nodeSourceId: 'merge', nodeTargetId: 'afterMerge', label: 'after the merge' },
    ],
  };
  const history = {
    // "started": listed but not completed (a history may list the steps started): reached
    nodes: [
      { id: 'start', completed: true },
      { id: 'a', completed: true },
      { id: 'started', completed: false },
    ],
    transitions: [
      { source: 'start', index: 0, target: 'a' },
      { source: 'a', index: 0, target: 'current' },
    ],
  };
  const dimmed = (model) => ({
    nodes: Array.from(model.nodes.filter((n) => n.isDimmed).map((n) => n.id)).sort(),
    edges: Array.from(model.edges.filter((e) => e.isDimmed).map((e) => e.label)).sort(),
  });
  // "next", "end" (from the current step) and "afterMerge" (from the waiting merge) are still to come
  assert.deepEqual(dimmed(LWG.buildModel(graph, { history })), {
    nodes: ['other', 'otherEnd'],
    edges: ['from the branch', 'in the branch', 'shortcut not followed', 'to a branch not followed'],
  });

  // the workflow is done (no current step, no waiting merge): every step never reached is dimmed
  const done = {
    nodes: graph.nodes.map((n) => Object.assign({}, n, { state: 'ready' })),
    transitions: graph.transitions,
  };
  const doneHistory = {
    nodes: history.nodes.concat({ id: 'current', completed: true }, { id: 'next', completed: true }),
    transitions: history.transitions.concat({ source: 'current', index: 0, target: 'next' }),
  };
  assert.deepEqual(dimmed(LWG.buildModel(done, { history: doneHistory })), {
    nodes: ['afterMerge', 'end', 'merge', 'other', 'otherEnd'],
    edges: [
      'after the merge',
      'from the branch',
      'in the branch',
      // the merge never started: this transition was never followed
      'not recorded',
      'shortcut not followed',
      'to a branch not followed',
      'to come',
    ],
  });
});

test('buildModel with a history: incomplete (start step not recorded) marks what is known, dims nothing', () => {
  // serial: the workflow started before the installation, only the rejection of the current step was recorded
  const graph = samples.serial.graph;
  const full = historyOf(samples.serial);
  const partialHistory = {
    nodes: full.nodes.filter((n) => n.id === 'Task6d8'),
    transitions: full.transitions.filter((t) => t.source === 'Task6d8'),
  };
  const partial = LWG.buildModel(graph, { history: partialHistory });
  assert.equal(partial.hasHistory, true);
  assert.equal(partial.historyComplete, false);
  assert.ok(partial.nodes.every((n) => !n.isDimmed) && partial.edges.every((e) => !e.isDimmed));
  // nothing else is known: Start and Choose Participants are not marked done
  assert.deepEqual(Array.from(partial.nodes.filter((n) => n.isPassed)), []);

  // nothing recorded at all (an attached document could be read): same
  const nothing = { nodes: [], transitions: [], truncated: false };
  const empty = LWG.buildModel(graph, { history: nothing });
  assert.equal(empty.historyComplete, false);
  assert.ok(empty.nodes.every((n) => !n.isDimmed && !n.isPassed) && empty.edges.every((e) => !e.isDimmed));

  // the start step is current: nothing happened before it, the history is complete
  const atStart = {
    nodes: [
      { id: 's', state: 'suspended', isStartNode: true },
      { id: 'x', state: 'ready' },
      { id: 'y', state: 'ready', isEndNode: true },
    ],
    transitions: [
      { nodeSourceId: 's', nodeTargetId: 'x', label: 'go' },
      { nodeSourceId: 'x', nodeTargetId: 'y', label: 'end' },
    ],
  };
  const fresh = LWG.buildModel(atStart, { history: nothing });
  assert.equal(fresh.historyComplete, true);
  // everything can still happen
  assert.ok(fresh.nodes.every((n) => !n.isDimmed) && fresh.edges.every((e) => !e.isDimmed));
});

test('buildModel with a history: matched by position in the step, wrong targets and unknown entries ignored', () => {
  const graph = {
    nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    transitions: [
      { nodeSourceId: 'a', nodeTargetId: 'missing', label: 'ignored' },
      { nodeSourceId: 'a', nodeTargetId: 'b', label: 'to b' },
      { nodeSourceId: 'a', nodeTargetId: 'c', label: 'to c' },
      { nodeSourceId: 'b', nodeTargetId: 'c', label: 'b to c' },
    ],
  };
  const history = {
    nodes: [{ id: 'a', completed: true }, { id: 'b', completed: false }],
    transitions: [
      // position 1 of "a" is "to b": the transition ignored by the graph is counted
      { source: 'a', index: 1, target: 'b' },
      // position 2 of "a" goes to "c", not to "b": ignored with a warning
      { source: 'a', index: 2, target: 'b' },
      // not in the graph
      { source: 'c', index: 0, target: 'a' },
    ],
  };
  const model = LWG.buildModel(graph, { history });
  const byLabel = new Map(model.edges.map((e) => [e.label, e]));
  assert.equal(byLabel.get('to b').isTaken, true);
  assert.equal(byLabel.get('to c').isTaken, false);
  assert.equal(byLabel.get('b to c').isTaken, false);
  assert.deepEqual(
    Array.from(model.nodes.map((n) => `${n.id}:${n.isPassed}`)),
    ['a:true', 'b:false', 'c:false'],
  );
  // unknown node (graph), wrong target, not found (history)
  assert.equal(model.warnings.length, 3, model.warnings.join('; '));
  assert.ok(model.warnings.some((w) => /not to b/.test(w)));
  assert.ok(model.warnings.some((w) => /1 followed transition\(s\) not found/.test(w)));

  const invalid = LWG.buildModel(graph, { history: 'not json' });
  assert.equal(invalid.hasHistory, false);
  assert.ok(invalid.warnings.includes('Invalid workflow history, ignored'));
});

// Minimal localStorage
function fakeStorage(failing) {
  const data = new Map();
  const check = () => {
    if (failing) {
      throw new Error('storage not available');
    }
  };
  return {
    data,
    getItem: (k) => (check(), data.has(k) ? data.get(k) : null),
    setItem: (k, v) => (check(), data.set(k, String(v))),
    removeItem: (k) => (check(), data.delete(k)),
  };
}

test('normalizeDirection: TB by default, case-insensitive', () => {
  assert.equal(LWG.normalizeDirection('lr'), 'LR');
  assert.equal(LWG.normalizeDirection(' TB '), 'TB');
  assert.equal(LWG.normalizeDirection('BT'), 'TB');
  assert.equal(LWG.normalizeDirection(null), 'TB');
});

test('directionStorageKey: per workflow model, else per instance, else none', () => {
  const byModel = LWG.directionStorageKey({ workflowModelName: 'SerialDocumentReview', name: 'x' }, 'id-1');
  assert.equal(byModel, LWG.directionStorageKey({ workflowModelName: 'SerialDocumentReview' }, 'id-2'));
  assert.notEqual(byModel, LWG.directionStorageKey({ workflowModelName: 'ParallelDocumentReview' }, 'id-1'));
  assert.equal(LWG.directionStorageKey({ name: 'SerialDocumentReview' }, 'id-1'), byModel);
  const byInstance = LWG.directionStorageKey(null, 'id-1');
  assert.ok(byInstance && byInstance !== LWG.directionStorageKey(null, 'id-2'));
  assert.equal(LWG.directionStorageKey(null, ''), null);
});

test('loadDirection / saveDirection: kept per key, default not stored, storage errors ignored', () => {
  const store = fakeStorage();
  const c = load({ localStorage: store });
  const L = c.NuxeoLabs.WorkflowGraph;
  const serial = L.directionStorageKey({ workflowModelName: 'SerialDocumentReview' });
  const parallel = L.directionStorageKey({ workflowModelName: 'ParallelDocumentReview' });
  assert.equal(L.loadDirection(serial), 'TB');
  L.saveDirection(serial, 'LR');
  assert.equal(L.loadDirection(serial), 'LR');
  assert.equal(L.loadDirection(parallel), 'TB');
  L.saveDirection(serial, 'TB');
  assert.equal(L.loadDirection(serial), 'TB');
  assert.equal(store.data.size, 0, 'the default direction is not stored');
  store.data.set(serial, 'garbage');
  assert.equal(L.loadDirection(serial), 'TB');
  L.saveDirection(null, 'LR');
  assert.equal(store.data.size, 1);

  const failing = load({ localStorage: fakeStorage(true) }).NuxeoLabs.WorkflowGraph;
  failing.saveDirection(serial, 'LR');
  assert.equal(failing.loadDirection(serial), 'TB');
  const none = load().NuxeoLabs.WorkflowGraph;
  none.saveDirection(serial, 'LR');
  assert.equal(none.loadDirection(serial), 'TB');
});

/* ==================== Geometry ==================== */

test('fitTransform: centered below the toolbar, clamped, null without size', () => {
  assert.equal(G.fitTransform(100, 100, 0, 500), null);
  const big = G.fitTransform(2000, 1000, 1000, 600, { margin: 16, top: 60, minScale: 0.05, maxScale: 1 });
  assert.ok(Math.abs(big.scale - (1000 - 32) / 2000) < 1e-9);
  assert.ok(Math.abs(big.x - (1000 - 2000 * big.scale) / 2) < 1e-9);
  assert.ok(big.y >= 60);
  const small = G.fitTransform(100, 50, 1000, 600, { margin: 16, top: 60, maxScale: 1 });
  assert.equal(small.scale, 1);
  const huge = G.fitTransform(100000, 100000, 1000, 600, { minScale: 0.05 });
  assert.equal(huge.scale, 0.05);
});

test('zoomAround keeps the screen point fixed', () => {
  const t = { scale: 0.5, x: 40, y: -20 };
  const z = G.zoomAround(t, 1.25, 300, 200);
  const before = { x: (300 - t.x) / t.scale, y: (200 - t.y) / t.scale };
  const after = { x: (300 - z.x) / z.scale, y: (200 - z.y) / z.scale };
  assert.ok(Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9);
});

test('paths, arrow heads and shortened ends', () => {
  assert.equal(G.basisPath([{ x: 0, y: 0 }, { x: 10, y: 0 }]), 'M0,0L10,0');
  const curve = G.basisPath([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }]);
  assert.ok(curve.startsWith('M0,0') && curve.endsWith('L20,0'), curve);
  const rounded = G.roundedPath([{ x: 0, y: 0 }, { x: 0, y: 40 }, { x: 40, y: 40 }], 10);
  assert.ok(rounded.includes('Q0,40 10,40'), rounded);
  const short = G.shortenEnd([{ x: 0, y: 0 }, { x: 0, y: 100 }], 6);
  assert.deepEqual({ ...short[1] }, { x: 0, y: 94 });
  assert.equal(G.shortenEnd([{ x: 0, y: 0 }, { x: 0, y: 4 }], 6)[1].y, 2);
  // arrow pointing down: the tip is the lowest point
  const arrow = G.arrowHead({ x: 50, y: 100 }, { x: 50, y: 0 }, 9, 8);
  assert.ok(arrow.startsWith('M50,100L'), arrow);
  const ys = arrow.match(/-?\d+(\.\d+)?/g).filter((v, i) => i % 2 === 1).map(Number);
  assert.equal(Math.max(...ys), 100);
});

/* ==================== Layout ==================== */

for (const [name, sample] of Object.entries(samples)) {
  for (const direction of ['TB', 'LR']) {
    test(`computeLayout (${name}, ${direction}): steps placed without overlap, transitions attached`, () => {
      const model = LWG.buildModel(sample.graph);
      const layout = LWG.computeLayout(model, { direction });
      assert.equal(layout.direction, direction);
      assert.ok(layout.width > 0 && layout.height > 0);
      const boxes = new Map();
      model.nodes.forEach((n) => {
        const p = layout.nodes[n.id];
        assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), n.id);
        const b = boxOf(n, p);
        assert.ok(b.x1 >= -0.5 && b.y1 >= -0.5 && b.x2 <= layout.width + 0.5 && b.y2 <= layout.height + 0.5, n.id);
        boxes.set(n.id, b);
      });
      const list = Array.from(boxes.entries());
      list.forEach(([a, ba], i) =>
        list.slice(i + 1).forEach(([b, bb]) => assert.ok(!overlap(ba, bb), `${a} overlaps ${b}`)),
      );
      model.edges.forEach((e) => {
        const r = layout.edges[e.id];
        assert.ok(r && r.points.length >= 2, e.id);
        const first = r.points[0];
        const last = r.points[r.points.length - 1];
        assert.ok(distanceToBox(first, boxes.get(e.source)) < 2, `${e.id} does not leave ${e.source}`);
        assert.ok(distanceToBox(last, boxes.get(e.target)) < 2, `${e.id} does not reach ${e.target}`);
        if (r.labelPos) {
          const lb = boxOf({ width: e.labelWidth, height: e.labelHeight }, r.labelPos);
          boxes.forEach((nb, id) => assert.ok(!overlap(lb, nb), `label of ${e.id} overlaps ${id}`));
        }
      });
    });
  }
}

test('computeLayout reads from top to bottom by default, from left to right with LR', () => {
  const model = LWG.buildModel(samples.serial.graph);
  const order = ['Task375f', 'Task38e', 'Task6d8', 'Task5c1'];
  for (const [direction, axis] of [[undefined, 'y'], ['nonsense', 'y'], ['TB', 'y'], ['LR', 'x'], ['lr', 'x']]) {
    const layout = LWG.computeLayout(model, { direction });
    order.slice(1).forEach((id, i) => {
      assert.ok(layout.nodes[order[i]][axis] < layout.nodes[id][axis], `${direction}: ${order[i]} before ${id}`);
    });
  }
});

test('computeLayout: nested self-loops end far enough apart for the arrow heads of next transitions', () => {
  // the current step of the serial sample loops twice on itself (Rejection, Validation); 11 px wide arrow heads
  const model = LWG.buildModel(samples.serial.graph);
  for (const direction of ['TB', 'LR']) {
    const layout = LWG.computeLayout(model, { direction });
    const ends = model.edges
      .filter((e) => e.isSelfLoop)
      .map((e) => layout.edges[e.id].points.slice(-1)[0]);
    assert.equal(ends.length, 2);
    const gap = Math.hypot(ends[0].x - ends[1].x, ends[0].y - ends[1].y);
    assert.ok(gap >= 12, `${direction}: self-loops end ${gap} px apart`);
  }
});

test('computeLayout of the large sample is fast, taller than wide (TB), wider than tall (LR)', () => {
  const model = LWG.buildModel(samples.large.graph);
  assert.equal(model.nodes.length, 59);
  assert.equal(model.currentNodeIds.length, 2);
  const start = Date.now();
  const tb = LWG.computeLayout(model);
  assert.ok(Date.now() - start < 3000);
  assert.ok(tb.height > tb.width);
  const lr = LWG.computeLayout(model, { direction: 'LR' });
  assert.ok(lr.width > lr.height);
});

test('computeLayout fails clearly without dagre', () => {
  const c = load();
  const L = c.NuxeoLabs.WorkflowGraph;
  L.dagre = null;
  assert.throws(() => L.computeLayout(L.buildModel(samples.serial.graph)), /dagre is not loaded/);
});

test('a dagre global defined by another add-on is restored', () => {
  const other = { name: 'another dagre' };
  const c = load({ dagre: other });
  const L = c.NuxeoLabs.WorkflowGraph;
  assert.equal(c.dagre, other);
  assert.notEqual(L.dagre, other);
  assert.equal(typeof L.dagre.layout, 'function');
});
