'use strict';
/**
 * SubMaker xSync - IndexedDB Transfer Helper
 * Allows transferring large ArrayBuffers between Background and Offscreen contexts
 * by bypassing the chrome.runtime messaging size limits.
 */

const DB_NAME = 'SubMakerTransferDB';
const STORE_NAME = 'transfers';
const DB_VERSION = 1;

function openTransferDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (evt) => {
      const db = evt.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Save an ArrayBuffer to IDB and return a transfer ID
 * @param {string} id - Unique transfer ID
 * @param {ArrayBuffer|Uint8Array} buffer - Data to save
 * @returns {Promise<void>}
 */
async function saveTransferBuffer(id, buffer) {
  const db = await openTransferDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    // Ensure we store as ArrayBuffer or Blob to be efficient
    const data = buffer instanceof Uint8Array ? buffer.buffer : buffer;
    const req = store.put(data, id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

/**
 * Load an ArrayBuffer from IDB
 * @param {string} id - Transfer ID
 * @returns {Promise<ArrayBuffer>}
 */
async function loadTransferBuffer(id) {
  const db = await openTransferDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(id);
    req.onsuccess = () => {
      if (req.result) {
        resolve(req.result);
      } else {
        reject(new Error(`Transfer buffer not found: ${id}`));
      }
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

/**
 * Delete a transfer buffer from IDB
 * @param {string} id - Transfer ID
 * @returns {Promise<void>}
 */
async function deleteTransferBuffer(id) {
  const db = await openTransferDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

// Export for ES modules (if used) or global scope
if (typeof self !== 'undefined') {
  self.SubMakerTransfer = {
    saveTransferBuffer,
    loadTransferBuffer,
    deleteTransferBuffer
  };
}
