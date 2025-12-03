/**
 * SubMaker xSync - Content Script
 * Handles communication between the SubMaker sync page and the extension background worker
 */

console.log('[SubMaker xSync] Content script loaded');

// State management
let extensionReady = false;
const pendingExtractResults = new Map();

function translate(key, fallback) {
  try {
    if (typeof window !== 'undefined' && typeof window.t === 'function') {
      return window.t(key, {}, fallback || key);
    }
  } catch (_) {}
  try {
    if (typeof chrome !== 'undefined' && chrome.i18n?.getMessage) {
      const chromeKey = String(key || '').replace(/[^a-zA-Z0-9_]/g, '_');
      const msg = chrome.i18n.getMessage(chromeKey);
      if (msg) return msg;
    }
  } catch (_) {}
  return fallback || key;
}

function normalizeHost(hostname) {
  return hostname ? hostname.trim().toLowerCase() : null;
}

function safeHostname(url) {
  try {
    return new URL(url).hostname;
  } catch (_) {
    return null;
  }
}

function extractConfigToken(fromUrl) {
  if (!fromUrl) return null;
  try {
    const url = new URL(fromUrl);
    const paramToken = url.searchParams.get('config');
    if (paramToken) return paramToken;

    const parts = url.pathname.split('/').filter(Boolean);
    const configureIdx = parts.findIndex(p => p.toLowerCase() === 'configure');
    if (configureIdx !== -1 && parts.length > configureIdx + 1) {
      return parts[configureIdx + 1];
    }
    const toolboxIdx = parts.findIndex(p => p.toLowerCase() === 'sub-toolbox');
    if (toolboxIdx !== -1 && parts.length > toolboxIdx + 1) {
      return parts[toolboxIdx + 1];
    }
    return null;
  } catch (_) {
    return null;
  }
}

function deriveConfigureUrl(fromUrl, tokenOverride) {
  try {
    const url = new URL(fromUrl);
    const config = tokenOverride || extractConfigToken(fromUrl);
    const suffix = config ? `?config=${encodeURIComponent(config)}` : '';
    return `${url.origin}/configure${suffix}`;
  } catch (_) {
    return null;
  }
}

function deriveToolboxUrl(fromUrl, tokenOverride) {
  try {
    const url = new URL(fromUrl);
    const config = tokenOverride || extractConfigToken(fromUrl);
    const suffix = config ? `?config=${encodeURIComponent(config)}` : '';
    return `${url.origin}/sub-toolbox${suffix}`;
  } catch (_) {
    return null;
  }
}

function clearPendingExtract(messageId) {
  const timer = pendingExtractResults.get(messageId);
  if (timer) clearTimeout(timer);
  pendingExtractResults.delete(messageId);
}

function schedulePendingExtractFailure(messageId, errorMsg) {
  if (!messageId) return;
  clearPendingExtract(messageId);
  const timer = setTimeout(() => {
    pendingExtractResults.delete(messageId);
    sendToPage({
      type: 'SUBMAKER_EXTRACT_RESPONSE',
      messageId,
      source: 'extension',
      success: false,
      error: errorMsg || translate('xsync.content.extractFailed', 'Extraction failed')
    });
  }, 8000);
  pendingExtractResults.set(messageId, timer);
}

function isTransientPortError(err) {
  const msg = (err?.message || err || '').toLowerCase();
  return msg.includes('message port closed') || msg.includes('receiving end does not exist');
}

function normalizeExtractModeValue(mode) {
  const cleaned = String(mode || '')
    .trim()
    .toLowerCase()
    .replace(/[-_\s]*v2$/, '')      // strip legacy -v2/_v2 suffix
    .replace(/[-_\s]+/g, '-');      // align separators for comparisons
  if (cleaned === 'complete' || cleaned === 'full' || cleaned === 'fullfetch') return 'complete';
  if (cleaned === 'smart') return 'smart';
  return 'smart';
}

