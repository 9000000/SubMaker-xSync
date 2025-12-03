/**
 * SubMaker xSync - Lightweight background bootstrap
 * Keeps the popup fast while ensuring MV3 doesn't block late importScripts.
 */

// Flag for the full worker so it knows it was bootstrapped.
self.__xsyncBootstrapped = true;

// Eagerly load the heavy worker at startup so MV3 doesn't block late importScripts.
let _heavyLoaded = false;
let _heavyLoadError = null;
try {
  importScripts('background.full.js'); // registers __xsyncHandleMessage / __xsyncStatus
  _heavyLoaded = true;
} catch (err) {
  _heavyLoadError = err;
  console.error('[SubMaker xSync Bootstrap] Failed to preload heavy worker:', err);
}

function respondStatus(sendResponse) {
  try {
    const statusFn = self.__xsyncStatus;
    if (typeof statusFn === 'function') {
      const status = statusFn();
      sendResponse?.({
        active: status?.active || 0,
        extracting: status?.extracting || 0
      });
      return;
    }
  } catch (_) { /* ignore */ }
  sendResponse?.({ active: 0, extracting: 0 });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Fast path: respond to popup ping without loading the heavy worker.
  if (message?.type === 'GET_STATUS' && !_heavyLoaded) {
    respondStatus(sendResponse);
    return false; // synchronous response
  }

  if (!_heavyLoaded) {
    const errorMsg = _heavyLoadError?.message || 'xSync worker failed to preload';
    sendResponse?.({ success: false, error: errorMsg });
    return false;
  }

  try {
    const handler = self.__xsyncHandleMessage;
    if (typeof handler === 'function') {
      const keepAlive = handler(message, sender, sendResponse);
      if (keepAlive === true) return true; // handler will close the channel later
      return false; // synchronous or already responded
    }
    sendResponse?.({ success: false, error: 'xSync handler unavailable' });
  } catch (err) {
    sendResponse?.({ success: false, error: err?.message || 'xSync handler error' });
  }

  // Keep the message channel alive while the heavy worker loads and handles.
  return true;
});

console.log('[SubMaker xSync Bootstrap] Ready (heavy worker preloaded)');
