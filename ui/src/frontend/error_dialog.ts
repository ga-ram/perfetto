// Copyright (C) 2019 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as m from 'mithril';

import {saveTrace} from '../common/upload_utils';

import {globals} from './globals';
import {showModal} from './modal';
import {isShareable} from './trace_attrs';

// Never show more than one dialog per minute.
const MIN_REPORT_PERIOD_MS = 60000;
let timeLastReport = 0;

// Keeps the last ERR_QUEUE_MAX_LEN errors while the dialog is throttled.
const queuedErrors = new Array<string>();
const ERR_QUEUE_MAX_LEN = 10;

export function maybeShowErrorDialog(errLog: string) {
  globals.logging.logError(errLog);
  const now = performance.now();

  // Here we rely on the exception message from onCannotGrowMemory function
  if (errLog.includes('Cannot enlarge memory')) {
    showOutOfMemoryDialog();
    // Refresh timeLastReport to prevent a different error showing a dialog
    timeLastReport = now;
    return;
  }

  if (errLog.includes('Unable to claim interface.') ||
      errLog.includes('A transfer error has occurred')) {
    showWebUSBError();
    timeLastReport = now;
  }

  if (errLog.includes('(ERR:fmt)')) {
    showUnknownFileError();
    return;
  }

  if (errLog.includes('(ERR:rpc_seq)')) {
    showRpcSequencingError();
    return;
  }

  if (timeLastReport > 0 && now - timeLastReport <= MIN_REPORT_PERIOD_MS) {
    queuedErrors.unshift(errLog);
    if (queuedErrors.length > ERR_QUEUE_MAX_LEN) queuedErrors.pop();
    console.log('Suppressing crash dialog, last error notified too soon.');
    return;
  }
  timeLastReport = now;

  // Append queued errors.
  while (queuedErrors.length > 0) {
    const queuedErr = queuedErrors.shift();
    errLog += `\n\n---------------------------------------\n${queuedErr}`;
  }

  const errTitle = errLog.split('\n', 1)[0].substr(0, 80);
  let checked = false;
  const engine = Object.values(globals.state.engines)[0];

  const shareTraceSection: m.Vnode[] = [];
  if (isShareable() && !urlExists()) {
    shareTraceSection.push(
        m(`input[type=checkbox]`, {
          checked,
          oninput: (ev: InputEvent) => {
            checked = (ev.target as HTMLInputElement).checked;
            if (checked && engine.source.type === 'FILE') {
              saveTrace(engine.source.file).then(() => {
                renderModal(
                    errTitle, shareTraceSection);
                return;
              });
            }
            renderModal(
                errTitle, shareTraceSection);
          },
        }),
        m('span', `Check this box to share the current trace for debugging
     purposes.`),
        m('div.modal-small',
          `This will create a permalink to this trace, you may
     leave it unchecked and attach the trace manually
     to the bug if preferred.`));
  }
  renderModal(
      errTitle,
      shareTraceSection);
}

function renderModal(
    errMessage: string,
    shareTraceSection: m.Vnode[]) {
  showModal({
    title: 'Oops, something went wrong. Please file a bug.',
    content:
        m('div',
          m('.modal-logs', errMessage),
          shareTraceSection),
    buttons: [
      {
        text: 'File a bug',
        primary: true,
        id: 'file_bug',
        action: () => {
          window.open('https://github.com/pinpoint-apm/pinpoint/issues/new/choose', '_blank');
        }
      },
    ]
  });
}

// If there is a trace URL to share, we don't have to show the upload checkbox.
function urlExists() {
  const engine = Object.values(globals.state.engines)[0];
  return engine !== undefined &&
      (engine.source.type === 'ARRAY_BUFFER' || engine.source.type === 'URL') &&
      engine.source.url !== undefined;
}

function showOutOfMemoryDialog() {
  const url =
      'https://perfetto.dev/docs/quickstart/trace-analysis#get-trace-processor';

  const tpCmd = 'curl -LO https://get.perfetto.dev/trace_processor\n' +
      'chmod +x ./trace_processor\n' +
      'trace_processor --httpd /path/to/trace.pftrace\n' +
      '# Reload the UI, it will prompt to use the HTTP+RPC interface';
  showModal({
    title: 'Oops! Your WASM trace processor ran out of memory',
    content: m(
        'div',
        m('span',
          'The in-memory representation of the trace is too big ' +
              'for the browser memory limits (typically 2GB per tab).'),
        m('br'),
        m('span',
          'You can work around this problem by using the trace_processor ' +
              'native binary as an accelerator for the UI as follows:'),
        m('br'),
        m('br'),
        m('.modal-bash', tpCmd),
        m('br'),
        m('span', 'For details see '),
        m('a', {href: url, target: '_blank'}, url),
        ),
    buttons: []
  });
}

function showUnknownFileError() {
  showModal({
    title: 'Cannot open this file',
    content: m(
        'div',
        m('p',
          'The file opened doesn\'t look like a Perfetto trace or any ' +
              'other format recognized by the Perfetto TraceProcessor.'),
        m('p', 'Formats supported:'),
        m(
            'ul',
            m('li', 'Perfetto protobuf trace'),
            m('li', 'chrome://tracing JSON'),
            m('li', 'Android systrace'),
            m('li', 'Fuchsia trace'),
            m('li', 'Ninja build log'),
            ),
        ),
    buttons: []
  });
}

function showWebUSBError() {
  showModal({
    title: 'A WebUSB error occurred',
    content: m(
        'div',
        m('span', `Is adb already running on the host? Run this command and
      try again.`),
        m('br'),
        m('.modal-bash', '> adb kill-server'),
        m('br'),
        m('span', 'For details see '),
        m('a', {href: 'http://b/159048331', target: '_blank'}, 'b/159048331'),
        ),
    buttons: []
  });
}

function showRpcSequencingError() {
  showModal({
    title: 'A TraceProcessor RPC error occurred',
    content: m(
        'div',
        m('p', 'The trace processor RPC sequence ID was broken'),
        m('p', `This can happen when using a HTTP trace processor instance and
either accidentally sharing this between multiple tabs or
restarting the trace processor while still in use by UI.`),
        m('p', `Please refresh this tab and ensure that trace processor is used
at most one tab at a time.`),
        ),
    buttons: []
  });
}
