const fs = require('node:fs');
const zlib = require('node:zlib');
const config = require('../config');
const { getDb, closeDb, initDatabase } = require('../db/database');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ikpumjioqkssnbrplgph.supabase.co';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlrcHVtamlvcWtzc25icnBsZ3BoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM0OTcyNzIsImV4cCI6MjA4OTA3MzI3Mn0.PD-yDElsmaZ2l9RynXYUxO_Cw65-PT0f16jpNEXiJN0';
const SYNC_SECRET = process.env.IHQA_SYNC_KEY || 'ihqa-kerala-sync-2026-secret';

let localVersion = 0;
let lastCheckAt = 0;
let syncQueue = Promise.resolve();

function withSyncLock(fn) {
  const next = syncQueue.then(fn, fn);
  syncQueue = next.catch(() => {});
  return next;
}

function isSyncEnabled() {
  if (
    process.env.NODE_ENV === 'test' ||
    process.env.DISABLE_CLOUD_SYNC === 'true' ||
    process.execArgv.includes('--test')
  ) {
    return false;
  }
  if (!config.dbPath || config.dbPath === ':memory:') return false;
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

function supabaseHeaders(extra = {}) {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    'x-ihqa-sync-key': SYNC_SECRET,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function fetchRemoteMeta() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/ihqa_cloud_state?id=eq.main&select=version`, {
    method: 'GET',
    headers: supabaseHeaders(),
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) {
    throw new Error(`Supabase meta check failed: ${res.status}`);
  }
  const rows = await res.json();
  return rows[0] || null;
}

async function fetchRemoteSnapshot() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/ihqa_cloud_state?id=eq.main&select=version,db_gzip_base64`,
    {
      method: 'GET',
      headers: supabaseHeaders(),
      signal: AbortSignal.timeout(6000),
    }
  );
  if (!res.ok) {
    throw new Error(`Supabase snapshot pull failed: ${res.status}`);
  }
  const rows = await res.json();
  return rows[0] || null;
}

async function pullIfNewer(force = false, minAgeMs = 15000) {
  if (!isSyncEnabled()) return { pulled: false, disabled: true };

  const now = Date.now();
  if (!force && now - lastCheckAt < minAgeMs) {
    return { pulled: false, throttled: true };
  }
  if (force && now - lastCheckAt < 3000) {
    return { pulled: false, throttled: true };
  }

  return withSyncLock(async () => {
    const innerNow = Date.now();
    if (!force && innerNow - lastCheckAt < minAgeMs) {
      return { pulled: false, throttled: true };
    }
    if (force && innerNow - lastCheckAt < 3000) {
      return { pulled: false, throttled: true };
    }

    lastCheckAt = innerNow;
    const meta = await fetchRemoteMeta();
    if (!meta) {
      return { pulled: false, emptyRemote: true };
    }
    const remoteVersion = Number(meta.version || 0);
    if (remoteVersion <= localVersion && fs.existsSync(config.dbPath)) {
      return { pulled: false, upToDate: true, version: localVersion };
    }

    const full = await fetchRemoteSnapshot();
    if (!full || !full.db_gzip_base64) {
      return { pulled: false, emptyRemote: true };
    }

    const gzBuffer = Buffer.from(full.db_gzip_base64, 'base64');
    const dbBuffer = zlib.gunzipSync(gzBuffer);
    if (!dbBuffer || dbBuffer.length < 4096) {
      throw new Error('Invalid remote snapshot buffer');
    }

    const tmpIncoming = `${config.dbPath}.incoming`;
    fs.writeFileSync(tmpIncoming, dbBuffer);

    closeDb();
    for (const suffix of ['-wal', '-shm']) {
      const walPath = `${config.dbPath}${suffix}`;
      if (fs.existsSync(walPath)) {
        try {
          fs.unlinkSync(walPath);
        } catch (_) {}
      }
    }
    fs.renameSync(tmpIncoming, config.dbPath);
    initDatabase(config.dbPath);

    localVersion = Number(full.version || remoteVersion);
    return { pulled: true, version: localVersion };
  });
}

async function pushSnapshot(updatedBy = 'system') {
  if (!isSyncEnabled()) return { pushed: false, disabled: true };

  return withSyncLock(async () => {
    const db = getDb();
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch (_) {}

    const rawBuffer = fs.readFileSync(config.dbPath);
    const gzBase64 = zlib.gzipSync(rawBuffer, { level: 1 }).toString('base64');
    const nextVersion = Math.max(localVersion + 1, Date.now());

    const res = await fetch(`${SUPABASE_URL}/rest/v1/ihqa_cloud_state`, {
      method: 'POST',
      headers: supabaseHeaders({
        Prefer: 'resolution=merge-duplicates,return=minimal',
      }),
      body: JSON.stringify({
        id: 'main',
        version: nextVersion,
        db_gzip_base64: gzBase64,
        updated_at: new Date().toISOString(),
        updated_by: String(updatedBy).slice(0, 100),
      }),
      signal: AbortSignal.timeout(6000),
    });

    if (!res.ok) {
      throw new Error(`Supabase push failed: ${res.status}`);
    }

    localVersion = nextVersion;
    lastCheckAt = Date.now();
    return { pushed: true, version: localVersion };
  });
}

async function initCloudSync() {
  if (!isSyncEnabled()) return { enabled: false };
  try {
    const pullRes = await pullIfNewer(true);
    if (pullRes.emptyRemote) {
      await pushSnapshot('initial_seed');
      return { enabled: true, action: 'pushed_initial', version: localVersion };
    }
    return { enabled: true, action: pullRes.pulled ? 'pulled' : 'up_to_date', version: localVersion };
  } catch (err) {
    console.warn('Cloud sync initialization warning:', err.message);
    return { enabled: false, error: err.message };
  }
}

module.exports = {
  isSyncEnabled,
  pullIfNewer,
  pushSnapshot,
  initCloudSync,
};
