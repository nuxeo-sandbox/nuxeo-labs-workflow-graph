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
 * Replaces the graph opened by Web UI's "View Graph" links.
 *
 * Web UI's nuxeo-workflow-graph element is used in two places (document workflow bar and task view), and both
 * only call its show() method. Redefining the element is not possible (customElements.define would throw), so
 * its show() is patched once the element is defined: show() opens nuxeo-labs-workflow-graph-dialog, created
 * inside the element's shadow root; if the dialog is not available or the graph cannot be drawn, the original
 * show() is called. No Web UI file is modified. Only the workflow id of the element is used: the dialog gets
 * everything else from the server.
 *
 * @since 2025.1
 */
(function (root) {
  'use strict';

  const LWG = root.NuxeoLabs && root.NuxeoLabs.WorkflowGraph;
  if (!LWG || LWG.overrideInstalled || !root.customElements) {
    return;
  }
  LWG.overrideInstalled = true;

  const TARGET = 'nuxeo-workflow-graph';
  const DIALOG = 'nuxeo-labs-workflow-graph-dialog';

  function getDialog(host) {
    const shadow = host.shadowRoot || host.root;
    if (!shadow || !root.customElements.get(DIALOG)) {
      return null;
    }
    let dialog = host.__lwgDialog;
    if (!dialog || dialog.getRootNode() !== shadow) {
      dialog = root.document.createElement(DIALOG);
      shadow.appendChild(dialog);
      host.__lwgDialog = dialog;
    }
    return typeof dialog.open === 'function' ? dialog : null;
  }

  function createShow(originalShow) {
    const show = function (...args) {
      const dialog = getDialog(this);
      if (!dialog) {
        console.warn(LWG.LOG_PREFIX, 'The graph dialog is not available, using the default graph');
        return originalShow.apply(this, args);
      }
      return dialog.open(this.workflowId).catch((error) => {
        if (error && error.lwgFallback) {
          console.warn(LWG.LOG_PREFIX, 'The graph cannot be drawn, using the default graph', error.cause || error);
          return originalShow.apply(this, args);
        }
        throw error;
      });
    };
    show.lwgPatched = true;
    show.lwgOriginal = originalShow;
    return show;
  }

  // Patches the show() method of the nuxeo-workflow-graph class. Returns false if it cannot be patched.
  LWG.patchWorkflowGraphElement = function (ctor) {
    const proto = ctor && ctor.prototype;
    if (!proto || typeof proto.show !== 'function') {
      console.warn(LWG.LOG_PREFIX, `${TARGET} has no show() method, the default graph is kept`);
      return false;
    }
    if (proto.show.lwgPatched) {
      return true;
    }
    const show = createShow(proto.show);
    proto.show = show;
    // With Polymer's legacyOptimizations (not enabled by Web UI), methods are copied from the element
    // definition at the first instantiation: patch the definition too so the patch is not overwritten.
    const info = ctor.generatedFrom;
    if (info && typeof info.show === 'function' && !info.show.lwgPatched) {
      info.show = show;
    }
    return true;
  };

  root.customElements.whenDefined(TARGET).then(() => {
    LWG.patchWorkflowGraphElement(root.customElements.get(TARGET));
  });
})(typeof window !== 'undefined' ? window : globalThis);
