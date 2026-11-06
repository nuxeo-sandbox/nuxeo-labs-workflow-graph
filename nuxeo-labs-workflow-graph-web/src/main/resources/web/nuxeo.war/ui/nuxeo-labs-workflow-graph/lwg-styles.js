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
 * Styles of the graph (LWG.Renderer), injected once in the root (shadow root or document) holding it. Colors
 * derive from the Web UI theme variables (--nuxeo-*), so the default, dark and Hyland themes are supported.
 * No animation, no transition.
 *
 * Public variables (--lwg-current, --lwg-passed, --lwg-dimmed-opacity, --lwg-color-*, --lwg-transition-1 to 5,
 * --lwg-bg, --lwg-card-bg, --lwg-text, --lwg-edge, --lwg-grid) can be set on html or any ancestor, e.g. from a theme
 * or a Studio style. They are only read here, through the internal --_lwg-* variables, so a value set outside is
 * never shadowed by a default.
 *
 * Sizes must stay in sync with LWG.METRICS (lwg-core.js), used to compute the layout.
 *
 * @since 2025.1
 */
(function (root) {
  'use strict';

  const LWG = root.NuxeoLabs && root.NuxeoLabs.WorkflowGraph;
  if (!LWG || LWG.CSS) {
    return;
  }

  LWG.CSS = `
.lwg-root, .lwg-theme {
  --_lwg-font: var(--nuxeo-app-font, Inter, 'Noto Sans', Arial, sans-serif);
  --_lwg-text: var(--lwg-text, var(--nuxeo-text-default, #3a3a54));
  --_lwg-bg: var(--lwg-bg, var(--nuxeo-page-background, #f5f5f5));
  --_lwg-card-bg: var(--lwg-card-bg, var(--nuxeo-box, #ffffff));
  --_lwg-card-border: color-mix(in srgb, var(--_lwg-text) 15%, var(--_lwg-card-bg));
  --_lwg-text-muted: color-mix(in srgb, var(--_lwg-text) 66%, var(--_lwg-card-bg));
  --_lwg-edge: var(--lwg-edge, color-mix(in srgb, var(--_lwg-text) 40%, var(--_lwg-bg)));
  --_lwg-label-border: color-mix(in srgb, var(--_lwg-text) 18%, var(--_lwg-card-bg));
  --_lwg-grid: var(--lwg-grid, color-mix(in srgb, var(--_lwg-text) 16%, var(--_lwg-bg)));
  --_lwg-current: var(--lwg-current, var(--nuxeo-focus-ring-color, var(--nuxeo-primary-color, #0066ff)));
  --_lwg-passed: var(--lwg-passed, #0d9488);
  --_lwg-dimmed: var(--lwg-dimmed-opacity, 0.4);
  --_lwg-color-start: var(--lwg-color-start, #1f9d63);
  --_lwg-color-end: var(--lwg-color-end, #e5484d);
  --_lwg-color-step: var(--lwg-color-step, #3b7ff5);
  --_lwg-color-multi: var(--lwg-color-multi, #8b5cf6);
  --_lwg-color-sub: var(--lwg-color-sub, #0f9f96);
  --_lwg-color-gateway: var(--lwg-color-gateway, #e8830c);
  --_lwg-transition-1: var(--lwg-transition-1, #16a34a);
  --_lwg-transition-2: var(--lwg-transition-2, #ea580c);
  --_lwg-transition-3: var(--lwg-transition-3, #9333ea);
  --_lwg-transition-4: var(--lwg-transition-4, #db2777);
  --_lwg-transition-5: var(--lwg-transition-5, #0891b2);
  --_lwg-shadow: 0 1px 2px rgba(16, 24, 40, 0.06), 0 4px 14px rgba(16, 24, 40, 0.07);
  --_lwg-kind: var(--_lwg-color-step);
}

.lwg-root {
  position: relative;
  overflow: hidden;
  width: 100%;
  height: 100%;
  font-family: var(--_lwg-font);
  color: var(--_lwg-text);
  background: var(--_lwg-bg);
  -webkit-font-smoothing: antialiased;
}

.lwg-root *, .lwg-root *::before, .lwg-root *::after {
  box-sizing: border-box;
}

.lwg-viewport {
  position: absolute;
  inset: 0;
  overflow: hidden;
  cursor: grab;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  outline: none;
  background-image: radial-gradient(circle, var(--_lwg-grid) 1px, transparent 1.4px);
  background-size: 20px 20px;
}

.lwg-viewport.is-panning {
  cursor: grabbing;
}

.lwg-viewport:focus-visible {
  box-shadow: inset 0 0 0 2px var(--_lwg-current);
}

.lwg-stage {
  position: absolute;
  left: 0;
  top: 0;
  transform-origin: 0 0;
}

.lwg-edges, .lwg-labels, .lwg-nodes {
  position: absolute;
  left: 0;
  top: 0;
}

.lwg-edges {
  z-index: 0;
  overflow: visible;
}

.lwg-labels {
  z-index: 1;
}

.lwg-nodes {
  z-index: 2;
}

/* ==================== Transitions ==================== */

/* --_lwg-tc is the color of a transition (line, arrow, label): neutral by default, the highlight color when it
   leaves a current step, a color of the palette (lwg-tc-1 to 5, set with lwg-tc) when its step has several
   transitions. Leaving a current step, a transition of the palette keeps its color and is drawn thicker.
   Already followed (is-taken, never with is-next), a transition has the color of the steps already done, whatever
   its palette color: the rule comes after the palette ones. */
.lwg-edge, .lwg-label { --_lwg-tc: var(--_lwg-edge); }
.lwg-edge.is-next, .lwg-label.is-next { --_lwg-tc: var(--_lwg-current); }
.lwg-edge.lwg-tc-1, .lwg-label.lwg-tc-1 { --_lwg-tc: var(--_lwg-transition-1); }
.lwg-edge.lwg-tc-2, .lwg-label.lwg-tc-2 { --_lwg-tc: var(--_lwg-transition-2); }
.lwg-edge.lwg-tc-3, .lwg-label.lwg-tc-3 { --_lwg-tc: var(--_lwg-transition-3); }
.lwg-edge.lwg-tc-4, .lwg-label.lwg-tc-4 { --_lwg-tc: var(--_lwg-transition-4); }
.lwg-edge.lwg-tc-5, .lwg-label.lwg-tc-5 { --_lwg-tc: var(--_lwg-transition-5); }
.lwg-edge.is-taken, .lwg-label.is-taken { --_lwg-tc: var(--_lwg-passed); }

.lwg-edge-line {
  fill: none;
  stroke: var(--_lwg-tc);
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.lwg-edge-arrow {
  fill: var(--_lwg-tc);
}

.lwg-edge.is-next .lwg-edge-line {
  stroke-width: 3;
}

.lwg-edge.is-next.lwg-tc .lwg-edge-line {
  stroke-width: 3.5;
}

.lwg-edge.is-taken .lwg-edge-line {
  stroke-width: 2.4;
}

.lwg-label {
  position: absolute;
  height: 22px;
  padding: 0 9px;
  border-radius: 11px;
  border: 1px solid var(--_lwg-label-border);
  background: var(--_lwg-card-bg);
  color: var(--_lwg-text-muted);
  font-size: 11px;
  font-weight: 500;
  line-height: 20px;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.05);
}

.lwg-label.is-next {
  z-index: 1;
  border-color: color-mix(in srgb, var(--_lwg-tc) 60%, var(--_lwg-card-bg));
  background: color-mix(in srgb, var(--_lwg-tc) 8%, var(--_lwg-card-bg));
  color: var(--_lwg-tc);
}

/* Palette: the text keeps a neutral color (readable whatever the color and the theme), the border width does
   not change (the label sizes are computed in lwg-core.js). */
.lwg-label.lwg-tc {
  border-color: color-mix(in srgb, var(--_lwg-tc) 55%, var(--_lwg-card-bg));
  background: color-mix(in srgb, var(--_lwg-tc) 7%, var(--_lwg-card-bg));
}

.lwg-label.is-next.lwg-tc {
  border-color: var(--_lwg-tc);
  background: color-mix(in srgb, var(--_lwg-tc) 14%, var(--_lwg-card-bg));
  color: var(--_lwg-text);
}

.lwg-label.is-taken {
  border-color: color-mix(in srgb, var(--_lwg-tc) 75%, var(--_lwg-card-bg));
  background: color-mix(in srgb, var(--_lwg-tc) 10%, var(--_lwg-card-bg));
  color: var(--_lwg-text);
}

/* Never followed and cannot be followed anymore (branch not followed): faded. The labels stay opaque (their
   transition passes below them), they are faded with their colors. */
.lwg-edge.is-dimmed {
  opacity: calc(var(--_lwg-dimmed) * 0.8);
}

.lwg-label.is-dimmed {
  border-color: color-mix(in srgb, var(--_lwg-tc) calc(var(--_lwg-dimmed) * 60%), var(--_lwg-card-bg));
  background: var(--_lwg-card-bg);
  color: color-mix(in srgb, var(--_lwg-text-muted) calc(var(--_lwg-dimmed) * 100%), var(--_lwg-card-bg));
  box-shadow: none;
}

/* ==================== Steps ==================== */

.lwg-node {
  --_lwg-kind: var(--_lwg-color-step);
  position: absolute;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid var(--_lwg-card-border);
  background: var(--_lwg-card-bg);
  color: var(--_lwg-text);
  box-shadow: var(--_lwg-shadow);
}

.lwg-kind-start { --_lwg-kind: var(--_lwg-color-start); }
.lwg-kind-end { --_lwg-kind: var(--_lwg-color-end); }
.lwg-kind-step { --_lwg-kind: var(--_lwg-color-step); }
.lwg-kind-multiTask { --_lwg-kind: var(--_lwg-color-multi); }
.lwg-kind-subWorkflow { --_lwg-kind: var(--_lwg-color-sub); }
.lwg-kind-fork, .lwg-kind-merge { --_lwg-kind: var(--_lwg-color-gateway); }

.lwg-node-icon {
  flex: 0 0 34px;
  width: 34px;
  height: 34px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--_lwg-kind);
  background: color-mix(in srgb, var(--_lwg-kind) 14%, var(--_lwg-card-bg));
}

.lwg-node-icon svg {
  width: 20px;
  height: 20px;
  fill: currentColor;
}

.lwg-kind-fork .lwg-node-icon, .lwg-kind-merge .lwg-node-icon {
  border-radius: 6px;
  transform: rotate(45deg) scale(0.86);
}

.lwg-kind-fork .lwg-node-icon svg, .lwg-kind-merge .lwg-node-icon svg {
  transform: rotate(-45deg);
}

.lwg-node-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.lwg-node-caption {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  line-height: 15px;
  color: var(--_lwg-kind);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.lwg-node-line {
  font-size: 13px;
  font-weight: 600;
  line-height: 18px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.lwg-node.lwg-terminal {
  justify-content: center;
  gap: 8px;
  padding: 0 16px;
  border-radius: 999px;
  border-color: color-mix(in srgb, var(--_lwg-kind) 45%, var(--_lwg-card-bg));
  background: color-mix(in srgb, var(--_lwg-kind) 9%, var(--_lwg-card-bg));
}

.lwg-terminal .lwg-node-icon {
  flex: 0 0 22px;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--_lwg-kind);
  color: #ffffff;
}

.lwg-terminal .lwg-node-icon svg {
  width: 14px;
  height: 14px;
}

.lwg-terminal .lwg-node-body {
  flex: 0 1 auto;
}

/* The ring keeps at least 6 screen px at low zoom (--_lwg-inv-scale = 1 / zoom, set by the renderer), so the
   current step can still be spotted when the whole graph is fitted. */
.lwg-node.is-current {
  border: 2px solid var(--_lwg-current);
  padding: 11px 13px;
  box-shadow: 0 0 0 max(5px, calc(6px * var(--_lwg-inv-scale, 1)))
      color-mix(in srgb, var(--_lwg-current) 22%, transparent),
    var(--_lwg-shadow);
}

.lwg-node.lwg-terminal.is-current {
  padding: 0 15px;
}

/* Steps already done (never with is-current): border in the color of the trail and a check badge in the corner.
   The border is 1px thicker, the padding 1px thinner: the size does not change (LWG.METRICS). */
.lwg-node.is-passed {
  border: 2px solid color-mix(in srgb, var(--_lwg-passed) 80%, var(--_lwg-card-bg));
  padding: 11px 13px;
}

.lwg-node.lwg-terminal.is-passed {
  padding: 0 15px;
}

.lwg-node-check {
  position: absolute;
  top: -9px;
  right: -9px;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--_lwg-passed);
  color: #ffffff;
  box-shadow: 0 0 0 2px var(--_lwg-card-bg);
}

.lwg-node-check svg {
  width: 14px;
  height: 14px;
  fill: currentColor;
}

/* Steps never reached and that cannot be reached anymore (branch not followed): faded and grayed, so the path
   followed and the steps still to come stand out. */
.lwg-node.is-dimmed {
  opacity: var(--_lwg-dimmed);
  filter: grayscale(0.7);
  box-shadow: none;
}

.lwg-node-badge {
  position: absolute;
  top: -11px;
  right: 12px;
  height: 20px;
  padding: 0 8px;
  display: flex;
  align-items: center;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--_lwg-current) 60%, var(--_lwg-card-bg));
  background: color-mix(in srgb, var(--_lwg-current) 16%, var(--_lwg-card-bg));
  color: var(--_lwg-current);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  white-space: nowrap;
}

/* ==================== Toolbar ==================== */

.lwg-toolbar {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px;
  border-radius: 12px;
  border: 1px solid var(--_lwg-card-border);
  background: var(--_lwg-card-bg);
  box-shadow: var(--_lwg-shadow);
}

.lwg-tb-btn {
  appearance: none;
  -webkit-appearance: none;
  margin: 0;
  padding: 0;
  border: none;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  color: var(--_lwg-text);
  font: inherit;
  cursor: pointer;
}

.lwg-tb-btn svg {
  width: 20px;
  height: 20px;
  fill: currentColor;
}

.lwg-tb-btn:hover {
  background: color-mix(in srgb, var(--_lwg-text) 9%, var(--_lwg-card-bg));
}

.lwg-tb-btn:focus-visible {
  outline: 2px solid var(--_lwg-current);
  outline-offset: 1px;
}

.lwg-tb-btn[aria-pressed='true'] {
  background: color-mix(in srgb, var(--_lwg-current) 16%, var(--_lwg-card-bg));
  color: var(--_lwg-current);
}

.lwg-tb-btn[hidden], .lwg-tb-sep[hidden] {
  display: none;
}

.lwg-tb-zoom {
  min-width: 48px;
  text-align: center;
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.lwg-tb-sep {
  width: 1px;
  height: 20px;
  margin: 0 4px;
  background: var(--_lwg-card-border);
}

/* ==================== Empty graph ==================== */

.lwg-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--_lwg-text-muted);
  font-size: 14px;
  pointer-events: none;
}

.lwg-empty[hidden] {
  display: none;
}
`;
})(typeof window !== 'undefined' ? window : globalThis);
