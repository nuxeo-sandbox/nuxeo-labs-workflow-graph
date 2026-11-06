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
 * LWG.Renderer: draws a workflow graph in a container element and handles the view: zoom (toolbar, + and -
 * keys, pinch, Ctrl/Cmd + wheel), pan (drag, wheel), fit to screen (toolbar, F key), center on the current
 * step (toolbar, C key) and direction of the layout (toolbar, Down and Right arrow keys: top to bottom or left to
 * right). The graph itself is read-only: steps and transitions are not interactive, and every view change is
 * instant (no animation).
 * Framework-free: the Polymer dialog only feeds it with data and keeps the direction chosen by the user.
 *
 *   const renderer = new LWG.Renderer(containerElement, { onDirectionChange(direction) {...} });
 *   renderer.setGraph(jsonOfWorkflowGraphEndpoint, { direction: 'LR' });   // throws if the layout fails
 *   renderer.setGraph(graph, { history: jsonOfGetHistoryOperation });       // steps done, transitions followed,
 *                                                                           // branches not followed dimmed
 *
 * Steps and labels are HTML elements (crisp text), transitions are SVG paths below them. Every position comes
 * from the layout, nothing is read back from the DOM, so the graph can be built while hidden.
 *
 * @since 2025.1
 */
(function (root) {
  'use strict';

  const LWG = root.NuxeoLabs && root.NuxeoLabs.WorkflowGraph;
  if (!LWG || LWG.Renderer) {
    return;
  }
  const G = LWG.geometry;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  // Margin around the content, inside the stage (room for the badge, the ring and the shadows).
  const PAD = 28;
  // Arrow heads, in px. The line stops inside the arrow head (shorten), so its round cap never shows past the tip.
  const ARROW = Object.freeze({ length: 9, width: 8.5, shorten: 6 });
  // Bigger arrow heads for the thicker transitions leaving a current step (stroke widths in lwg-styles.js). The
  // width must stay below the gap between nested self-loops (selfLoop in lwg-layout.js).
  const NEXT_ARROW = Object.freeze({ length: 13, width: 11, shorten: 8.5 });
  // Transitions already followed: between the two (@since 2025.2).
  const TAKEN_ARROW = Object.freeze({ length: 11, width: 10, shorten: 7.5 });
  const MIN_SCALE = 0.05;
  const MAX_SCALE = 2.5;
  const ZOOM_STEP = 1.25;
  // When fitting the whole graph gives a smaller zoom, the view opens centered on the current step instead.
  const READABLE_SCALE = 0.5;
  const FOCUS_SCALE = 0.8;
  const DRAG_THRESHOLD = 4;
  const VIEW_MARGIN = 16;
  // Room kept free at the top when fitting, so the toolbar does not cover the graph.
  const TOOLBAR_CLEARANCE = 60;
  // Keyboard shortcuts of the directions (the arrow gives the reading direction), symbol shown in the tooltips.
  // ArrowLeft and ArrowUp are not used.
  const DIRECTION_KEYS = Object.freeze({
    TB: Object.freeze({ key: 'ArrowDown', symbol: '↓' }),
    LR: Object.freeze({ key: 'ArrowRight', symbol: '→' }),
  });

  // Resolves when the web fonts are loaded (text is measured with them), at most after 1.5s.
  LWG.fontsReady = function () {
    const fonts = root.document && root.document.fonts;
    if (!fonts || !fonts.ready) {
      return Promise.resolve();
    }
    return Promise.race([fonts.ready, new Promise((resolve) => setTimeout(resolve, 1500))]).catch(() => {});
  };

  function injectStyles(container) {
    const doc = root.document;
    const rootNode = container.getRootNode ? container.getRootNode() : doc;
    const target = rootNode && rootNode !== doc && rootNode.nodeType === 11 ? rootNode : doc.head;
    if (target.querySelector('style[data-lwg-styles]')) {
      return;
    }
    const style = doc.createElement('style');
    style.setAttribute('data-lwg-styles', LWG.VERSION);
    style.textContent = LWG.CSS;
    target.appendChild(style);
  }

  function el(tag, className, attrs) {
    const e = root.document.createElement(tag);
    if (className) {
      e.className = className;
    }
    Object.keys(attrs || {}).forEach((k) => e.setAttribute(k, attrs[k]));
    return e;
  }

  function svgEl(tag, attrs) {
    const e = root.document.createElementNS(SVG_NS, tag);
    Object.keys(attrs || {}).forEach((k) => e.setAttribute(k, attrs[k]));
    return e;
  }

  class Renderer {
    // options: { onDirectionChange(direction) }, called when the user switches the direction in the toolbar.
    constructor(container, options) {
      this.container = container;
      this.options = Object.assign({ onDirectionChange: null }, options || {});
      this.model = null;
      this.layout = null;
      this.direction = LWG.DEFAULT_DIRECTION;
      this.transform = { scale: 1, x: 0, y: 0 };
      // View recomputed when the viewport is resized: 'initial' (opening view), 'fit', or null once the user
      // zoomed, panned or centered.
      this._autoView = 'initial';
      this._currentCycle = 0;
      this._pointers = new Map();
      this._drag = null;
      this._pinch = null;
      this._gesture = null;
      injectStyles(container);
      this._build();
      this._bind();
    }

    /* ==================== Public API ==================== */

    /*
     * Builds the model, computes the layout and draws. Throws when the layout cannot be computed.
     * options: { direction: 'TB' | 'LR' (TB by default), history: history of the workflow, optional (steps already
     * done and transitions already followed, see LWG.normalizeHistory) }
     */
    setGraph(graph, options) {
      const opts = options || {};
      const direction = LWG.normalizeDirection(opts.direction);
      const family = root.getComputedStyle ? root.getComputedStyle(this.container).fontFamily : '';
      const model = LWG.buildModel(graph, {
        measure: LWG.createMeasurer(family || LWG.DEFAULT_FONT_FAMILY),
        history: opts.history || null,
      });
      if (model.warnings.length) {
        console.warn(LWG.LOG_PREFIX, model.warnings.join('; '));
      }
      this.layout = LWG.computeLayout(model, { direction });
      this.model = model;
      this._show(direction);
    }

    /*
     * Lays the graph out again in the given direction and resets the view as at opening. The model is reused
     * (the sizes do not depend on the direction). When the new layout fails, the current one is kept.
     * Returns true when the direction changed.
     */
    setDirection(direction) {
      const dir = LWG.normalizeDirection(direction);
      if (dir === this.direction) {
        return false;
      }
      if (!this.model) {
        this.direction = dir;
        this._updateDirectionButtons();
        return true;
      }
      try {
        this.layout = LWG.computeLayout(this.model, { direction: dir });
      } catch (e) {
        console.error(LWG.LOG_PREFIX, `Layout failed (${dir}), the current one is kept`, e);
        return false;
      }
      this._show(dir);
      return true;
    }

    // Shows the whole graph. Returns false when the container has no size yet.
    fit() {
      const t = this._fitTransform();
      if (!t) {
        return false;
      }
      this._autoView = 'fit';
      this._setTransform(t);
      return true;
    }

    zoomIn() {
      this.zoomBy(ZOOM_STEP);
    }

    zoomOut() {
      this.zoomBy(1 / ZOOM_STEP);
    }

    // Zooms around a point of the viewport (its center by default).
    zoomBy(factor, point) {
      this.zoomTo(this.transform.scale * factor, point);
    }

    zoomTo(scale, point) {
      const v = this._viewSize();
      const p = point || { x: v.width / 2, y: v.height / 2 };
      this._autoView = null;
      this._setTransform(G.zoomAround(this.transform, G.clamp(scale, MIN_SCALE, MAX_SCALE), p.x, p.y));
    }

    panBy(dx, dy) {
      const t = this.transform;
      this._autoView = null;
      this._setTransform({ scale: t.scale, x: t.x + dx, y: t.y + dy });
    }

    // Centers on the current step; repeated calls cycle through the current steps of parallel branches.
    centerOnCurrent() {
      const ids = (this.model && this.model.currentNodeIds) || [];
      if (!ids.length) {
        return false;
      }
      const id = ids[this._currentCycle % ids.length];
      this._currentCycle++;
      this._autoView = null;
      this._centerOn(id, Math.max(this.transform.scale, FOCUS_SCALE));
      return true;
    }

    // Gives the keyboard focus to the graph, so the shortcuts work right away.
    focus() {
      this.viewport.focus({ preventScroll: true });
    }

    destroy() {
      if (this._resizeObserver) {
        this._resizeObserver.disconnect();
      }
      this.container.textContent = '';
      this.container.classList.remove('lwg-root');
    }

    /* ==================== DOM ==================== */

    _build() {
      const c = this.container;
      c.textContent = '';
      c.classList.add('lwg-root');

      this.viewport = el('div', 'lwg-viewport', {
        tabindex: '0',
        role: 'region',
        'aria-label': LWG.t('labsWorkflowGraph.graph.ariaLabel'),
        'aria-keyshortcuts': '+ - F C ArrowDown ArrowRight',
      });
      this.stage = el('div', 'lwg-stage', { dir: 'ltr' });
      this.svg = svgEl('svg', { class: 'lwg-edges', 'aria-hidden': 'true' });
      this.labelLayer = el('div', 'lwg-labels');
      this.nodeLayer = el('div', 'lwg-nodes');
      this.stage.append(this.svg, this.labelLayer, this.nodeLayer);
      this.viewport.appendChild(this.stage);

      this.emptyEl = el('div', 'lwg-empty');
      this.emptyEl.textContent = LWG.t('labsWorkflowGraph.empty');
      this.emptyEl.hidden = true;

      c.append(this.viewport, this.emptyEl, this._buildToolbar());
    }

    // shortcut: key displayed in the tooltip, if any
    _button(icon, labelKey, shortcut, onClick) {
      const label = shortcut ? `${LWG.t(labelKey)} (${shortcut})` : LWG.t(labelKey);
      const b = el('button', 'lwg-tb-btn', { type: 'button', title: label, 'aria-label': label });
      b.appendChild(LWG.createIcon(icon));
      b.addEventListener('click', onClick);
      return b;
    }

    _buildToolbar() {
      const tb = el('div', 'lwg-toolbar', {
        role: 'toolbar',
        'aria-label': LWG.t('labsWorkflowGraph.graph.ariaLabel'),
      });
      this._zoomLevel = el('span', 'lwg-tb-zoom', { title: LWG.t('labsWorkflowGraph.toolbar.zoomLevel') });
      this._btnCenter = this._button('center', 'labsWorkflowGraph.toolbar.center', 'C', () => this.centerOnCurrent());
      this._btnDirection = {};
      LWG.DIRECTIONS.forEach((dir) => {
        const labelKey = `labsWorkflowGraph.toolbar.direction.${dir}`;
        const shortcut = DIRECTION_KEYS[dir].symbol;
        const b = this._button(`direction${dir}`, labelKey, shortcut, () => this._chooseDirection(dir));
        b.dataset.direction = dir;
        this._btnDirection[dir] = b;
      });
      tb.append(
        this._button('zoomOut', 'labsWorkflowGraph.toolbar.zoomOut', '-', () => this.zoomOut()),
        this._zoomLevel,
        this._button('zoomIn', 'labsWorkflowGraph.toolbar.zoomIn', '+', () => this.zoomIn()),
        el('span', 'lwg-tb-sep'),
        this._button('fit', 'labsWorkflowGraph.toolbar.fit', 'F', () => this.fit()),
        this._btnCenter,
        el('span', 'lwg-tb-sep'),
        ...LWG.DIRECTIONS.map((dir) => this._btnDirection[dir]),
      );
      this._updateDirectionButtons();
      return tb;
    }

    // Direction chosen by the user (toolbar or keyboard): the caller is told, so it can keep the choice.
    _chooseDirection(dir) {
      if (this.setDirection(dir) && typeof this.options.onDirectionChange === 'function') {
        this.options.onDirectionChange(dir);
      }
    }

    _updateDirectionButtons() {
      LWG.DIRECTIONS.forEach((dir) => {
        this._btnDirection[dir].setAttribute('aria-pressed', String(dir === this.direction));
      });
    }

    // Draws the current layout in the given direction, then applies the opening view.
    _show(direction) {
      this.direction = direction;
      this._updateDirectionButtons();
      this._currentCycle = 0;
      this._render();
      // also applied by the resize observer when the viewport has no size yet (dialog still opening)
      this._autoView = 'initial';
      this._applyInitialView();
    }

    _render() {
      const { model, layout } = this;
      this.svg.textContent = '';
      this.labelLayer.textContent = '';
      this.nodeLayer.textContent = '';

      const width = layout.width + PAD * 2;
      const height = layout.height + PAD * 2;
      this.stage.style.width = `${width}px`;
      this.stage.style.height = `${height}px`;
      this.svg.setAttribute('width', String(width));
      this.svg.setAttribute('height', String(height));
      this.svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      this.emptyEl.hidden = model.nodes.length > 0;
      this._btnCenter.hidden = !model.currentNodeIds.length;

      // Drawing order: the dimmed transitions first, then the others, the ones already followed, and the ones leaving
      // the current step(s) last, on top.
      const rank = (e) => (e.isNext ? 3 : e.isTaken ? 2 : e.isDimmed ? 0 : 1);
      [0, 1, 2, 3].forEach((r) =>
        model.edges.filter((e) => rank(e) === r).forEach((e) => this._renderEdge(e, layout.edges[e.id])),
      );

      // DOM order follows the reading order of the layout
      const pos = (n) => layout.nodes[n.id];
      const byReadingOrder =
        this.direction === 'LR'
          ? (a, b) => pos(a).x - pos(b).x || pos(a).y - pos(b).y
          : (a, b) => pos(a).y - pos(b).y || pos(a).x - pos(b).x;
      model.nodes
        .slice()
        .sort(byReadingOrder)
        .forEach((n) => this.nodeLayer.appendChild(this._createNode(n, pos(n))));
    }

    _renderEdge(e, route) {
      if (!route || route.points.length < 2) {
        return;
      }
      const points = route.points.map((p) => ({ x: p.x + PAD, y: p.y + PAD }));
      const tip = points[points.length - 1];
      const from = points[points.length - 2];
      const arrow = e.isNext ? NEXT_ARROW : e.isTaken ? TAKEN_ARROW : ARROW;
      const line = G.shortenEnd(points, arrow.shorten);
      const d = route.curve === 'rounded' ? G.roundedPath(line, 10) : G.basisPath(line);
      // is-next: leaves a current step; is-taken: already followed; is-dimmed: never followed and cannot be followed
      // anymore; lwg-tc lwg-tc-N: color of the palette (its step has several transitions)
      const flags = `${e.isNext ? ' is-next' : ''}${e.isTaken ? ' is-taken' : ''}${e.isDimmed ? ' is-dimmed' : ''}`;
      const state = `${flags}${e.colorIndex ? ` lwg-tc lwg-tc-${e.colorIndex}` : ''}`;
      const g = svgEl('g', { class: `lwg-edge${state}` });
      g.append(
        svgEl('path', { class: 'lwg-edge-line', d }),
        svgEl('path', { class: 'lwg-edge-arrow', d: G.arrowHead(tip, from, arrow.length, arrow.width) }),
      );
      this.svg.appendChild(g);

      if (route.labelPos && e.labelWidth) {
        const label = el('div', `lwg-label${state}`, { dir: 'auto' });
        label.textContent = e.labelText;
        label.style.left = `${route.labelPos.x + PAD - e.labelWidth / 2}px`;
        label.style.top = `${route.labelPos.y + PAD - e.labelHeight / 2}px`;
        label.style.width = `${e.labelWidth}px`;
        if (e.labelTruncated) {
          label.title = e.label;
        }
        this.labelLayer.appendChild(label);
      }
    }

    _createNode(n, p) {
      const terminal = LWG.isTerminalKind(n.kind);
      const elem = el('div', `lwg-node lwg-kind-${n.kind}${terminal ? ' lwg-terminal' : ''}`);
      elem.dataset.id = n.id;
      elem.classList.toggle('is-current', n.isCurrent);
      elem.classList.toggle('is-passed', !!n.isPassed);
      elem.classList.toggle('is-dimmed', !!n.isDimmed);
      elem.style.left = `${p.x + PAD - n.width / 2}px`;
      elem.style.top = `${p.y + PAD - n.height / 2}px`;
      elem.style.width = `${n.width}px`;
      elem.style.height = `${n.height}px`;
      if (n.titleTruncated) {
        elem.title = n.title;
      }

      const icon = el('div', 'lwg-node-icon');
      icon.appendChild(LWG.createIcon(n.kind));
      const body = el('div', 'lwg-node-body');
      if (!terminal) {
        const caption = el('div', 'lwg-node-caption');
        caption.textContent = LWG.kindLabel(n.kind);
        body.appendChild(caption);
      }
      n.lines.forEach((line) => {
        const l = el('div', 'lwg-node-line', { dir: 'auto' });
        l.textContent = line;
        body.appendChild(l);
      });
      elem.append(icon, body);

      if (n.isCurrent) {
        const badge = el('div', 'lwg-node-badge');
        badge.textContent = LWG.t('labsWorkflowGraph.current');
        badge.title = LWG.t('labsWorkflowGraph.currentStep');
        elem.appendChild(badge);
      } else if (n.isPassed) {
        const label = LWG.t('labsWorkflowGraph.passedStep');
        const check = el('div', 'lwg-node-check', { role: 'img', 'aria-label': label, title: label });
        check.appendChild(LWG.createIcon('check'));
        elem.appendChild(check);
      }
      return elem;
    }

    /* ==================== View ==================== */

    _viewSize() {
      return { width: this.viewport.clientWidth, height: this.viewport.clientHeight };
    }

    _stageSize() {
      if (!this.layout) {
        return { width: 0, height: 0 };
      }
      return { width: this.layout.width + PAD * 2, height: this.layout.height + PAD * 2 };
    }

    // Transform showing the whole graph below the toolbar, null when the viewport has no size yet.
    _fitTransform() {
      const v = this._viewSize();
      const s = this._stageSize();
      return G.fitTransform(s.width, s.height, v.width, v.height, {
        margin: VIEW_MARGIN,
        top: TOOLBAR_CLEARANCE,
        minScale: MIN_SCALE,
        maxScale: 1,
      });
    }

    // Fits the graph; when it is then too small to be read and a step is current, zooms on that step instead.
    _applyInitialView() {
      const t = this.model && this._fitTransform();
      if (!t) {
        return;
      }
      const ids = this.model.currentNodeIds;
      if (t.scale < READABLE_SCALE && ids.length) {
        this._centerOn(ids[0], FOCUS_SCALE);
        // the next "center" goes to the following current step, if any
        this._currentCycle = 1;
      } else {
        this._setTransform(t);
      }
    }

    _centerOn(id, scale) {
      const p = this.layout && this.layout.nodes[id];
      if (!p) {
        return;
      }
      const s = G.clamp(scale, MIN_SCALE, MAX_SCALE);
      const v = this._viewSize();
      this._setTransform({ scale: s, x: v.width / 2 - (p.x + PAD) * s, y: v.height / 2 - (p.y + PAD) * s });
    }

    _setTransform(t) {
      const scale = G.clamp(t.scale, MIN_SCALE, MAX_SCALE);
      this.transform = { scale, x: t.x, y: t.y };
      this.stage.style.transform = `translate(${t.x}px, ${t.y}px) scale(${scale})`;
      this.stage.style.setProperty('--_lwg-inv-scale', String(1 / scale));
      let grid = 20 * scale;
      while (grid < 10) {
        grid *= 2;
      }
      this.viewport.style.backgroundSize = `${grid}px ${grid}px`;
      this.viewport.style.backgroundPosition = `${t.x}px ${t.y}px`;
      this._zoomLevel.textContent = `${Math.round(scale * 100)}%`;
    }

    /* ==================== Events ==================== */

    _bind() {
      const vp = this.viewport;
      vp.addEventListener('pointerdown', (e) => this._onPointerDown(e));
      vp.addEventListener('pointermove', (e) => this._onPointerMove(e));
      vp.addEventListener('pointerup', (e) => this._onPointerUp(e));
      vp.addEventListener('pointercancel', (e) => this._onPointerUp(e));
      vp.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
      // Safari reports a trackpad pinch as gesture events, not as Ctrl + wheel
      vp.addEventListener('gesturestart', (e) => this._onGesture(e));
      vp.addEventListener('gesturechange', (e) => this._onGesture(e));
      vp.addEventListener('gestureend', (e) => this._onGesture(e));
      // focus() may scroll an overflow:hidden element, positions are only driven by the transform
      vp.addEventListener('scroll', () => {
        vp.scrollTop = 0;
        vp.scrollLeft = 0;
      });
      this.container.addEventListener('keydown', (e) => this._onKeyDown(e));
      if (root.ResizeObserver) {
        this._resizeObserver = new root.ResizeObserver(() => {
          if (this._autoView === 'initial') {
            this._applyInitialView();
          } else if (this._autoView === 'fit') {
            this.fit();
          }
        });
        this._resizeObserver.observe(vp);
      }
    }

    _localPoint(clientX, clientY) {
      const r = this.viewport.getBoundingClientRect();
      return { x: clientX - r.left, y: clientY - r.top };
    }

    _onPointerDown(e) {
      if (e.pointerType === 'mouse' && e.button !== 0) {
        return;
      }
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this._pointers.size === 1) {
        this._drag = { id: e.pointerId, startX: e.clientX, startY: e.clientY, origin: this.transform, moved: false };
      } else if (this._pointers.size === 2) {
        const [a, b] = Array.from(this._pointers.values());
        this._drag = null;
        this._pinch = {
          distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
          middle: this._localPoint((a.x + b.x) / 2, (a.y + b.y) / 2),
          origin: this.transform,
        };
        this._pointers.forEach((p, id) => this._capture(id));
      }
    }

    _onPointerMove(e) {
      if (!this._pointers.has(e.pointerId)) {
        return;
      }
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this._pinch && this._pointers.size >= 2) {
        // zoom around the initial middle of the two fingers, and follow the middle when it moves
        const p = this._pinch;
        const [a, b] = Array.from(this._pointers.values());
        const middle = this._localPoint((a.x + b.x) / 2, (a.y + b.y) / 2);
        const scale = G.clamp((p.origin.scale * Math.hypot(b.x - a.x, b.y - a.y)) / p.distance, MIN_SCALE, MAX_SCALE);
        const t = G.zoomAround(p.origin, scale, p.middle.x, p.middle.y);
        this._autoView = null;
        this._setTransform({ scale: t.scale, x: t.x + middle.x - p.middle.x, y: t.y + middle.y - p.middle.y });
        return;
      }
      const d = this._drag;
      if (!d || d.id !== e.pointerId) {
        return;
      }
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (!d.moved) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) {
          return;
        }
        d.moved = true;
        this._capture(e.pointerId);
        this.viewport.classList.add('is-panning');
      }
      this._autoView = null;
      this._setTransform({ scale: d.origin.scale, x: d.origin.x + dx, y: d.origin.y + dy });
    }

    _onPointerUp(e) {
      this._pointers.delete(e.pointerId);
      if (this._pointers.size < 2) {
        this._pinch = null;
      }
      if (this._drag && this._drag.id === e.pointerId) {
        this._drag = null;
        this.viewport.classList.remove('is-panning');
      }
    }

    _capture(pointerId) {
      try {
        this.viewport.setPointerCapture(pointerId);
      } catch (err) {
        // the pointer may already be released
      }
    }

    _onWheel(e) {
      e.preventDefault();
      let dx = e.deltaX;
      let dy = e.deltaY;
      if (e.deltaMode === 1) {
        dx *= 16;
        dy *= 16;
      } else if (e.deltaMode === 2) {
        const v = this._viewSize();
        dx *= v.width;
        dy *= v.height;
      }
      if (e.ctrlKey || e.metaKey) {
        // pinch on a trackpad (reported as Ctrl + wheel by Chrome and Firefox) or Ctrl/Cmd + mouse wheel
        const exponent = G.clamp(-dy * 0.01, -0.5, 0.5);
        this.zoomTo(this.transform.scale * Math.pow(2, exponent), this._localPoint(e.clientX, e.clientY));
        return;
      }
      if (e.shiftKey && !dx) {
        dx = dy;
        dy = 0;
      }
      this.panBy(-dx, -dy);
    }

    _onGesture(e) {
      e.preventDefault();
      if (e.type === 'gesturestart') {
        this._gesture = { origin: this.transform, point: this._localPoint(e.clientX, e.clientY) };
      } else if (e.type === 'gesturechange' && this._gesture) {
        const g = this._gesture;
        const scale = G.clamp(g.origin.scale * e.scale, MIN_SCALE, MAX_SCALE);
        this._autoView = null;
        this._setTransform(G.zoomAround(g.origin, scale, g.point.x, g.point.y));
      } else {
        this._gesture = null;
      }
    }

    _onKeyDown(e) {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) {
        return;
      }
      switch (e.key) {
        case '+':
        case '=':
          this.zoomIn();
          break;
        case '-':
        case '_':
          this.zoomOut();
          break;
        case 'f':
        case 'F':
          this.fit();
          break;
        case 'c':
        case 'C':
          this.centerOnCurrent();
          break;
        case DIRECTION_KEYS.TB.key:
        case DIRECTION_KEYS.LR.key:
          if (e.shiftKey) {
            return;
          }
          this._chooseDirection(e.key === DIRECTION_KEYS.LR.key ? 'LR' : 'TB');
          break;
        default:
          return;
      }
      e.preventDefault();
    }
  }

  LWG.Renderer = Renderer;
})(typeof window !== 'undefined' ? window : globalThis);