// Forward progress events from the background worker to the web page
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'SYNC_PROGRESS') {
    sendToPage({
      type: 'SUBMAKER_SYNC_PROGRESS',
      source: 'extension',
      messageId: msg.messageId,
      progress: msg.progress,
      status: msg.status
    });
  } else if (msg?.type === 'EXTRACT_PROGRESS') {
    sendToPage({
      type: 'SUBMAKER_EXTRACT_PROGRESS',
      source: 'extension',
      messageId: msg.messageId,
      progress: msg.progress,
      status: msg.status
    });
  } else if (msg?.type === 'SUBMAKER_DEBUG_LOG') {
    console[msg.level === 'error' ? 'error' : msg.level === 'warn' ? 'warn' : 'log']('[SubMaker xSync][Debug]', msg.text || '', msg.messageId ? `(job ${msg.messageId})` : '');
    sendToPage({
      type: 'SUBMAKER_DEBUG_LOG',
      source: 'extension',
      messageId: msg.messageId,
      level: msg.level || 'info',
      text: msg.text || '',
      ts: msg.ts || Date.now()
    });
  } else if (msg?.type === 'EXTRACT_RESPONSE') {
    clearPendingExtract(msg.messageId);
    sendToPage({
      type: 'SUBMAKER_EXTRACT_RESPONSE',
      source: 'extension',
      messageId: msg.messageId,
      success: msg.success,
      tracks: msg.tracks || [],
      error: msg.error || null
    });
  }
});

// Initialize extension
(async function init() {
  try {
    // Detect whether we're on any SubMaker tool page; keep listening even if the
    // path is unexpected (e.g., cache-busted or legacy slug) so PING/PONG still works.
    const locationString = [
      window.location.pathname || '',
      window.location.search || '',
      window.location.hash || ''
    ].join(' ').toLowerCase();
    const isSupportedPage = [
      '/subtitle-sync',
      '/sync-subtitles', // legacy/addon slug
      '/embedded-subtitles',
      '/auto-subtitles',
      '/sub-toolbox',
      '/configure'
    ].some(fragment => locationString.includes(fragment));

    if (isSupportedPage) {
      console.log('[SubMaker xSync] Detected supported page, initializing...');

      // Save known URLs for the popup to use
      try {
        const currentUrl = window.location.href;
        const isConfigurePage = locationString.includes('/configure');
        const isToolboxPage = locationString.includes('/sub-toolbox');
        const isSyncPage = locationString.includes('/subtitle-sync') || locationString.includes('/sync-subtitles');
        const existing = await chrome.storage.local.get(['toolboxUrl', 'configureUrl', 'syncUrl', 'recognizedHost']);
        const storageUpdates = {};

        const currentHost = normalizeHost(safeHostname(currentUrl));
        const storedHost = normalizeHost(existing.recognizedHost) ||
          normalizeHost(safeHostname(existing.configureUrl)) ||
          normalizeHost(safeHostname(existing.toolboxUrl)) ||
          normalizeHost(safeHostname(existing.syncUrl));
        let recognizedHost = storedHost;

        if (!existing.recognizedHost && storedHost) {
          storageUpdates.recognizedHost = storedHost;
        }
        if (!recognizedHost && currentHost) {
          recognizedHost = currentHost;
          storageUpdates.recognizedHost = currentHost;
        }

        const hostMatches = !recognizedHost || !currentHost || recognizedHost === currentHost;

        if (!hostMatches) {
          console.warn('[SubMaker xSync] Skipping URL capture due to host mismatch', {
            recognizedHost,
            currentHost
          });
        } else {
          const currentToken = extractConfigToken(currentUrl);
          const storedToken = extractConfigToken(existing.configureUrl) || extractConfigToken(existing.toolboxUrl);
          const tokenChanged = isConfigurePage && currentToken && storedToken && currentToken !== storedToken;
          const hasFreshToken = isConfigurePage && currentToken && !storedToken;

          if (isConfigurePage) {
            const normalizedConfigure = deriveConfigureUrl(currentUrl, currentToken) || currentUrl;
            if (!existing.configureUrl || tokenChanged || hasFreshToken) {
              storageUpdates.configureUrl = normalizedConfigure;
            }

            const derivedToolboxFromConfig = deriveToolboxUrl(currentUrl, currentToken);
            if (derivedToolboxFromConfig && (!existing.toolboxUrl || tokenChanged || hasFreshToken)) {
              storageUpdates.toolboxUrl = derivedToolboxFromConfig;
            }
          } else {
            if (isToolboxPage && !existing.toolboxUrl) {
              storageUpdates.toolboxUrl = currentUrl;
            }
            if (!existing.toolboxUrl && !storageUpdates.toolboxUrl) {
              const derivedToolbox = deriveToolboxUrl(currentUrl, currentToken);
              if (derivedToolbox) {
                storageUpdates.toolboxUrl = derivedToolbox;
              }
            }
            if (!existing.configureUrl && !storageUpdates.configureUrl) {
              const derivedConfigure = deriveConfigureUrl(currentUrl, currentToken);
              if (derivedConfigure) {
                storageUpdates.configureUrl = derivedConfigure;
              }
            }
          }

          if (isSyncPage && !existing.syncUrl) {
            storageUpdates.syncUrl = currentUrl;
          }
        }

        if (Object.keys(storageUpdates).length > 0) {
          chrome.storage.local.set(storageUpdates);
          console.log('[SubMaker xSync] Updated known URLs:', Object.keys(storageUpdates));
        }
      } catch (e) {
        console.warn('[SubMaker xSync] Failed to save page URL', e);
      }
    } else {
      console.log('[SubMaker xSync] Page not recognized as a SubMaker tool; staying idle but listening for pings.');
    }

    // Wait for page to be fully loaded
    if (document.readyState === 'loading') {
      await new Promise(resolve => {
        document.addEventListener('DOMContentLoaded', resolve);
      });
    }

    extensionReady = true;
    console.log('[SubMaker xSync] Extension ready');

    // Start listening for messages from the page
    window.addEventListener('message', handlePageMessage);

    // Announce presence to page (only on recognized SubMaker routes)
    if (isSupportedPage) {
      setTimeout(() => {
        console.log('[SubMaker xSync] Waiting for PING from webpage...');
        sendToPage({
          type: 'SUBMAKER_PONG',
          source: 'extension',
          version: chrome.runtime.getManifest().version
        });
      }, 100);
    }

  } catch (error) {
    console.error('[SubMaker xSync] Initialization error:', error);
  }
})();

