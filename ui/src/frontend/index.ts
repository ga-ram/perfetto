// Copyright (C) 2018 The Android Open Source Project
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

import {Patch, produce} from 'immer';
import * as m from 'mithril';

import {defer} from '../base/deferred';
import {assertExists, reportError, setErrorHandler} from '../base/logging';
import {Actions, DeferredAction, StateActions} from '../common/actions';
import {initializeImmerJs} from '../common/immer_init';
import {createEmptyState, State} from '../common/state';
import {initWasm} from '../common/wasm_engine_proxy';
import {ControllerWorkerInitMessage} from '../common/worker_messages';
import {
  isGetCategoriesResponse
} from '../controller/chrome_proxy_record_controller';
import {initController} from '../controller/index';

import {initCssConstants} from './css_constants';
import {maybeShowErrorDialog} from './error_dialog';
import {globals} from './globals';
import {HomePage} from './home_page';
import {Router} from './router';
import {maybeOpenTraceFromRoute} from './trace_url_handler';
import {ViewerPage} from './viewer_page';

const EXTENSION_ID = 'lfmkphfpdbjijhpomgecfikhfohaoine';

class FrontendApi {
  private port: MessagePort;
  private state: State;

  constructor(port: MessagePort) {
    this.state = createEmptyState();
    this.port = port;
  }

  dispatchMultiple(actions: DeferredAction[]) {
    const oldState = this.state;
    const patches: Patch[] = [];
    for (const action of actions) {
      const originalLength = patches.length;
      const morePatches = this.applyAction(action);
      patches.length += morePatches.length;
      for (let i = 0; i < morePatches.length; ++i) {
        patches[i + originalLength] = morePatches[i];
      }
    }

    if (this.state === oldState) {
      return;
    }

    // Update overall state.
    globals.state = this.state;

    // If the visible time in the global state has been updated more recently
    // than the visible time handled by the frontend @ 60fps, update it. This
    // typically happens when restoring the state from a permalink.
    globals.frontendLocalState.mergeState(this.state.frontendLocalState);

    // Only redraw if something other than the frontendLocalState changed.
    for (const key in this.state) {
      if (key !== 'frontendLocalState' && key !== 'visibleTracks' &&
          oldState[key] !== this.state[key]) {
        globals.rafScheduler.scheduleFullRedraw();
        break;
      }
    }

    if (patches.length > 0) {
      this.port.postMessage(patches);
    }
  }

  private applyAction(action: DeferredAction): Patch[] {
    const patches: Patch[] = [];

    // 'produce' creates a immer proxy which wraps the current state turning
    // all imperative mutations of the state done in the callback into
    // immutable changes to the returned state.
    this.state = produce(
        this.state,
        draft => {
          // tslint:disable-next-line no-any
          (StateActions as any)[action.type](draft, action.args);
        },
        (morePatches, _) => {
          const originalLength = patches.length;
          patches.length += morePatches.length;
          for (let i = 0; i < morePatches.length; ++i) {
            patches[i + originalLength] = morePatches[i];
          }
        });
    return patches;
  }

}

function setExtensionAvailability(available: boolean) {
  globals.dispatch(Actions.setExtensionAvailable({
    available,
  }));
}

function main() {
  const dataSource = document.getElementById('timeline_data_source');
  const mainDiv = document.getElementById('timeline_main');

  if (!dataSource || !mainDiv) {
    console.log('Necessary components \'timeline_data_source \' and \'timeline_main\' are not found.');
    return;
  }

  // Load the css. The load is asynchronous and the CSS is not ready by the time
  // appenChild returns.
  const cssLoadPromise = defer<void>();
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = globals.root + 'perfetto.css';
  css.onload = () => cssLoadPromise.resolve();
  css.onerror = (err) => cssLoadPromise.reject(err);
  document.head.append(css);

  // Add Error handlers for JS error and for uncaught exceptions in promises.
  setErrorHandler((err: string) => maybeShowErrorDialog(err));
  window.addEventListener('error', e => reportError(e));
  window.addEventListener('unhandledrejection', e => reportError(e));

  const controllerChannel = new MessageChannel();
  const extensionLocalChannel = new MessageChannel();
  const errorReportingChannel = new MessageChannel();

  errorReportingChannel.port2.onmessage = (e) =>
      maybeShowErrorDialog(`${e.data}`);

  const msg: ControllerWorkerInitMessage = {
    controllerPort: controllerChannel.port1,
    extensionPort: extensionLocalChannel.port1,
    errorReportingPort: errorReportingChannel.port1,
  };

  initWasm(globals.root);
  initializeImmerJs();

  initController(msg);

  const dispatch = (action: DeferredAction) => {
    frontendApi.dispatchMultiple([action]);
  };

  const router = new Router({
    '/': HomePage,
    '/viewer': ViewerPage,
  });
  router.onRouteChanged = (route) => {
    globals.rafScheduler.scheduleFullRedraw();
    maybeOpenTraceFromRoute(route);
  };
  globals.initialize(dispatch, router);
  globals.serviceWorkerController.install();

  const frontendApi = new FrontendApi(controllerChannel.port2);
  globals.publishRedraw = () => globals.rafScheduler.scheduleFullRedraw();

  // We proxy messages between the extension and the controller because the
  // controller's worker can't access chrome.runtime.
  const extensionPort = window.chrome && chrome.runtime ?
      chrome.runtime.connect(EXTENSION_ID) :
      undefined;

  setExtensionAvailability(extensionPort !== undefined);

  if (extensionPort) {
    extensionPort.onDisconnect.addListener(_ => {
      setExtensionAvailability(false);
      // tslint:disable-next-line: no-unused-expression
      void chrome.runtime.lastError;  // Needed to not receive an error log.
    });
    // This forwards the messages from the extension to the controller.
    extensionPort.onMessage.addListener(
        (message: object, _port: chrome.runtime.Port) => {
          if (isGetCategoriesResponse(message)) {
            globals.dispatch(Actions.setChromeCategories(message));
            return;
          }
          extensionLocalChannel.port2.postMessage(message);
        });
  }

  // This forwards the messages from the controller to the extension
  extensionLocalChannel.port2.onmessage = ({data}) => {
    if (extensionPort) extensionPort.postMessage(data);
  };

  // Put these variables in the global scope for better debugging.
  (window as {} as {m: {}}).m = m;
  (window as {} as {globals: {}}).globals = globals;
  (window as {} as {Actions: {}}).Actions = Actions;

  // Prevent pinch zoom.
  document.body.addEventListener('wheel', (e: MouseEvent) => {
    if (e.ctrlKey) e.preventDefault();
  }, {passive: false});

  const url = document.getElementById('timeline_data_source')!.innerHTML;
  cssLoadPromise.then(() => onCssLoaded(url));
  globals.state.route="/viewer";

}


function onCssLoaded(url: string) {
  initCssConstants();
  const main = assertExists(document.getElementById('timeline_main'));
  m.render(main, m(ViewerPage));

  globals.rafScheduler.domRedraw = () => {
    m.render(main, m(ViewerPage));
  };
  globals.logging.logEvent('Trace Actions', 'Open example trace');
  globals.dispatch(Actions.openTraceFromUrl({ url }));
}

main();
