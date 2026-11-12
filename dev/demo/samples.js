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
 * Development fixtures (NOT packaged): responses of GET /api/v1/workflow/{id}/graph on a Nuxeo LTS 2025 server,
 * rebuilt from the workflow definitions shipped with Nuxeo (nuxeo-routing-default: SerialDocumentReview and
 * ParallelDocumentReview; nuxeo-routing-rest-api tests: MainWF), plus synthetic workflows: "contract" (fork,
 * merge, back edges, sub-workflow, self-loop, long titles) and "large" (59 steps, two current steps in
 * parallel branches), generated without randomness.
 *
 * Node titles and transition labels are already translated, as the server does with its messages bundle
 * (untranslated keys such as "automatic_transition" are returned as is).
 *
 * Each sample also has a history (steps already done, transitions already followed), in the format returned by the
 * operation LabsWorkflowGraph.GetWorkflowGraph, which builds it from the audit entries written by the recorder of the
 * plugin (the Java tests cover that part). The demo shows it unless "history=off".
 */
(function (root) {
  'use strict';

  function node(id, title, x, y, state, extra) {
    return Object.assign(
      {
        x,
        y,
        isForkNode: false,
        isStartNode: false,
        isEndNode: false,
        id,
        title,
        state,
        isMerge: false,
        isMultiTask: false,
        hasSubWorkflow: false,
      },
      extra || {},
    );
  }

  function tr(source, target, label) {
    return { nodeSourceId: source, nodeTargetId: target, label, path: [] };
  }

  /*
   * History of a sample, as returned by the operation (the "history" of its JSON). done: ids of the steps completed
   * at least once; followed: [source, label] of the transitions followed at least once (their position in the source
   * is counted as the server does, their name is made up: the graph does not return it).
   */
  function history(graph, done, followed) {
    const transitions = followed.map(([source, label]) => {
      const fromSource = graph.transitions.filter((t) => t.nodeSourceId === source);
      const index = fromSource.findIndex((t) => t.label === label);
      if (index < 0) {
        throw new Error(`No transition "${label}" from ${source}`);
      }
      return { source, index, name: `${source}-${index}`, target: fromSource[index].nodeTargetId, count: 1 };
    });
    return { nodes: done.map((id) => ({ id, completed: true, count: 1 })), transitions, truncated: false };
  }

  const serial = {
    label: 'Serial Document Review',
    title: 'wf.serialDocumentReview.SerialDocumentReview',
    graph: {
      'entity-type': 'graph',
      nodes: [
        node('Task375f', 'Start', 440, 0, 'ready', { isStartNode: true }),
        node('Task38e', 'Choose Participants', 420, 100, 'ready'),
        node('Task542', 'Update the Document', 620, 280, 'ready'),
        node('Task5c1', 'Stop', 420, 620, 'ready', { isEndNode: true }),
        node('Task6d8', 'Validate the Document', 240, 280, 'suspended'),
      ],
      transitions: [
        tr('Task375f', 'Task38e', 'start'),
        tr('Task38e', 'Task5c1', 'Cancelation'),
        tr('Task38e', 'Task6d8', 'Review Start'),
        tr('Task542', 'Task5c1', 'Cancelation'),
        tr('Task542', 'Task6d8', 'Document Re-Submission'),
        tr('Task6d8', 'Task5c1', 'End'),
        tr('Task6d8', 'Task6d8', 'Rejection'),
        tr('Task6d8', 'Task542', 'Document Update Request'),
        tr('Task6d8', 'Task6d8', 'Validation'),
      ],
    },
  };
  // the current step (Validate) was rejected once: done, but shown as current
  serial.history = history(
    serial.graph,
    ['Task375f', 'Task38e', 'Task6d8'],
    [
      ['Task375f', 'start'],
      ['Task38e', 'Review Start'],
      ['Task6d8', 'Rejection'],
    ],
  );

  const parallel = {
    label: 'Parallel Document Review',
    title: 'wf.parallelDocumentReview.ParallelDocumentReview',
    graph: {
      'entity-type': 'graph',
      nodes: [
        node('Task2169', 'Consolidate the Review', 360, 320, 'ready'),
        node('Task21a0', 'Start', 360, 20, 'ready', { isStartNode: true }),
        node('Task2225', 'Stop', 580, 240, 'ready', { isEndNode: true }),
        node('Task22b4', 'Stop', 580, 480, 'ready', { isEndNode: true }),
        node('Task232e', 'Stop', 160, 480, 'ready', { isEndNode: true }),
        node('Task2556', 'Choose Participants', 340, 120, 'ready'),
        node('Task328d', 'Give your Opinion', 140, 240, 'suspended', { isMultiTask: true }),
      ],
      transitions: [
        tr('Task2169', 'Task22b4', 'Validation'),
        tr('Task2169', 'Task232e', 'Rejection'),
        tr('Task21a0', 'Task2556', 'automatic_transition'),
        tr('Task2556', 'Task2225', 'Cancelation'),
        tr('Task2556', 'Task328d', 'Review start'),
        tr('Task328d', 'Task2169', 'automatic'),
      ],
    },
  };
  parallel.history = history(
    parallel.graph,
    ['Task21a0', 'Task2556'],
    [
      ['Task21a0', 'automatic_transition'],
      ['Task2556', 'Review start'],
    ],
  );

  const subWorkflow = {
    label: 'MainWF (sub-workflow)',
    title: 'MainWF',
    graph: {
      'entity-type': 'graph',
      nodes: [
        node('Task18b2', 'Approve', 300, 380, 'ready'),
        node('Task9b9', 'ChildWF', 220, 160, 'suspended', { hasSubWorkflow: true }),
        node('start-node', 'Start', 200, 50, 'ready', { isStartNode: true }),
        node('stop-node', 'Stop', 200, 540, 'ready', { isEndNode: true }),
      ],
      transitions: [
        tr('Task18b2', 'stop-node', 'approve'),
        tr('Task9b9', 'stop-node', 'transition'),
        tr('Task9b9', 'Task18b2', 'transition2'),
        tr('start-node', 'Task9b9', 'automatic_transition'),
      ],
    },
  };
  subWorkflow.history = history(subWorkflow.graph, ['start-node'], [['start-node', 'automatic_transition']]);

  const contract = {
    label: 'Contract Approval (synthetic)',
    title: 'Contract Approval',
    graph: {
      'entity-type': 'graph',
      nodes: [
        node('n-start', 'Start', 300, 0, 'ready', { isStartNode: true }),
        node('n-prepare', 'Prepare the contract', 280, 100, 'ready'),
        node('n-fork', 'Parallel reviews', 300, 200, 'ready', { isForkNode: true }),
        node(
          'n-legal',
          'Check compliance with the regional data-protection regulations and the internal policies',
          100,
          300,
          'suspended',
        ),
        node('n-finance', 'Finance review', 500, 300, 'ready'),
        node('n-merge', 'Reviews completed', 300, 400, 'waiting', { isMerge: true }),
        node('n-decision', 'Decision', 300, 500, 'ready'),
        node('n-board', 'Board approval', 560, 520, 'ready', { hasSubWorkflow: true }),
        node('n-sign', 'Collect the signatures', 300, 620, 'ready', { isMultiTask: true }),
        node('n-archive', 'Archive', 300, 720, 'ready'),
        node('n-stop', 'Stop', 300, 820, 'ready', { isEndNode: true }),
        node('n-stop-rejected', 'Rejected', 40, 620, 'ready', { isEndNode: true }),
      ],
      transitions: [
        tr('n-start', 'n-prepare', 'automatic_transition'),
        tr('n-prepare', 'n-fork', 'Submit'),
        tr('n-fork', 'n-legal', 'Legal'),
        tr('n-fork', 'n-finance', 'Finance'),
        tr('n-legal', 'n-merge', 'Compliant'),
        tr('n-legal', 'n-prepare', 'Changes requested'),
        tr('n-finance', 'n-merge', 'Approved'),
        tr('n-finance', 'n-merge', 'Approved with reservations'),
        tr('n-merge', 'n-decision', ''),
        tr('n-decision', 'n-sign', 'Approve'),
        tr('n-decision', 'n-board', 'Amount above the delegation threshold'),
        tr('n-decision', 'n-stop-rejected', 'Reject'),
        tr('n-decision', 'n-prepare', 'Rework'),
        tr('n-board', 'n-sign', 'Board approved'),
        tr('n-board', 'n-stop-rejected', 'Board rejected'),
        tr('n-sign', 'n-sign', 'Reminder'),
        tr('n-sign', 'n-archive', 'All signed'),
        tr('n-archive', 'n-stop', ''),
      ],
    },
  };
  // the legal review requested changes once, finance approved with reservations, the merge waits for the legal review
  contract.history = history(
    contract.graph,
    ['n-start', 'n-prepare', 'n-fork', 'n-legal', 'n-finance'],
    [
      ['n-start', 'automatic_transition'],
      ['n-prepare', 'Submit'],
      ['n-fork', 'Legal'],
      ['n-fork', 'Finance'],
      ['n-legal', 'Changes requested'],
      ['n-finance', 'Approved with reservations'],
    ],
  );

  // 8 phases of 7 steps (prepare, fork, 3 reviews, merge, check) between a start and two ends. Phase 5 is
  // running: its reviews by teams 1 and 3 are the current steps, the team 2 is done, so its merge is waiting.
  // Only the quality check of phase 4 can reject the project: a branch not followed, it cannot happen anymore.
  function buildLarge() {
    const nodes = [node('l-start', 'Start', 400, 0, 'ready', { isStartNode: true })];
    const transitions = [];
    let previous = 'l-start';
    for (let p = 1; p <= 8; p++) {
      const y = p * 700;
      const id = (s) => `l-p${p}-${s}`;
      nodes.push(
        node(id('prepare'), `Phase ${p}: prepare the deliverables`, 380, y, 'ready'),
        node(id('fork'), `Phase ${p}: reviews`, 400, y + 100, 'ready', { isForkNode: true }),
        node(id('merge'), `Phase ${p}: reviews done`, 400, y + 300, p === 5 ? 'waiting' : 'ready', { isMerge: true }),
        node(id('check'), `Phase ${p}: quality check`, 380, y + 400, 'ready'),
      );
      transitions.push(
        tr(previous, id('prepare'), p === 1 ? 'automatic_transition' : 'Approved'),
        tr(id('prepare'), id('fork'), 'Submit'),
        tr(id('merge'), id('check'), ''),
        tr(id('check'), id('prepare'), 'Rework'),
      );
      for (let k = 1; k <= 3; k++) {
        const review = id(`review${k}`);
        const state = p === 5 && k !== 2 ? 'suspended' : 'ready';
        const extra = k === 2 ? { isMultiTask: true } : {};
        nodes.push(node(review, `Phase ${p}: review by team ${k}`, 200 * k, y + 200, state, extra));
        transitions.push(tr(id('fork'), review, `Team ${k}`), tr(review, id('merge'), 'Done'));
      }
      if (p % 3 === 0) {
        transitions.push(tr(id('review2'), id('review2'), 'Reminder'));
      }
      previous = id('check');
    }
    nodes.push(
      node('l-stop', 'Stop', 400, 6400, 'ready', { isEndNode: true }),
      node('l-rejected', 'Rejected', 800, 6400, 'ready', { isEndNode: true }),
    );
    transitions.push(
      tr(previous, 'l-stop', 'Approved'),
      tr('l-p4-check', 'l-rejected', 'Rejected'),
    );
    return { 'entity-type': 'graph', nodes, transitions };
  }

  // Phases 1 to 4 are done (phase 2 was reworked once), in phase 5 the team 2 has done its review.
  function buildLargeHistory(graph) {
    const done = ['l-start'];
    const followed = [['l-start', 'automatic_transition']];
    for (let p = 1; p <= 5; p++) {
      const id = (s) => `l-p${p}-${s}`;
      done.push(id('prepare'), id('fork'));
      followed.push([id('prepare'), 'Submit'], [id('fork'), 'Team 1'], [id('fork'), 'Team 2'], [id('fork'), 'Team 3']);
      if (p === 5) {
        done.push(id('review2'));
        followed.push([id('review2'), 'Done']);
        break;
      }
      done.push(id('review1'), id('review2'), id('review3'), id('merge'), id('check'));
      followed.push([id('review1'), 'Done'], [id('review2'), 'Done'], [id('review3'), 'Done'], [id('merge'), '']);
      followed.push([id('check'), 'Approved']);
      if (p === 2) {
        followed.push([id('check'), 'Rework']);
      }
    }
    return history(graph, done, followed);
  }

  const large = {
    label: 'Large project (synthetic, 59 steps)',
    title: 'Large project',
    graph: buildLarge(),
  };
  large.history = buildLargeHistory(large.graph);

  const samples = { serial, parallel, subWorkflow, contract, large };

  root.LWG_SAMPLES = samples;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = samples;
  }
})(typeof window !== 'undefined' ? window : globalThis);
