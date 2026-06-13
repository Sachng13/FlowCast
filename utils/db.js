/**
 * FlowCast — IndexedDB Utility
 * 
 * Provides a clean async API for storing and retrieving recordings.
 * Shared between the Offscreen Document (writes) and the Preview Page (reads).
 * 
 * Schema:
 *   recordings: { id, timestamp, duration, settings, transcript, blob, thumbnailBlob }
 */

const FlowCastDB = (() => {
  const DB_NAME = 'flowcast_recordings';
  const DB_VERSION = 1;
  const STORE_NAME = 'recordings';

  /**
   * Opens (or creates) the IndexedDB database.
   * @returns {Promise<IDBDatabase>}
   */
  function open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Saves a recording object to IndexedDB.
   * @param {Object} recording — Must include `id` (string), `blob` (Blob), and metadata.
   * @returns {Promise<void>}
   */
  async function saveRecording(recording) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(recording);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  }

  /**
   * Retrieves a single recording by ID.
   * @param {string} id
   * @returns {Promise<Object|null>}
   */
  async function getRecording(id) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).get(id);
      request.onsuccess = () => { db.close(); resolve(request.result || null); };
      request.onerror = () => { db.close(); reject(request.error); };
    });
  }

  /**
   * Returns all recordings sorted by timestamp (newest first).
   * @returns {Promise<Object[]>}
   */
  async function getAllRecordings() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).getAll();
      request.onsuccess = () => {
        db.close();
        const results = request.result || [];
        results.sort((a, b) => b.timestamp - a.timestamp);
        resolve(results);
      };
      request.onerror = () => { db.close(); reject(request.error); };
    });
  }

  /**
   * Returns the most recent recording.
   * @returns {Promise<Object|null>}
   */
  async function getLatestRecording() {
    const all = await getAllRecordings();
    return all.length > 0 ? all[0] : null;
  }

  /**
   * Deletes a recording by ID.
   * @param {string} id
   * @returns {Promise<void>}
   */
  async function deleteRecording(id) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  }

  // Public API
  return { open, saveRecording, getRecording, getAllRecordings, getLatestRecording, deleteRecording };
})();
