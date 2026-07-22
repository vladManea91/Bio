/**
 * One place to read and write JSON. Uses Netlify Blobs when it is available
 * and falls back to /tmp so `node tests/...` and local runs still work.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

let blobsModule;
async function loadBlobs() {
  if (blobsModule !== undefined) return blobsModule;
  try {
    blobsModule = await import('@netlify/blobs');
  } catch {
    blobsModule = null;
  }
  return blobsModule;
}

const FALLBACK_DIR = path.join(os.tmpdir(), 'receipts-store');

export async function openStore(name) {
  const blobs = await loadBlobs();
  let store = null;
  if (blobs && (process.env.NETLIFY || process.env.NETLIFY_BLOBS_CONTEXT)) {
    try {
      store = blobs.getStore({ name, consistency: 'strong' });
    } catch {
      store = null;
    }
  }

  const filePath = (key) => path.join(FALLBACK_DIR, name, `${key.replace(/[^\w.-]/g, '_')}.json`);

  return {
    backend: store ? 'blobs' : 'tmp',

    async get(key, fallback = null) {
      if (store) {
        try {
          const value = await store.get(key, { type: 'json' });
          return value ?? fallback;
        } catch {
          return fallback;
        }
      }
      try {
        return JSON.parse(await fs.readFile(filePath(key), 'utf8'));
      } catch {
        return fallback;
      }
    },

    async set(key, value) {
      if (store) {
        await store.setJSON(key, value);
        return;
      }
      await fs.mkdir(path.dirname(filePath(key)), { recursive: true });
      await fs.writeFile(filePath(key), JSON.stringify(value));
    },

    async delete(key) {
      if (store) {
        try { await store.delete(key); } catch { /* already gone */ }
        return;
      }
      try { await fs.unlink(filePath(key)); } catch { /* already gone */ }
    }
  };
}
