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

/*
 * Core of the workflow graph: namespace, directions (and the memory of the user's choice), translations, text
 * measuring and the conversion of the REST graph (GET /api/v1/workflow/{id}/graph) and of the history of the
 * workflow (audit entries of an attached document written by the recorder of the plugin, @since 2025.2) into the
 * model used by the layout and the renderer.
 *
 * No dependency on Polymer or on the DOM (the DOM is only used, when present, to measure text), so the
 * file can be unit tested with Node.
 *
 * @since 2025.1
 */
(function (root) {
  'use strict';

  root.NuxeoLabs = root.NuxeoLabs || {};
  const LWG = root.NuxeoLabs.WorkflowGraph || {};
  root.NuxeoLabs.WorkflowGraph = LWG;
  if (LWG.core) {
    return;
  }
  LWG.core = true;
  LWG.VERSION = '2025.2.0';
  LWG.LOG_PREFIX = '[nuxeo-labs-workflow-graph]';

  // dagre is loaded right after this file and declares a global "dagre". Remember any previous value so
  // lwg-layout.js can restore it and never break another add-on shipping its own dagre.
  LWG._previousDagre = root.dagre;

  /* ==================== Direction ==================== */

  // Directions of the layout: top to bottom (default) and left to right.
  LWG.DIRECTIONS = Object.freeze(['TB', 'LR']);
  LWG.DEFAULT_DIRECTION = 'TB';

  LWG.normalizeDirection = function (value) {
    const dir = String(value || '')
      .trim()
      .toUpperCase();
    return LWG.DIRECTIONS.indexOf(dir) >= 0 ? dir : LWG.DEFAULT_DIRECTION;
  };

  const STORAGE_PREFIX = 'nuxeo-labs-workflow-graph.direction.';

  /*
   * Key under which the direction chosen by the user is kept in the browser (localStorage): one per workflow
   * model (e.g. "SerialDocumentReview"), so every instance of a model opens the same way. When the workflow
   * entity cannot be read, falls back to the workflow instance id. Returns null when there is nothing to use.
   */
  LWG.directionStorageKey = function (workflow, workflowId) {
    const model = workflow && (workflow.workflowModelName || workflow.name);
    if (model) {
      return `${STORAGE_PREFIX}model.${model}`;
    }
    return workflowId ? `${STORAGE_PREFIX}instance.${workflowId}` : null;
  };

  function storage() {
    try {
      return root.localStorage || null;
    } catch (e) {
      // access denied (privacy settings, sandboxed frame)
      return null;
    }
  }

  // Direction kept for the key, the default one when none was kept or the storage is not available.
  LWG.loadDirection = function (key) {
    try {
      const store = key && storage();
      return LWG.normalizeDirection(store ? store.getItem(key) : null);
    } catch (e) {
      return LWG.DEFAULT_DIRECTION;
    }
  };

  // Keeps the direction for the key. The default direction is not stored (the entry is removed instead).
  LWG.saveDirection = function (key, direction) {
    try {
      const store = key && storage();
      if (!store) {
        return;
      }
      const dir = LWG.normalizeDirection(direction);
      if (dir === LWG.DEFAULT_DIRECTION) {
        store.removeItem(key);
      } else {
        store.setItem(key, dir);
      }
    } catch (e) {
      // storage full or not available: the choice is simply not kept
    }
  };

  /* ==================== Translations ==================== */

  // English fallbacks, used when the Web UI translation bundle does not contain the key (e.g. the i18n
  // files were not merged), so the graph never displays raw keys.
  LWG.FALLBACK_MESSAGES = {
    'labsWorkflowGraph.dialog.close': 'Close',
    'labsWorkflowGraph.dialog.defaultTitle': 'Workflow',
    'labsWorkflowGraph.loading': 'Loading the workflow graph…',
    'labsWorkflowGraph.empty': 'This workflow has no step.',
    'labsWorkflowGraph.graph.ariaLabel': 'Workflow graph',
    'labsWorkflowGraph.kind.start': 'Start',
    'labsWorkflowGraph.kind.end': 'End',
    'labsWorkflowGraph.kind.step': 'Step',
    'labsWorkflowGraph.kind.multiTask': 'Multiple tasks',
    'labsWorkflowGraph.kind.subWorkflow': 'Sub-workflow',
    'labsWorkflowGraph.kind.fork': 'Fork',
    'labsWorkflowGraph.kind.merge': 'Merge',
    'labsWorkflowGraph.current': 'Current',
    'labsWorkflowGraph.currentStep': 'Current step',
    'labsWorkflowGraph.passedStep': 'Step already done',
    'labsWorkflowGraph.toolbar.zoomIn': 'Zoom in',
    'labsWorkflowGraph.toolbar.zoomOut': 'Zoom out',
    'labsWorkflowGraph.toolbar.zoomLevel': 'Zoom level',
    'labsWorkflowGraph.toolbar.fit': 'Fit to screen',
    'labsWorkflowGraph.toolbar.center': 'Center on the current step',
    'labsWorkflowGraph.toolbar.direction.TB': 'Top to bottom',
    'labsWorkflowGraph.toolbar.direction.LR': 'Left to right',
  };

  function rawTranslate(key) {
    const i18n = root.nuxeo && root.nuxeo.I18n;
    if (i18n && typeof i18n.translate === 'function') {
      try {
        return i18n.translate(key);
      } catch (e) {
        return key;
      }
    }
    return key;
  }

  // Translates one of the plugin's keys: Web UI bundle first, then the English fallback.
  LWG.t = function (key) {
    const value = rawTranslate(key);
    if (!value || value === key) {
      return LWG.FALLBACK_MESSAGES[key] || key;
    }
    return value;
  };

  /*
   * Translates a label coming from the workflow definition (node title, transition label, workflow title).
   * The server already translated it with the server-side messages; Studio projects usually provide their
   * labels in the Web UI bundle, so the client translation is tried as well. Lowercase snake_case keys left
   * untranslated ("automatic_transition") are made readable ("Automatic transition").
   */
  LWG.translateLabel = function (label) {
    if (label === null || label === undefined) {
      return '';
    }
    const text = String(label);
    if (!text) {
      return '';
    }
    const translated = rawTranslate(text);
    if (translated && translated !== text) {
      return String(translated);
    }
    if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(text)) {
      const spaced = text.replace(/_/g, ' ');
      return spaced.charAt(0).toUpperCase() + spaced.slice(1);
    }
    return text;
  };

  /* ==================== Text measuring ==================== */

  LWG.DEFAULT_FONT_FAMILY = "Inter, 'Noto Sans', Arial, sans-serif";

  // Sizes shared by the layout (node and label sizes) and the renderer. Changing a value here requires the
  // matching change in lwg-styles.js.
  LWG.METRICS = Object.freeze({
    card: {
      width: 228,
      minHeight: 66,
      padX: 14,
      padY: 12,
      iconSize: 34,
      gap: 12,
      captionHeight: 15,
      lineHeight: 18,
      maxLines: 3,
      titleWeight: 600,
      titleSize: 13,
    },
    terminal: {
      height: 38,
      padX: 16,
      iconSize: 22,
      gap: 8,
      minWidth: 104,
      maxWidth: 220,
      titleWeight: 600,
      titleSize: 13,
    },
    label: {
      height: 22,
      padX: 9,
      maxWidth: 170,
      minSelfLoopWidth: 28,
      weight: 500,
      size: 11,
    },
  });

  // Removed from the available width when wrapping: canvas and DOM can disagree by a pixel or two.
  const MEASURE_SAFETY = 4;

  // Returns measure(text, weight, size) -> width in px. Uses a canvas when available (browser), otherwise an
  // approximation (unit tests).
  LWG.createMeasurer = function (fontFamily) {
    const family = fontFamily || LWG.DEFAULT_FONT_FAMILY;
    let ctx = null;
    try {
      if (root.document && typeof root.document.createElement === 'function') {
        const canvas = root.document.createElement('canvas');
        ctx = canvas.getContext && canvas.getContext('2d');
      }
    } catch (e) {
      ctx = null;
    }
    const cache = new Map();
    return function measure(text, weight, size) {
      const key = `${weight}|${size}|${text}`;
      if (cache.has(key)) {
        return cache.get(key);
      }
      let width;
      if (ctx) {
        ctx.font = `${weight} ${size}px ${family}`;
        width = ctx.measureText(text).width;
      } else {
        width = String(text).length * size * 0.56;
      }
      cache.set(key, width);
      return width;
    };
  };

  // Cuts the text and adds an ellipsis so it fits in maxWidth px.
  LWG.truncateToWidth = function (text, maxWidth, measureFn) {
    const ellipsis = '…';
    if (measureFn(text) <= maxWidth) {
      return text;
    }
    const chars = Array.from(text);
    let lo = 0;
    let hi = chars.length;
    // binary search on the number of characters kept
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (measureFn(chars.slice(0, mid).join('').trimEnd() + ellipsis) <= maxWidth) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return chars.slice(0, lo).join('').trimEnd() + ellipsis;
  };

  // Wraps text on at most maxLines lines of maxWidth px. Words longer than a line are cut. The last line ends
  // with an ellipsis when the text does not fit. Returns { lines: [string], truncated: boolean }.
  LWG.wrapText = function (text, maxWidth, maxLines, measureFn) {
    const words = String(text || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    let lines = [];
    let current = '';
    words.forEach((w) => {
      let word = w;
      const candidate = current ? `${current} ${word}` : word;
      if (measureFn(candidate) <= maxWidth) {
        current = candidate;
        return;
      }
      if (current) {
        lines.push(current);
        current = '';
      }
      // the word alone may still be too long: cut it
      while (measureFn(word) > maxWidth) {
        const chars = Array.from(word);
        let n = chars.length - 1;
        while (n > 1 && measureFn(chars.slice(0, n).join('')) > maxWidth) {
          n--;
        }
        lines.push(chars.slice(0, n).join(''));
        word = chars.slice(n).join('');
      }
      current = word;
    });
    if (current) {
      lines.push(current);
    }
    let truncated = false;
    if (lines.length > maxLines) {
      truncated = true;
      const rest = lines.slice(maxLines - 1).join(' ');
      lines = lines.slice(0, maxLines - 1);
      lines.push(LWG.truncateToWidth(rest, maxWidth, measureFn));
    }
    if (lines.length === 0) {
      lines.push('');
    }
    return { lines, truncated };
  };

  /* ==================== Model ==================== */

  LWG.KINDS = Object.freeze(['start', 'end', 'step', 'multiTask', 'subWorkflow', 'fork', 'merge']);

  // Number of transition colors (--lwg-transition-1 to -N in lwg-styles.js), reused in turn beyond.
  LWG.TRANSITION_COLOR_COUNT = 5;

  function flag(node, name, alias) {
    if (typeof node[name] === 'boolean') {
      return node[name];
    }
    return alias ? !!node[alias] : false;
  }

  // Same priority as Web UI's default graph (start, end, fork, merge, multi-task, sub-workflow).
  LWG.nodeKind = function (node) {
    if (flag(node, 'isStartNode', 'startNode')) {
      return 'start';
    }
    if (flag(node, 'isEndNode', 'endNode')) {
      return 'end';
    }
    if (flag(node, 'isForkNode', 'forkNode')) {
      return 'fork';
    }
    if (flag(node, 'isMerge', 'merge')) {
      return 'merge';
    }
    if (flag(node, 'isMultiTask', 'multiTask')) {
      return 'multiTask';
    }
    if (flag(node, 'hasSubWorkflow', 'subWorkflow')) {
      return 'subWorkflow';
    }
    return 'step';
  };

  LWG.isTerminalKind = function (kind) {
    return kind === 'start' || kind === 'end';
  };

  LWG.kindLabel = function (kind) {
    return LWG.t(`labsWorkflowGraph.kind.${kind}`);
  };

  /*
   * True when a node id is also the name of an Object.prototype member ("__proto__", "constructor",
   * "toString", "hasOwnProperty", ...). The layouts and dagre key plain objects by node id, so such an id
   * would break the layout and, for "__proto__", alter Object.prototype of the whole Web UI page. Studio
   * never generates these ids; only a hand-written workflow model can contain one.
   * So this error is quite extremely unlikely, but easy to avoid.
   */
  LWG.isReservedNodeId = function (id) {
    return String(id) in Object.prototype;
  };

  function toNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function sizeCard(node, measure) {
    const m = LWG.METRICS.card;
    const textWidth = m.width - m.padX * 2 - m.iconSize - m.gap - MEASURE_SAFETY;
    const wrapped = LWG.wrapText(node.title, textWidth, m.maxLines, (s) => measure(s, m.titleWeight, m.titleSize));
    node.lines = wrapped.lines;
    node.titleTruncated = wrapped.truncated;
    node.width = m.width;
    node.height = Math.max(m.minHeight, m.padY * 2 + m.captionHeight + wrapped.lines.length * m.lineHeight);
  }

  function sizeTerminal(node, measure) {
    const m = LWG.METRICS.terminal;
    const chrome = m.padX * 2 + m.iconSize + m.gap;
    const fn = (s) => measure(s, m.titleWeight, m.titleSize);
    const text = LWG.truncateToWidth(node.title, m.maxWidth - chrome - MEASURE_SAFETY, fn);
    node.lines = [text];
    node.titleTruncated = text !== node.title;
    node.width = Math.round(Math.min(m.maxWidth, Math.max(m.minWidth, chrome + fn(text) + MEASURE_SAFETY)));
    node.height = m.height;
  }

  function sizeLabel(edge, measure) {
    const m = LWG.METRICS.label;
    edge.labelText = '';
    edge.labelTruncated = false;
    edge.labelWidth = 0;
    edge.labelHeight = 0;
    if (!edge.label) {
      return;
    }
    const fn = (s) => measure(s, m.weight, m.size);
    const text = LWG.truncateToWidth(edge.label, m.maxWidth - m.padX * 2 - MEASURE_SAFETY, fn);
    edge.labelText = text;
    edge.labelTruncated = text !== edge.label;
    edge.labelWidth = Math.round(Math.min(m.maxWidth, fn(text) + m.padX * 2 + MEASURE_SAFETY));
    edge.labelHeight = m.height;
  }

  /* ==================== History ==================== */

  // Audited event of the recorder (server side of the plugin), fired on each document attached to the workflow.
  LWG.HISTORY_EVENT = 'lwgWorkflowStepCompleted';
  // Audit entries read per request (maximum page size of the audit page provider), and maximum number of pages.
  LWG.HISTORY_PAGE_SIZE = 1000;
  LWG.HISTORY_MAX_PAGES = 10;

  const hasValue = (v) => v !== undefined && v !== null && v !== '';

  // Position of a transition in its step: a non-negative integer (or its string), null otherwise.
  function toIndex(value) {
    if (typeof value === 'number') {
      return Number.isInteger(value) && value >= 0 ? value : null;
    }
    return typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : null;
  }

  // An audit extended info holding a list: an array, or a comma-separated string.
  function toList(value) {
    if (Array.isArray(value)) {
      return value;
    }
    return typeof value === 'string' && value.trim() ? value.split(',').map((s) => s.trim()) : [];
  }

  /*
   * Checks and cleans the history of a workflow instance, as built by LWG.historyFromAudit, as an object or a JSON
   * string:
   *   { nodes: [{ id, completed, count }], transitions: [{ source, index, name, target, count }] }
   * nodes: the steps completed at least once (count: number of times). transitions: the transitions followed at
   * least once, index being their position in their step (definition order, the order of the graph endpoint),
   * target the id of their target step (null when unknown).
   * Returns { nodes, transitions } with the valid entries only, null when the value is not a history.
   *
   * @since 2025.2
   */
  LWG.normalizeHistory = function (value) {
    let data = value;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch (e) {
        return null;
      }
    }
    if (!data || typeof data !== 'object' || !Array.isArray(data.nodes) || !Array.isArray(data.transitions)) {
      return null;
    }
    const nodes = data.nodes
      .filter((n) => n && hasValue(n.id))
      .map((n) => ({ id: String(n.id), completed: n.completed === true, count: toNumber(n.count) }));
    const transitions = data.transitions
      .filter((t) => t && hasValue(t.source) && Number.isInteger(t.index) && t.index >= 0)
      .map((t) => ({
        source: String(t.source),
        index: t.index,
        target: hasValue(t.target) ? String(t.target) : null,
        count: toNumber(t.count),
      }));
    return { nodes, transitions };
  };

  /*
   * Builds the history of a workflow instance from the audit entries of one of its attached documents (the "entries"
   * of GET /api/v1/id/{docId}/@audit, in any order). The recorder of the plugin writes one entry per completed step
   * on each attached document: event LWG.HISTORY_EVENT, extended info lwgWorkflowId (id of the workflow instance),
   * lwgNodeId (id of the step), lwgTransitions (positions of the followed transitions in the step), lwgTransitionNames
   * and lwgTargets (their names and target steps, same order). Only the entries of this event for this workflow are
   * kept, invalid values are ignored.
   * Returns the format of LWG.normalizeHistory: the steps completed at least once, the transitions followed at least
   * once (in the order they were first followed), with their counts.
   *
   * @since 2025.2
   */
  LWG.historyFromAudit = function (entries, workflowId) {
    const nodes = new Map();
    const transitions = new Map();
    if (!hasValue(workflowId) || !Array.isArray(entries)) {
      return { nodes: [], transitions: [] };
    }
    const time = (e) => {
      const t = Date.parse(e.eventDate);
      return Number.isFinite(t) ? t : 0;
    };
    entries
      .filter(
        (e) =>
          e &&
          e.eventId === LWG.HISTORY_EVENT &&
          e.extended &&
          String(e.extended.lwgWorkflowId) === String(workflowId) &&
          hasValue(e.extended.lwgNodeId),
      )
      .sort((a, b) => time(a) - time(b) || toNumber(a.id) - toNumber(b.id))
      .forEach((e) => {
        const ext = e.extended;
        const source = String(ext.lwgNodeId);
        nodes.set(source, (nodes.get(source) || 0) + 1);
        const names = toList(ext.lwgTransitionNames);
        const targets = toList(ext.lwgTargets);
        toList(ext.lwgTransitions).forEach((position, i) => {
          const index = toIndex(position);
          if (index === null) {
            return;
          }
          const key = historyKey(source, index);
          const known = transitions.get(key);
          if (known) {
            known.count += 1;
            return;
          }
          transitions.set(key, {
            source,
            index,
            name: hasValue(names[i]) ? String(names[i]) : null,
            target: hasValue(targets[i]) ? String(targets[i]) : null,
            count: 1,
          });
        });
      });
    return {
      nodes: Array.from(nodes, ([id, count]) => ({ id, completed: true, count })),
      transitions: Array.from(transitions.values()),
    };
  };

  /*
   * Returns the ids of the documents found in the values, in order and without duplicates: ids (strings), document
   * entities ({ uid }), references ({ id }, as in attachedDocumentIds of GET /api/v1/workflow/{id}), or arrays of
   * them. Used to find a document attached to the workflow whose audit can be read.
   *
   * @since 2025.2
   */
  LWG.documentIdsOf = function (...values) {
    const ids = [];
    const add = (value) => {
      if (Array.isArray(value)) {
        value.forEach(add);
        return;
      }
      const raw = value && typeof value === 'object' ? value.uid || value.id : value;
      const id = typeof raw === 'string' ? raw.trim() : '';
      if (id && !ids.includes(id)) {
        ids.push(id);
      }
    };
    values.forEach(add);
    return ids;
  };

  function historyKey(source, index) {
    return `${source}\u0000${index}`;
  }

  // Sets edge.colorIndex, see buildModel. The edges are in the order of the definition.
  function assignColors(edges) {
    const count = new Map();
    edges.forEach((e) => count.set(e.source, (count.get(e.source) || 0) + 1));
    const rank = new Map();
    edges.forEach((e) => {
      const r = rank.get(e.source) || 0;
      rank.set(e.source, r + 1);
      e.colorIndex = count.get(e.source) > 1 ? (r % LWG.TRANSITION_COLOR_COUNT) + 1 : 0;
    });
  }

  /*
   * Converts the JSON of GET /api/v1/workflow/{id}/graph into the model used by the layout and the renderer.
   *
   * options = { measure: function from createMeasurer(), translate: label translation function,
   *             history: history of the workflow (see LWG.normalizeHistory), optional }
   *
   * Returns {
   *   nodes: [{ id, title, lines, titleTruncated, kind, isCurrent, isPassed, isDimmed, width, height,
   *             studio: { x, y }, index }],
   *   edges: [{ id, source, target, label, labelText, labelTruncated, labelWidth, labelHeight, isSelfLoop,
   *             isNext, isTaken, isDimmed, colorIndex, sourceIndex, index }],
   *   currentNodeIds: [ids], hasHistory: boolean, historyComplete: boolean, warnings: [strings]
   * }
   * A node is current when its state is "suspended" (waiting for its tasks). isNext marks the transitions
   * leaving a current node. Nodes are sorted by their Studio position (top to bottom, then left to right) so
   * the layout starts from the order chosen by the designer.
   *
   * With a history (@since 2025.2): isPassed marks the steps completed at least once, isTaken the transitions
   * followed at least once. The current look wins: a current step is never passed, a transition leaving a current
   * step is never taken. sourceIndex is the position of the transition in its step (definition order, the ignored
   * transitions included), used to match the history; a followed transition whose target differs from the graph
   * is ignored with a warning.
   * The history is complete (historyComplete) when it covers the whole run: a start step is completed in the
   * history, or is current. Otherwise the workflow started before the transitions were recorded (installation of
   * the plugin): what happened before is unknown, so the steps done and the transitions followed since are marked
   * but nothing is dimmed.
   * isDimmed (complete history only) marks the branches not followed: what was not done and cannot happen anymore.
   * A step is dimmed when it was never reached (not current, not waiting (merge), not in the history, not the
   * target of a followed transition) and cannot be reached anymore (no transition leads to it from a current or a
   * waiting step, loops included): the steps still to come keep their look. A transition is dimmed when it is not
   * next nor followed and its source is dimmed, or its source cannot be reached anymore and its target was never
   * reached (so it was never followed). A transition between two reached steps that was not recorded is not
   * dimmed: the recorder may have failed to record it (it never breaks a workflow). When the workflow is done (no
   * current step), every step never reached is dimmed. Without a history, nothing is dimmed.
   *
   * colorIndex tells the transitions leaving the same step apart, as Web UI's default graph does: 0 when the
   * step has a single transition (neutral color), otherwise 1 to TRANSITION_COLOR_COUNT from the rank of the
   * transition in the step (the order of the definition), reused in turn (1, 2, 3, 4, 5, 1, 2...).
   *
   * Throws when a node id is a reserved name (see LWG.isReservedNodeId): the renderer then fails and the
   * viewer falls back to Web UI's default graph.
   */
  LWG.buildModel = function (graph, options) {
    const opts = options || {};
    const measure = opts.measure || LWG.createMeasurer();
    const translate = opts.translate || LWG.translateLabel;
    const warnings = [];
    const rawNodes = (graph && Array.isArray(graph.nodes) && graph.nodes) || [];
    const rawTransitions = (graph && Array.isArray(graph.transitions) && graph.transitions) || [];
    const history = opts.history ? LWG.normalizeHistory(opts.history) : null;
    if (opts.history && !history) {
      warnings.push('Invalid workflow history, ignored');
    }
    const completed = new Set(history ? history.nodes.filter((n) => n.completed).map((n) => n.id) : []);
    // in the history (completed, or started for a history listing the steps started)
    const started = new Set(history ? history.nodes.map((n) => n.id) : []);
    // merge steps waiting for other branches, and targets of followed transitions: reached as well
    const waiting = new Set();
    const followedTargets = new Set();
    // followed transitions: source and position in the source -> target
    const followed = new Map(
      history ? history.transitions.map((t) => [historyKey(t.source, t.index), t.target]) : [],
    );

    const nodes = [];
    const byId = new Map();
    rawNodes.forEach((raw, index) => {
      if (!raw || raw.id === undefined || raw.id === null || raw.id === '') {
        warnings.push(`Node #${index} has no id, ignored`);
        return;
      }
      const id = String(raw.id);
      if (LWG.isReservedNodeId(id)) {
        throw new Error(`Node id "${id}" is a reserved name, the custom graph cannot draw this workflow`);
      }
      if (byId.has(id)) {
        warnings.push(`Duplicate node id ${id}, ignored`);
        return;
      }
      const kind = LWG.nodeKind(raw);
      const isCurrent = raw.state === 'suspended';
      const node = {
        id,
        title: translate(raw.title) || id,
        kind,
        isCurrent,
        isPassed: !isCurrent && completed.has(id),
        isDimmed: false,
        studio: { x: toNumber(raw.x), y: toNumber(raw.y) },
        index,
      };
      if (LWG.isTerminalKind(kind)) {
        sizeTerminal(node, measure);
      } else {
        sizeCard(node, measure);
      }
      if (raw.state === 'waiting') {
        waiting.add(id);
      }
      byId.set(id, node);
      nodes.push(node);
    });
    nodes.sort((a, b) => a.studio.y - b.studio.y || a.studio.x - b.studio.x || a.index - b.index);

    const edges = [];
    const sourceCount = new Map();
    rawTransitions.forEach((raw, index) => {
      const source = raw && raw.nodeSourceId !== undefined ? String(raw.nodeSourceId) : '';
      const target = raw && raw.nodeTargetId !== undefined ? String(raw.nodeTargetId) : '';
      // position in the step, as counted by the server (the ignored transitions included)
      const sourceIndex = sourceCount.get(source) || 0;
      sourceCount.set(source, sourceIndex + 1);
      const key = historyKey(source, sourceIndex);
      const followedTarget = followed.get(key);
      const wasFollowed = followed.delete(key);
      if (!byId.has(source) || !byId.has(target)) {
        warnings.push(`Transition #${index} (${source} -> ${target}) references an unknown node, ignored`);
        return;
      }
      const isNext = byId.get(source).isCurrent;
      let isTaken = wasFollowed && !isNext;
      if (wasFollowed && followedTarget !== null && followedTarget !== target) {
        warnings.push(
          `History: transition #${sourceIndex} of ${source} goes to ${target}, not to ${followedTarget}, ignored`,
        );
        isTaken = false;
      } else if (wasFollowed) {
        followedTargets.add(target);
      }
      const edge = {
        id: `e${index}`,
        source,
        target,
        label: translate(raw.label),
        isSelfLoop: source === target,
        isNext,
        isTaken,
        isDimmed: false,
        sourceIndex,
        index,
      };
      sizeLabel(edge, measure);
      edges.push(edge);
    });
    assignColors(edges);
    if (followed.size) {
      warnings.push(`History: ${followed.size} followed transition(s) not found in the graph, ignored`);
    }
    // the run is fully recorded when a start step completed (recorded) or is current (nothing happened before)
    const historyComplete =
      !!history && nodes.some((n) => n.kind === 'start' && (n.isCurrent || completed.has(n.id)));
    if (historyComplete) {
      // the steps that can still happen: the current ones, the merges waiting for other branches, and every step a
      // transition leads to from them (loops included)
      const future = new Set(nodes.filter((n) => n.isCurrent || waiting.has(n.id)).map((n) => n.id));
      const targetsOf = new Map();
      edges.forEach((e) => targetsOf.set(e.source, (targetsOf.get(e.source) || []).concat(e.target)));
      const todo = Array.from(future);
      while (todo.length) {
        (targetsOf.get(todo.pop()) || []).forEach((t) => {
          if (!future.has(t)) {
            future.add(t);
            todo.push(t);
          }
        });
      }
      const reached = (id) => byId.get(id).isCurrent || started.has(id) || waiting.has(id) || followedTargets.has(id);
      nodes.forEach((n) => {
        n.isDimmed = !reached(n.id) && !future.has(n.id);
      });
      edges.forEach((e) => {
        const neverFollowed = byId.get(e.source).isDimmed || (!future.has(e.source) && !reached(e.target));
        e.isDimmed = !e.isNext && !e.isTaken && neverFollowed;
      });
    }

    return {
      nodes,
      edges,
      currentNodeIds: nodes.filter((n) => n.isCurrent).map((n) => n.id),
      hasHistory: !!history,
      historyComplete,
      warnings,
    };
  };
})(typeof window !== 'undefined' ? window : globalThis);