/**
 * Handle messages from the webpage
 */
async function handlePageMessage(event) {
  // Only accept messages from same origin
  if (event.source !== window) {
    return;
  }

  const message = event.data;

  // Only process explicit SubMaker webpage messages; ignore stray postMessage noise (e.g. numeric events)
  const fromWebpage = message?.source === 'webpage';
  const isSubmakerMessage = typeof message?.type === 'string' && message.type.startsWith('SUBMAKER_');
  if (!fromWebpage || !isSubmakerMessage) {
    return;
  }

  console.log('[SubMaker xSync] Received message from webpage:', message.type);

  try {
    switch (message.type) {
      case 'SUBMAKER_PING':
        await handlePing(message);
        break;

      case 'SUBMAKER_SYNC_REQUEST':
        await handleSyncRequest(message);
        break;

      case 'SUBMAKER_EXTRACT_REQUEST':
        await handleExtractRequest(message);
        break;

      case 'SUBMAKER_EMBEDDED_RESET':
        await handleEmbeddedReset(message);
        break;

      default:
        console.log('[SubMaker xSync] Unknown message type:', message.type);
    }
  } catch (error) {
    console.error('[SubMaker xSync] Error handling message:', error);

    // Send error response if it's a sync request
    if (message.type === 'SUBMAKER_SYNC_REQUEST') {
      sendToPage({
        type: 'SUBMAKER_SYNC_RESPONSE',
        messageId: message.messageId,
        source: 'extension',
        success: false,
        error: error.message || 'Unknown error occurred'
      });
    }
    if (message.type === 'SUBMAKER_EXTRACT_REQUEST') {
      sendToPage({
        type: 'SUBMAKER_EXTRACT_RESPONSE',
        messageId: message.messageId,
        source: 'extension',
        success: false,
        error: error.message || 'Unknown error occurred'
      });
    }
  }
}

