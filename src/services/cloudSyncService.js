const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const config = require('../config');
const { getDb, closeDb, initDatabase } = require('../db/database');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ikpumjioqkssnbrplgph.supabase.co';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlrcHVtamlvcWtzc25icnBsZ3BoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM0OTcyNzIsImV4cCI6MjA4OTA3MzI3Mn0.PD-yDElsmaZ2l9RynXYUxO_Cw65-PT0f16jpNEXiJN0';
const SYNC_SECRET = process.env.IHQA_SYNC_KEY || 'ihqa-kerala-sync-2026-secret';
const DEFAULT_FIREBASE_DATABASE_URL =
  'https://ihqa-call-management-default-rtdb.asia-southeast1.firebasedatabase.app';
const RTDB_NODE_PATH = 'ihqa_cloud_state/main';
const LOCAL_SERVICE_ACCOUNT_PATH = path.join(__dirname, '..', '..', 'firebase-service-account.json');

let localVersion = 0;
let lastCheckAt = 0;
let syncQueue = Promise.resolve();
let cachedAccessToken = null;
let cachedTokenExpiresAt = 0;

function withSyncLock(fn) {
  const next = syncQueue.then(fn, fn);
  syncQueue = next.catch(() => {});
  return next;
}

function getFirebaseServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON.trim();
    const parsed = JSON.parse(raw);
    if (parsed.private_key) {
      parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
    }
    return parsed;
  }

  if (
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    process.env.FIREBASE_PRIVATE_KEY
  ) {
    return {
      project_id: process.env.FIREBASE_PROJECT_ID,
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    };
  }

  if (fs.existsSync(LOCAL_SERVICE_ACCOUNT_PATH)) {
    const parsed = JSON.parse(fs.readFileSync(LOCAL_SERVICE_ACCOUNT_PATH, 'utf8'));
    if (parsed.private_key) {
      parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
    }
    return parsed;
  }

  return null;
}

function isFirebaseConfigured() {
  try {
    return Boolean(getFirebaseServiceAccount());
  } catch (_) {
    return false;
  }
}

async function getFirebaseAccessToken() {
  const now = Date.now();
  if (cachedAccessToken && now < cachedTokenExpiresAt) {
    return cachedAccessToken;
  }

  const sa = getFirebaseServiceAccount();
  if (!sa) return null;

  const iat = Math.floor(now / 1000);
  const exp = iat + 3600;
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claim = Buffer.from(
    JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
      aud: 'https://oauth2.googleapis.com/token',
      iat,
      exp,
    })
  ).toString('base64url');

  const unsigned = `${header}.${claim}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');
  const assertion = `${unsigned}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${encodeURIComponent(assertion)}`,
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) {
    throw new Error(`Firebase OAuth token failed: ${res.status}`);
  }
  const data = await res.json();
  cachedAccessToken = data.access_token;
  cachedTokenExpiresAt = Date.now() + Math.max(60, Number(data.expires_in || 3600) - 120) * 1000;
  return cachedAccessToken;
}

function getFirebaseDatabaseUrl() {
  return (process.env.FIREBASE_DATABASE_URL || DEFAULT_FIREBASE_DATABASE_URL).replace(/\/+$/, '');
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
  return isFirebaseConfigured() || Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
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

async function fetchSupabaseSnapshot() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/ihqa_cloud_state?id=eq.main&select=version,db_gzip_base64,updated_at,updated_by`,
    {
      method: 'GET',
      headers: supabaseHeaders(),
      signal: AbortSignal.timeout(5000),
    }
  );
  if (!res.ok) {
    throw new Error(`Supabase snapshot pull failed: ${res.status}`);
  }
  const rows = await res.json();
  return rows[0] || null;
}

async function fetchRemoteMeta() {
  if (isFirebaseConfigured()) {
    const token = await getFirebaseAccessToken();
    const res = await fetch(
      `${getFirebaseDatabaseUrl()}/${RTDB_NODE_PATH}/version.json?access_token=${encodeURIComponent(token)}`,
      { method: 'GET', signal: AbortSignal.timeout(2500) }
    );
    if (!res.ok) {
      throw new Error(`Firebase meta check failed: ${res.status}`);
    }
    const version = await res.json();
    if (version === null || version === undefined) return null;
    return { version };
  }

  const res = await fetch(`${SUPABASE_URL}/rest/v1/ihqa_cloud_state?id=eq.main&select=version`, {
    method: 'GET',
    headers: supabaseHeaders(),
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) {
    throw new Error(`Supabase meta check failed: ${res.status}`);
  }
  const rows = await res.json();
  return rows[0] || null;
}

async function fetchRemoteSnapshot() {
  if (isFirebaseConfigured()) {
    const token = await getFirebaseAccessToken();
    const res = await fetch(
      `${getFirebaseDatabaseUrl()}/${RTDB_NODE_PATH}.json?access_token=${encodeURIComponent(token)}`,
      { method: 'GET', signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) {
      throw new Error(`Firebase snapshot pull failed: ${res.status}`);
    }
    const data = await res.json();
    return data || null;
  }

  return fetchSupabaseSnapshot();
}

async function pullIfNewer(force = false, minAgeMs = 30000) {
  if (!isSyncEnabled()) return { pulled: false, disabled: true };

  const now = Date.now();
  if (!force && now - lastCheckAt < minAgeMs) {
    return { pulled: false, throttled: true };
  }
  if (force && now - lastCheckAt < 1000) {
    return { pulled: false, throttled: true };
  }

  return withSyncLock(async () => {
    const innerNow = Date.now();
    if (!force && innerNow - lastCheckAt < minAgeMs) {
      return { pulled: false, throttled: true };
    }
    if (force && innerNow - lastCheckAt < 1000) {
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
    const payload = {
      version: nextVersion,
      db_gzip_base64: gzBase64,
      updated_at: new Date().toISOString(),
      updated_by: String(updatedBy).slice(0, 100),
    };

    if (isFirebaseConfigured()) {
      const token = await getFirebaseAccessToken();
      const res = await fetch(
        `${getFirebaseDatabaseUrl()}/${RTDB_NODE_PATH}.json?access_token=${encodeURIComponent(token)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(5000),
        }
      );
      if (!res.ok) {
        throw new Error(`Firebase push failed: ${res.status}`);
      }
    } else {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/ihqa_cloud_state`, {
        method: 'POST',
        headers: supabaseHeaders({
          Prefer: 'resolution=merge-duplicates,return=minimal',
        }),
        body: JSON.stringify({
          id: 'main',
          ...payload,
        }),
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) {
        throw new Error(`Supabase push failed: ${res.status}`);
      }
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
  isFirebaseConfigured,
  fetchSupabaseSnapshot,
  pullIfNewer,
  pushSnapshot,
  initCloudSync,
};