/**
 * Handle PING from webpage (extension detection)
 */
async function handlePing(message) {
  console.log('[SubMaker xSync] Received PING, sending PONG...');

  sendToPage({
    type: 'SUBMAKER_PONG',
    source: 'extension',
    version: chrome.runtime.getManifest().version
  });
}

/**
 * Handle sync request from webpage
 */
async function handleSyncRequest(message) {
  console.log('[SubMaker xSync] Sync request received:', {
    messageId: message.messageId,
    hasStreamUrl: !!message.data?.streamUrl,
    hasSubtitle: !!message.data?.subtitleContent
  });

  const { streamUrl, subtitleContent, mode, plan, preferAlass, preferFfsubsync, preferCtc } = message.data || {};
  const normalizedMode = plan?.preset || mode || 'smart';
  const pageHeaders = {
    referer: window.location.href || null,
    cookie: document?.cookie || null,
    userAgent: navigator?.userAgent || null
  };

  // Validate request
  if (!streamUrl || !subtitleContent) {
    throw new Error('Missing streamUrl or subtitleContent in sync request');
  }

  // Send initial progress update
  sendProgressUpdate(message.messageId, 0, 'Initializing sync process...');

  try {
    // Forward request to background worker
    console.log('[SubMaker xSync] Forwarding to background worker...');

    const response = await sendRuntimeMessage({
      type: 'SYNC_REQUEST',
      messageId: message.messageId,
      streamUrl: streamUrl,
      subtitleContent: subtitleContent,
      mode: normalizedMode,
      plan: plan || null,
      preferAlass: preferAlass === true,
      preferFfsubsync: preferFfsubsync === true,
      preferCtc: preferCtc === true,
      pageHeaders
    });

    console.log('[SubMaker xSync] Received response from background:', {
      success: response.success,
      hasResult: !!response.syncedSubtitle
    });

    // Forward response to webpage
    sendToPage({
      type: 'SUBMAKER_SYNC_RESPONSE',
      messageId: message.messageId,
      source: 'extension',
      success: response.success,
      syncedSubtitle: response.syncedSubtitle || null,
      error: response.error || null
    });

  } catch (error) {
    console.error('[SubMaker xSync] Sync request failed:', error);

    sendToPage({
      type: 'SUBMAKER_SYNC_RESPONSE',
      messageId: message.messageId,
      source: 'extension',
      success: false,
      error: error.message || 'Extension communication failed'
    });
  }
}

/**
 * Handle embedded subtitle extraction request from webpage
 */
async function handleExtractRequest(message) {
  console.log('[SubMaker xSync] Extract request received:', {
    messageId: message.messageId,
    hasStreamUrl: !!message.data?.streamUrl
  });

  const { streamUrl, filename, videoHash, mode } = message.data || {};
  const normalizedMode = normalizeExtractModeValue(mode);
  const pageHeaders = {
    referer: window.location.href || null,
    cookie: document?.cookie || null,
    userAgent: navigator?.userAgent || null
  };

  if (!streamUrl) {
    throw new Error('Missing streamUrl in extract request');
  }
  if (!/^https?:\/\//i.test(streamUrl)) {
    throw new Error('Only http(s) stream URLs are supported');
  }

  sendExtractProgress(message.messageId, 2, 'Starting extraction...');

  try {
    console.log('[SubMaker xSync] Sending EXTRACT_SUBS_REQUEST to background...');
    const response = await sendRuntimeMessage({
      type: 'EXTRACT_SUBS_REQUEST',
      messageId: message.messageId,
      streamUrl,
      filename,
      videoHash,
      mode: normalizedMode,
      pageHeaders
    });

    console.log('[SubMaker xSync] Received response from background:', {
      success: response.success,
      trackCount: response.tracks?.length,
      error: response.error
    });

    clearPendingExtract(message.messageId);
    sendToPage({
      type: 'SUBMAKER_EXTRACT_RESPONSE',
      messageId: message.messageId,
      source: 'extension',
      success: response.success,
      tracks: response.tracks || [],
      error: response.error || null
    });
  } catch (error) {
    console.error('[SubMaker xSync] Extract request failed:', error);
    console.error('[SubMaker xSync] Error details:', {
      message: error.message,
      stack: error.stack
    });
    const errorMsg = error.message || translate('xsync.content.extractFailed', 'Extraction failed');
    if (isTransientPortError(error)) {
      schedulePendingExtractFailure(message.messageId, errorMsg);
      return;
    }
    clearPendingExtract(message.messageId);
    sendToPage({
      type: 'SUBMAKER_EXTRACT_RESPONSE',
      messageId: message.messageId,
      source: 'extension',
      success: false,
      error: errorMsg
    });
  }
}

/**
 * Handle cleanup/reset from embedded subtitles page (e.g., refresh/unload)
 */
async function handleEmbeddedReset(message) {
  console.log('[SubMaker xSync] Embedded page requested cleanup:', message?.reason || 'unknown');
  try {
    await sendRuntimeMessage({
      type: 'RESET_EMBEDDED_PAGE',
      reason: message?.reason || 'page-reset'
    }, 'reset-embedded');
  } catch (error) {
    console.warn('[SubMaker xSync] Failed to forward reset to background:', error?.message || error);
  }
}

/**
 * Send progress update to webpage
 */
function sendProgressUpdate(messageId, progress, status) {
  sendToPage({
    type: 'SUBMAKER_SYNC_PROGRESS',
    messageId: messageId,
    source: 'extension',
    progress: progress,
    status: status
  });
}

/**
 * Send extraction progress update to webpage
 */
function sendExtractProgress(messageId, progress, status) {
  sendToPage({
    type: 'SUBMAKER_EXTRACT_PROGRESS',
    messageId,
    source: 'extension',
    progress,
    status
  });
}

/**
 * Send message to webpage
 */
function sendToPage(message) {
  window.postMessage(message, '*');
}

/**
 * Wrapper around chrome.runtime.sendMessage with detailed logging
 */
function sendRuntimeMessage(payload, debugLabel = 'runtime-message') {
  const attemptSend = (retry = false) => new Promise((resolve, reject) => {
    const startedAt = Date.now();
    chrome.runtime.sendMessage(payload, (response) => {
      const duration = Date.now() - startedAt;
      const lastErr = chrome.runtime.lastError;
      if (lastErr) {
        const msg = lastErr.message || 'Unknown sendMessage error';
        console.error(`[SubMaker xSync] sendMessage error (${debugLabel}) after ${duration}ms:`, msg);
        sendToPage({
          type: 'SUBMAKER_DEBUG_LOG',
          source: 'extension',
          messageId: payload?.messageId,
          level: 'error',
          text: `Runtime message failed (${debugLabel}): ${msg}`,
          ts: Date.now()
        });
        const shouldRetry = !retry && /message port closed|receiving end does not exist/i.test(msg);
        if (shouldRetry) {
          // Retry once after a brief delay to give the service worker time to wake up
          setTimeout(() => {
            attemptSend(true).then(resolve).catch(reject);
          }, 200);
          return;
        }
        reject(new Error(msg));
        return;
      }
      console.log(`[SubMaker xSync] sendMessage success (${debugLabel}) after ${duration}ms`, {
        hasResponse: typeof response !== 'undefined',
        success: response?.success,
        messageId: payload?.messageId
      });
      resolve(response);
    });
  });

  return attemptSend(false);
}

console.log('[SubMaker xSync] Content script initialized');
