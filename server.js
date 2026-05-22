// ══════════════════════════════════════════════════════════════════════════════
// SPOTME SERVER v4.7 – PostgreSQL (inkl. SpotCache & Messenger Invites)
//
// Features:
//   • 24h Offline-Sichtbarkeit  → visible_until Timestamp pro Profil
//   • Offline-Nachrichten       → Nachricht hinterlassen wenn Nutzer offline
//   • Dialog-Erkennung          → Sobald Antwort erfolgt, kein Stundenlimit mehr
//   • Ping-Endpunkt             → Für Heartbeat (Render Free Tier)
//   • Spot-Nachrichten          → type, source, spot_type Felder
//   • Dates-Spot                → looking_for Feld
//   • Avatar-Upload             → Profilbilder als Base64 in DB
//   • Avatar-Moderation         → Admin freigeben/ablehnen
//   • Profile Comments          → Story-Kommentare (öffentlich)
//   • SpotCache                 → Geheime Treffpunkte (wishTags/offerTags)
//   • Messenger Invites         → RAM-basierte Einladungen
//
// Setup:
//   npm install pg
//   Render: DATABASE_URL wird automatisch gesetzt wenn du eine Postgres-DB
//           verlinkst. Lokal: DATABASE_URL=postgres://user:pass@localhost/spotme
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const express  = require('express');
const cors     = require('cors');
const crypto   = require('crypto');
const { ExpressPeerServer } = require('peer');
const { Pool } = require('pg');

// ══════════════════════════════════════════════════════════════════════════════
// VERSCHLÜSSELUNG (AES-256-CBC via Node.js crypto)
// CRYPTO_KEY = 64-stelliger Hex-String in Render Environment Variables setzen
// openssl rand -hex 32  →  erzeugt einen sicheren Key
// ══════════════════════════════════════════════════════════════════════════════
const CRYPTO_KEY  = process.env.CRYPTO_KEY || null;
const CRYPTO_ALGO = 'aes-256-cbc';

function encrypt(text) {
  if (text == null || !CRYPTO_KEY) return text;
  try {
    const iv  = crypto.randomBytes(16);
    const key = Buffer.from(CRYPTO_KEY, 'hex');
    const cipher = crypto.createCipheriv(CRYPTO_ALGO, key, iv);
    const enc = Buffer.concat([cipher.update(String(text)), cipher.final()]);
    return iv.toString('hex') + ':' + enc.toString('hex');
  } catch (e) { console.error('encrypt error:', e.message); return text; }
}

function decrypt(text) {
  if (text == null || !CRYPTO_KEY || !String(text).includes(':')) return text;
  try {
    const [ivHex, encHex] = String(text).split(':');
    const key = Buffer.from(CRYPTO_KEY, 'hex');
    const decipher = crypto.createDecipheriv(CRYPTO_ALGO, key, Buffer.from(ivHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]).toString();
  } catch (e) { return text; }
}

function decryptProfile(p) {
  if (!p) return p;
  const dec = {
    ...p,
    name:         decrypt(p.name),
    bio:          decrypt(p.bio),
    orientation:  decrypt(p.orientation),
    role:         decrypt(p.role),
    lookingFor:   decrypt(p.lookingFor),
    helpMode:     decrypt(p.helpMode),
    helpCategory: decrypt(p.helpCategory),
    category:     decrypt(p.category),
  };
  // SpotCache: JSON-Arrays entschlüsseln
  if (p.wish_tags) {
    try { dec.wishTags = JSON.parse(decrypt(p.wish_tags) || '[]'); } catch { dec.wishTags = []; }
  } else {
    dec.wishTags = null;
  }
  if (p.offer_tags) {
    try { dec.offerTags = JSON.parse(decrypt(p.offer_tags) || '[]'); } catch { dec.offerTags = []; }
  } else {
    dec.offerTags = null;
  }
  return dec;
}

const app = express();

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} from ${req.ip}`);
  next();
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ---------- PeerJS ----------
const server = require('http').createServer(app);
const peerServer = ExpressPeerServer(server, {
  path: '/',
  allow_discovery: true,
  proxied: true
});
app.use('/peerjs', peerServer);

// ---------- PostgreSQL Pool ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('render.com')
    ? { rejectUnauthorized: false }
    : false
});

// ---------- Konstanten ----------
const OFFLINE_VISIBLE_MS  = 24 * 60 * 60 * 1000;
const OFFLINE_MSG_MAX     = 280;
const OFFLINE_MSG_RATE_MS = 60 * 60 * 1000;

// ══════════════════════════════════════════════════════════════════════════════
// DATENBANK – Tabellen anlegen (beim Start)
// ══════════════════════════════════════════════════════════════════════════════
async function initDB() {

  // Profiles
  await pool.query(`
    CREATE TABLE IF NOT EXISTS profiles (
      code          TEXT NOT NULL,
      spot          TEXT NOT NULL DEFAULT 'gay',
      name          TEXT NOT NULL,
      age           INTEGER,
      region        TEXT NOT NULL,
      province      TEXT,
      city          TEXT,
      orientation   TEXT,
      role          TEXT,
      trans         BOOLEAN DEFAULT FALSE,
      crossdresser  BOOLEAN DEFAULT FALSE,
      looking_for   TEXT,
      help_mode     TEXT,
      help_category TEXT,
      category      TEXT,
      bio           TEXT,
      token         TEXT NOT NULL,
      last_seen     BIGINT,
      updated_at    BIGINT NOT NULL,
      visible_until BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (code, spot)
    );
  `);

  // Verifikationen
  await pool.query(`
    CREATE TABLE IF NOT EXISTS verifications (
      id          SERIAL PRIMARY KEY,
      to_code     TEXT NOT NULL,
      to_spot     TEXT NOT NULL DEFAULT 'gay',
      from_code   TEXT NOT NULL,
      type        TEXT NOT NULL CHECK (type IN ('personal','chat')),
      created_at  BIGINT NOT NULL,
      UNIQUE(to_code, to_spot, from_code, type)
    );
  `);

  // Verpasste Anrufe
  await pool.query(`
    CREATE TABLE IF NOT EXISTS missed_calls (
      id          SERIAL PRIMARY KEY,
      recipient   TEXT NOT NULL,
      caller_id   TEXT NOT NULL,
      caller_name TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_missed_recipient ON missed_calls(recipient);
    CREATE INDEX IF NOT EXISTS idx_missed_created   ON missed_calls(created_at);
  `);

  // Offline-Nachrichten
  await pool.query(`
    CREATE TABLE IF NOT EXISTS offline_messages (
      id          SERIAL PRIMARY KEY,
      recipient   TEXT NOT NULL,
      sender_code TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      message     TEXT NOT NULL,
      type        TEXT,
      source      TEXT,
      spot_type   TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      read        BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE INDEX IF NOT EXISTS idx_offmsg_recipient ON offline_messages(recipient);
    CREATE INDEX IF NOT EXISTS idx_offmsg_created   ON offline_messages(created_at);
  `);

  // Profile Comments
  await pool.query(`
    CREATE TABLE IF NOT EXISTS profile_comments (
      id            SERIAL PRIMARY KEY,
      profile_code  TEXT NOT NULL,
      profile_spot  TEXT NOT NULL DEFAULT 'dates',
      sender_code   TEXT NOT NULL,
      sender_name   TEXT NOT NULL,
      message       TEXT NOT NULL CHECK (char_length(message) <= 140),
      created_at    BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pc_profile ON profile_comments(profile_code, profile_spot);
    CREATE INDEX IF NOT EXISTS idx_pc_created ON profile_comments(created_at);
  `);

 // SpotCache v1 (Requests)
await pool.query(`
  CREATE TABLE IF NOT EXISTS spot_cache_requests (
    id            SERIAL PRIMARY KEY,
    from_code     TEXT NOT NULL,
    to_code       TEXT NOT NULL,
    wish          TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending',
    location_lat  DOUBLE PRECISION,
    location_lng  DOUBLE PRECISION,
    unlocked_at   BIGINT,
    created_at    BIGINT NOT NULL,
    UNIQUE(from_code, to_code, wish)
  );
`);

// SpotCache v2 – User-eigene Geocaching-Spots
await pool.query(`
  CREATE TABLE IF NOT EXISTS user_spots (
    id           SERIAL PRIMARY KEY,
    code         TEXT NOT NULL,
    lat          DOUBLE PRECISION NOT NULL,
    lng          DOUBLE PRECISION NOT NULL,
    name         TEXT NOT NULL,
    description  TEXT,
    wish_tag     TEXT NOT NULL,
    image        TEXT,
    image_status TEXT DEFAULT 'pending',
    created_at   BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_user_spots_code ON user_spots(code);
  CREATE INDEX IF NOT EXISTS idx_user_spots_wish ON user_spots(wish_tag);
`);

// SpotCache v2 – Einladungen mit Zeitfenster
await pool.query(`
  CREATE TABLE IF NOT EXISTS spot_cache_invites (
    id          SERIAL PRIMARY KEY,
    from_code   TEXT NOT NULL,
    to_code     TEXT NOT NULL,
    spot_id     INTEGER NOT NULL REFERENCES user_spots(id),
    time_start  BIGINT NOT NULL,
    time_end    BIGINT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    checked_in_from BOOLEAN DEFAULT FALSE,
    checked_in_to   BOOLEAN DEFAULT FALSE,
    created_at  BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_invites_from ON spot_cache_invites(from_code);
  CREATE INDEX IF NOT EXISTS idx_invites_to ON spot_cache_invites(to_code);
  CREATE INDEX IF NOT EXISTS idx_invites_status ON spot_cache_invites(status);
`);

  // Spalten nachträglich hinzufügen
  try {
    await pool.query(`ALTER TABLE offline_messages ADD COLUMN IF NOT EXISTS type TEXT`);
    await pool.query(`ALTER TABLE offline_messages ADD COLUMN IF NOT EXISTS source TEXT`);
    await pool.query(`ALTER TABLE offline_messages ADD COLUMN IF NOT EXISTS spot_type TEXT`);
    await pool.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS looking_for TEXT`);
    await pool.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS help_mode TEXT`);
    await pool.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS help_category TEXT`);
    await pool.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS avatar TEXT`);
    await pool.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS avatar_status TEXT DEFAULT 'pending'`).catch(() => {});
    await pool.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS wish_tags TEXT`);
    await pool.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS offer_tags TEXT`);
    await pool.query(`ALTER TABLE user_spots ADD COLUMN IF NOT EXISTS image TEXT`).catch(() => {});
    await pool.query(`ALTER TABLE user_spots ADD COLUMN IF NOT EXISTS description TEXT`).catch(() => {});
    await pool.query(`ALTER TABLE user_spots ADD COLUMN IF NOT EXISTS image_status TEXT DEFAULT 'pending'`).catch(() => {});
    console.log('✅ v4.7 – Alle Spalten bereit (inkl. SpotCache)');
  } catch (e) {
    console.log('ℹ️ Spalten existieren bereits oder konnten nicht angelegt werden');
  }

  console.log('✅ Datenbank-Tabellen bereit');
}

// ---------- Standort-Cache (RAM, 2-Min TTL) ----------
const locationCache = new Map();

// Zähler der verfolgt wie oft der Interval bereits gefeuert hat.
// Damit können wir seltene Aufgaben (z.B. täglich) von häufigen
// (z.B. alle 2 Minuten) trennen – ohne zwei separate setInterval-Timer.
let cleanupTickCount = 0;

setInterval(async () => {
  const now = Date.now();
  cleanupTickCount++;

  // ── ALLE 2 MINUTEN: RAM-Cache bereinigen ────────────────────────────────
  // Der locationCache wächst mit jedem Online-Nutzer – ohne Cleanup würde
  // er über Zeit den Arbeitsspeicher des Servers füllen.
  for (const [key, data] of locationCache.entries()) {
    if (now - data.ts > 120000) locationCache.delete(key);
  }

  // ── ALLE 2 MINUTEN: Einladungen im RAM bereinigen ───────────────────────
  // Einladungen älter als 2 Stunden aus dem RAM löschen (bereits vorhanden)
  for (const code of Object.keys(invites)) {
    invites[code] = invites[code].filter(i => now - i.ts < 2 * 60 * 60 * 1000);
    if (invites[code].length === 0) delete invites[code];
  }

  // ── ALLE 7 TAGE (= 5040 Ticks × 2 Min): Datenbank-Cleanup ──────────────
  // Wir führen schwere Datenbankoperationen nicht alle 2 Minuten aus,
  // sondern nur täglich. 720 Ticks × 2 Minuten = genau 24 Stunden.
  // Der Modulo-Operator % gibt den Rest einer Division zurück:
  // cleanupTickCount % 720 === 0 ist nur dann true wenn der Zähler
  // ein genaues Vielfaches von 720 ist – also genau alle 24 Stunden.
  const isDaily = cleanupTickCount % 720 === 0;

  if (isDaily) {
    console.log('🗓️ Täglicher Datenbank-Cleanup startet…');

    // ── Abgelaufene Einladungen auf 'expired' setzen ──────────────────────
    // Wir löschen sie NICHT sofort – der Nutzer soll seine vergangenen
    // Treffen noch bis zu 30 Tage sehen können (Strategie 2).
    try {
      const r = await pool.query(
        `UPDATE spot_cache_invites
         SET status = 'expired'
         WHERE time_end < $1
           AND status IN ('pending', 'accepted')`,
        [now]
      );
      if (r.rowCount > 0) console.log(`🗂️ ${r.rowCount} Einladungen auf 'expired' gesetzt`);
    } catch (e) { console.error('Cleanup invites (expire):', e.message); }

    // ── Wirklich alte Einladungen endgültig löschen (>30 Tage) ───────────
    // Erst nach 30 Tagen werden die archivierten Einladungen wirklich
    // aus der Datenbank entfernt. Das hält die Tabelle langfristig klein.
    try {
      const cutoff = now - (30 * 24 * 60 * 60 * 1000);
      const r = await pool.query(
        `DELETE FROM spot_cache_invites
         WHERE status = 'expired'
           AND time_end < $1`,
        [cutoff]
      );
      if (r.rowCount > 0) console.log(`🗑️ ${r.rowCount} alte Einladungen gelöscht (>30 Tage)`);
    } catch (e) { console.error('Cleanup invites (delete):', e.message); }

    // ── Alte Missed Calls löschen ─────────────────────────────────────────
    try {
      const r = await pool.query(
        `DELETE FROM missed_calls WHERE created_at < NOW() - INTERVAL '7 days'`
      );
      if (r.rowCount > 0) console.log(`🧹 ${r.rowCount} alte Missed Calls gelöscht`);
    } catch (e) { console.error('Cleanup missed_calls:', e.message); }

    // ── Alte Offline-Nachrichten löschen ──────────────────────────────────
    try {
      const r = await pool.query(
        `DELETE FROM offline_messages WHERE created_at < NOW() - INTERVAL '7 days'`
      );
      if (r.rowCount > 0) console.log(`🧹 ${r.rowCount} alte Offline-Nachrichten gelöscht`);
    } catch (e) { console.error('Cleanup offline_messages:', e.message); }

    // ── Inaktive Profile löschen ──────────────────────────────────────────
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
    try {
      const r = await pool.query(
        `DELETE FROM profiles
         WHERE visible_until < $1
           AND COALESCE(last_seen, updated_at) < $2`,
        [now, thirtyDaysAgo]
      );
      if (r.rowCount > 0) console.log(`🧹 ${r.rowCount} inaktive Profile gelöscht`);
    } catch (e) { console.error('Cleanup profiles:', e.message); }

    console.log('✅ Täglicher Cleanup abgeschlossen');
  }

}, 120000); // alle 2 Minuten

// ---------- Antispam ----------
function sanitizeMessage(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/https?:\/\/\S+/gi, '[Link entfernt]')
    .replace(/\S+@\S+\.\S+/gi, '[E-Mail entfernt]')
    .slice(0, OFFLINE_MSG_MAX)
    .trim();
}

// ══════════════════════════════════════════════════════════════════════════════
// COMMUNITY PROFILE
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/profiles', async (req, res) => {
  const spot = req.query.spot || 'gay';
  const now  = Date.now();
  try {
    const { rows } = await pool.query(
      `SELECT code, name, age, region, province, city,
              orientation, role, trans, crossdresser,
              looking_for AS "lookingFor",
              help_mode AS "helpMode",
              help_category AS "helpCategory",
              category, bio,
              wish_tags, offer_tags,
              last_seen, updated_at AS ts, visible_until,
              (COALESCE(last_seen, 0) > $2) AS is_online,
              (SELECT COUNT(*) FROM profile_comments WHERE profile_code = p.code AND profile_spot = p.spot) AS comment_count
       FROM profiles p
       WHERE spot = $1 AND visible_until > $2
       ORDER BY is_online DESC, updated_at DESC`,
      [spot, now]
    );
    res.json(rows.map(r => ({ ...decryptProfile(r), commentCount: parseInt(r.comment_count) || 0 })));
  } catch (e) {
    console.error('GET /api/profiles:', e.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

app.post('/api/profile', async (req, res) => {
  const {
    code, name, age, region, province, city,
    orientation, role, trans, crossdresser, category, bio,
    lookingFor, helpMode, helpCategory,
    wishTags, offerTags,
    avatar,              // ← NEU: optional Base64‑Avatar
    token, spot = 'gay'
  } = req.body;

  if (!code || !name || !region) {
    return res.status(400).json({ error: 'Pflichtfelder: code, name, region' });
  }

  const now          = Date.now();
  const visibleUntil = now + OFFLINE_VISIBLE_MS;

  try {
    const existing = await pool.query(
      'SELECT token FROM profiles WHERE code = $1 AND spot = $2',
      [code, spot]
    );

    let globalToken = null;
    if (!existing.rows.length || !existing.rows[0]?.token) {
      const gc = await pool.query(
        'SELECT token FROM profiles WHERE code = $1 AND token IS NOT NULL ORDER BY updated_at DESC LIMIT 1',
        [code]
      );
      if (gc.rows.length > 0) globalToken = gc.rows[0].token;
    }

    let profileToken;

    if (existing.rows.length > 0) {
      // UPDATE
      const storedToken = existing.rows[0].token || globalToken;
      if (!token) {
        profileToken = storedToken || crypto.randomBytes(32).toString('hex');
      } else {
        const allTok = await pool.query(
          'SELECT token FROM profiles WHERE code = $1 AND token IS NOT NULL',
          [code]
        );
        const tokenOk = allTok.rows.some(r => r.token === token);
        if (storedToken && !tokenOk) {
          return res.status(403).json({ error: 'Ungültiger Token' });
        }
        profileToken = token;
      }

      await pool.query(
        `UPDATE profiles SET
          name=$1, age=$2, region=$3, province=$4, city=$5,
          orientation=$6, role=$7, trans=$8, crossdresser=$9,
          looking_for=$10,
          help_mode=$11, help_category=$12,
          category=$13, bio=$14,
          wish_tags=$15, offer_tags=$16,
          avatar        = COALESCE($21, avatar),
          avatar_status = CASE WHEN $21 IS NOT NULL THEN 'pending' ELSE avatar_status END,
          updated_at=$17, visible_until=$18
         WHERE code=$19 AND spot=$20`,
        [
          encrypt(name), age || null, region, province || null, city || null,
          encrypt(orientation) || null, encrypt(role) || null, !!trans, !!crossdresser,
          encrypt(lookingFor) || null,
          encrypt(helpMode) || null, encrypt(helpCategory) || null,
          encrypt(category) || null, encrypt(bio) || null,
          encrypt(JSON.stringify(wishTags || [])),
          encrypt(JSON.stringify(offerTags || [])),
          now, visibleUntil, code, spot,
          avatar || null   // $21
        ]
      );
    } else {
      // INSERT
      profileToken = crypto.randomBytes(32).toString('hex');
      await pool.query(
        `INSERT INTO profiles
          (code, spot, name, age, region, province, city,
           orientation, role, trans, crossdresser, looking_for,
           help_mode, help_category, category, bio,
           wish_tags, offer_tags,
           avatar, avatar_status,
           token, updated_at, visible_until)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
        [
          code, spot, encrypt(name), age || null, region,
          province || null, city || null,
          encrypt(orientation) || null, encrypt(role) || null, !!trans, !!crossdresser,
          encrypt(lookingFor) || null,
          encrypt(helpMode) || null, encrypt(helpCategory) || null,
          encrypt(category) || null, encrypt(bio) || null,
          encrypt(JSON.stringify(wishTags || [])),
          encrypt(JSON.stringify(offerTags || [])),
          avatar || null,
          avatar ? 'pending' : null,
          profileToken, now, visibleUntil
        ]
      );
    }

    res.json({ success: true, token: profileToken, visibleUntil });
  } catch (e) {
    console.error('POST /api/profile:', e.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

app.delete('/api/profile/:code', async (req, res) => {
  const { code } = req.params;
  const token = req.body?.token || req.headers['x-spotme-token'];
  const spot  = req.body?.spot  || req.query.spot || 'gay';

  try {
    const existing = await pool.query(
      'SELECT token FROM profiles WHERE code = $1 AND spot = $2',
      [code, spot]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Nicht gefunden' });

    const allTokens = await pool.query(
      'SELECT token FROM profiles WHERE code = $1 AND token IS NOT NULL',
      [code]
    );
    const tokenValid = allTokens.rows.some(r => r.token === token);
    if (!token || !tokenValid) {
      return res.status(403).json({ error: 'Ungültiger Token' });
    }

    await pool.query(
      'UPDATE profiles SET visible_until = 0 WHERE code = $1 AND spot = $2',
      [code, spot]
    );
    locationCache.delete(code + ':' + spot);
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /api/profile:', e.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

app.get('/api/profile/:code', async (req, res) => {
  const { code } = req.params;
  const spot = req.query.spot || 'gay';
  try {
    const { rows } = await pool.query(
      `SELECT code, name, age, region, province, city,
              orientation, role, trans, crossdresser,
              looking_for AS "lookingFor",
              category, bio,
              wish_tags, offer_tags,
              updated_at AS ts, visible_until
       FROM profiles WHERE code = $1 AND spot = $2`,
      [code, spot]
    );
    if (!rows.length) return res.status(404).json({ error: 'Nicht gefunden' });
    res.json(decryptProfile(rows[0]));
  } catch (e) {
    console.error('GET /api/profile/:code:', e.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// AVATAR UPLOAD / ABRUF / LÖSCHEN
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/avatar', async (req, res) => {
  const { code, token, avatar, spot = 'caching' } = req.body;

  if (!code || !token || !avatar) {
    return res.status(400).json({ error: 'code, token und avatar (Base64) erforderlich' });
  }

  try {
    // Token über alle Spots dieses Codes prüfen
    const auth = await pool.query(
      'SELECT token, spot FROM profiles WHERE code = $1 AND token IS NOT NULL',
      [code]
    );
    const tokenValid = auth.rows.some(r => r.token === token);
    if (!auth.rows.length || !tokenValid) {
      return res.status(403).json({ error: 'Ungültiger Token' });
    }
  } catch (e) {
    return res.status(500).json({ error: 'Token-Prüfung fehlgeschlagen' });
  }

  if (avatar.length > 1_400_000) {
    return res.status(413).json({ error: 'Bild zu groß (max. 1 MB)' });
  }

  if (!avatar.startsWith('data:image/')) {
    return res.status(400).json({ error: 'Nur Base64-Bilder erlaubt (data:image/...)' });
  }

  const mimeMatch = avatar.match(/^data:(image\/[a-z+]+);base64,/);
  if (!mimeMatch) {
    return res.status(400).json({ error: 'Ungültiges Base64-Format' });
  }

  const mimeType = mimeMatch[1];
  const allowed  = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (!allowed.includes(mimeType)) {
    return res.status(400).json({ error: `Nur ${allowed.join(', ')} erlaubt` });
  }

  try {
    // Auf allen Spots dieses Codes updaten
    await pool.query(
      'UPDATE profiles SET avatar = $1, avatar_status = $2, updated_at = $3 WHERE code = $4 AND spot = $5',
      [avatar, 'pending', Date.now(), code, spot]
    );
    console.log(`🖼️ Avatar hochgeladen (pending): ${code} (${spot}) – ${(avatar.length / 1024).toFixed(0)} KB`);
    res.json({ success: true, mimeType, status: 'pending', message: 'Avatar wird geprüft und bald freigegeben' });
  } catch (e) {
    console.error('POST /api/avatar:', e.message);
    res.status(500).json({ error: 'Fehler beim Speichern' });
  }
});

app.get('/api/avatar/:code', async (req, res) => {
  const { code } = req.params;
  const spot = req.query.spot || 'gay';

  try {
    const { rows } = await pool.query(
      'SELECT avatar, avatar_status FROM profiles WHERE code = $1 AND spot = $2 AND avatar IS NOT NULL',
      [code, spot]
    );

    if (!rows.length || !rows[0].avatar) {
      return res.status(404).json({ error: 'Kein Avatar' });
    }

    if (rows[0].avatar_status !== 'approved') {
      return res.status(404).json({ error: 'Avatar noch nicht freigegeben', status: rows[0].avatar_status || 'pending' });
    }

    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ avatar: rows[0].avatar });
  } catch (e) {
    console.error('GET /api/avatar:', e.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

app.delete('/api/avatar/:code', async (req, res) => {
  const { code } = req.params;
  const token = req.body?.token || req.headers['x-spotme-token'];
  const spot  = req.body?.spot  || 'caching';

  if (!token) {
    return res.status(401).json({ error: 'Token fehlt' });
  }

  try {
    const auth = await pool.query(
      'SELECT token FROM profiles WHERE code = $1 AND token IS NOT NULL',
      [code]
    );
    const tokenValid = auth.rows.some(r => r.token === token);
    if (!auth.rows.length || !tokenValid) {
      return res.status(403).json({ error: 'Ungültiger Token' });
    }

    await pool.query(
      'UPDATE profiles SET avatar = NULL, avatar_status = NULL, updated_at = $1 WHERE code = $2 AND spot = $3',
      [Date.now(), code, spot]
    );
    console.log(`🗑️ Avatar gelöscht: ${code} (${spot})`);
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /api/avatar:', e.message);
    res.status(500).json({ error: 'Fehler beim Löschen' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// LIVE-STANDORT (RAM, 2-Min TTL)
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/location', (req, res) => {
  const { code, lat, lng, spot = 'gay' } = req.body;
  if (!code || lat == null || lng == null) {
    return res.status(400).json({ error: 'Fehlende Felder' });
  }
  locationCache.set(code + ':' + spot, { lat, lng, ts: Date.now() });
  res.json({ success: true });
});

app.get('/api/location/:code', (req, res) => {
  const { code } = req.params;
  const spot = req.query.spot || 'gay';
  const data = locationCache.get(code + ':' + spot);
  if (!data || Date.now() - data.ts > 120000) {
    return res.status(404).json({ error: 'Standort nicht verfügbar' });
  }
  res.json({ lat: data.lat, lng: data.lng });
});

// ══════════════════════════════════════════════════════════════════════════════
// HEARTBEAT & ONLINE-STATUS
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/heartbeat', async (req, res) => {
  const { code, spot = 'gay' } = req.body;
  if (!code) return res.status(400).json({ error: 'Code fehlt' });
  const now          = Date.now();
  const visibleUntil = now + OFFLINE_VISIBLE_MS;
  try {
    await pool.query(
      `UPDATE profiles
       SET last_seen = $1,
           visible_until = GREATEST(visible_until, $2)
       WHERE code = $3 AND spot = $4`,
      [now, visibleUntil, code, spot]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

app.get('/api/online/:code', async (req, res) => {
  const { code } = req.params;
  const spot = req.query.spot || 'gay';
  try {
    const { rows } = await pool.query(
      'SELECT last_seen, visible_until FROM profiles WHERE code = $1 AND spot = $2',
      [code, spot]
    );
    if (!rows.length) return res.json({ online: false, visible: false });
    const now     = Date.now();
    const online  = rows[0].last_seen && (now - Number(rows[0].last_seen)) < 120000;
    const visible = Number(rows[0].visible_until) > now;
    res.json({ online: !!online, visible, lastSeen: Number(rows[0].last_seen) });
  } catch (e) {
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// VERIFIKATIONEN
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/verify', async (req, res) => {
  const { fromCode, toCode, type, spot = 'gay' } = req.body;
  if (!fromCode || !toCode || !type) {
    return res.status(400).json({ error: 'Felder fehlen' });
  }
  try {
    await pool.query(
      `INSERT INTO verifications (to_code, to_spot, from_code, type, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (to_code, to_spot, from_code, type) DO NOTHING`,
      [toCode, spot, fromCode, type, Date.now()]
    );
    res.json({ success: true });
  } catch (e) {
    console.error('POST /api/verify:', e.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

app.get('/api/verifications/:code', async (req, res) => {
  const { code } = req.params;
  const spot = req.query.spot || 'gay';
  try {
    const { rows } = await pool.query(
      `SELECT from_code AS "from", type, created_at AS ts
       FROM verifications
       WHERE to_code = $1 AND to_spot = $2
       ORDER BY created_at DESC`,
      [code, spot]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// VERPASSTE ANRUFE
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/missed-call', async (req, res) => {
  const { recipient, callerId, callerName } = req.body;
  if (!recipient || !callerId || !callerName) {
    return res.status(400).json({ error: 'Fehlende Felder' });
  }
  try {
    await pool.query(
      `INSERT INTO missed_calls (recipient, caller_id, caller_name) VALUES ($1, $2, $3)`,
      [recipient, callerId, encrypt(callerName)]
    );
    await pool.query(
      `DELETE FROM missed_calls WHERE id IN (
         SELECT id FROM missed_calls WHERE recipient = $1
         ORDER BY created_at DESC OFFSET 500
       )`,
      [recipient]
    );
    res.json({ success: true });
  } catch (e) {
    console.error('POST /api/missed-call:', e.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

app.get('/api/missed-calls/:code', async (req, res) => {
  const { code } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT caller_id AS "callerId", caller_name AS "callerName",
              created_at AS timestamp
       FROM missed_calls WHERE recipient = $1
       ORDER BY created_at DESC LIMIT 50`,
      [code]
    );
    res.json(rows.map(r => ({ ...r, callerName: decrypt(r.callerName) })));
  } catch (e) {
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// OFFLINE-NACHRICHTEN (private Kurznachrichten)
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/offline-message', async (req, res) => {
  const { recipient, senderCode, senderName, message, type, source, spotType } = req.body;

  if (!recipient || !senderCode || !senderName || !message) {
    return res.status(400).json({ error: 'Fehlende Felder' });
  }
  if (recipient === senderCode) {
    return res.status(400).json({ error: 'Keine Nachricht an sich selbst' });
  }

  const clean = sanitizeMessage(message);
  if (!clean.length) {
    return res.status(400).json({ error: 'Nachricht ist leer nach Bereinigung' });
  }

  try {
    const dialogCheck = await pool.query(
      `SELECT id FROM offline_messages 
       WHERE sender_code = $1 AND recipient = $2
       LIMIT 1`,
      [recipient, senderCode]
    );

    if (dialogCheck.rows.length === 0) {
      const rateMinutes = Math.ceil(OFFLINE_MSG_RATE_MS / 60000);
      const rateCheck = await pool.query(
        `SELECT id FROM offline_messages
         WHERE sender_code = $1 AND recipient = $2
           AND created_at > NOW() - INTERVAL '${rateMinutes} minutes'
         LIMIT 1`,
        [senderCode, recipient]
      );
      if (rateCheck.rows.length > 0) {
        return res.status(429).json({ error: `Maximal 1 Nachricht pro ${rateMinutes > 1 ? rateMinutes + ' Minuten' : 'Minute'} für die erste Kontaktaufnahme` });
      }
    }

    const countCheck = await pool.query(
      `SELECT COUNT(*) AS cnt FROM offline_messages WHERE recipient = $1 AND read = FALSE`,
      [recipient]
    );
    if (Number(countCheck.rows[0].cnt) >= 50) {
      return res.status(429).json({ error: 'Postfach des Empfängers voll' });
    }

    await pool.query(
      `INSERT INTO offline_messages (recipient, sender_code, sender_name, message, type, source, spot_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [recipient, senderCode, encrypt(senderName.slice(0, 50)), encrypt(clean), type || null, source || null, spotType || null]
    );

    res.json({ success: true });
  } catch (e) {
    console.error('POST /api/offline-message:', e.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

app.get('/api/offline-messages/:code', async (req, res) => {
  const { code } = req.params;
  const token = req.query.token || req.headers['x-spotme-token'];
  const spot  = req.query.spot || 'gay';

  if (!token) return res.status(401).json({ error: 'Token fehlt' });

  try {
    const auth = await pool.query(
      'SELECT token FROM profiles WHERE code = $1 AND spot = $2',
      [code, spot]
    );
    if (!auth.rows.length || auth.rows[0].token !== token) {
      return res.status(403).json({ error: 'Ungültiger Token' });
    }

    const { rows } = await pool.query(
      `SELECT id, sender_code AS "senderCode", sender_name AS "senderName",
              message, type, source, spot_type AS "spotType",
              created_at AS timestamp, read
       FROM offline_messages
       WHERE recipient = $1 AND spot_type = $2
       ORDER BY created_at DESC
       LIMIT 50`,
      [code, spot]
    );
    res.json(rows.map(r => ({
      ...r,
      senderName: decrypt(r.senderName),
      message:    decrypt(r.message),
    })));
  } catch (e) {
    console.error('GET /api/offline-messages:', e.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// CHAT MESSENGER (SpotCaching – leichtgewichtig)
// Nutzt dieselbe offline_messages Tabelle, aber mit spot_type='caching_chat'
// Kein Token erforderlich – Sicherheit über Profil-Existenz-Check
// ══════════════════════════════════════════════════════════════════════════════

// ── Nachricht senden ─────────────────────────────────────────────────────────
// Jeder der ein Profil hat kann eine Nachricht schicken.
// Das verhindert anonymen Spam ohne einen Login zu erzwingen.
app.post('/api/message', async (req, res) => {
  const { recipient, sender_code, sender_name, message, spot_type } = req.body;

  // Pflichtfelder prüfen
  if (!recipient || !sender_code || !message) {
    return res.status(400).json({ error: 'recipient, sender_code und message sind Pflicht' });
  }

  // Selbst-Nachrichten verhindern
  if (sender_code === recipient) {
    return res.status(400).json({ error: 'Nachrichten an sich selbst nicht erlaubt' });
  }

  // Nachricht bereinigen – Links und E-Mails entfernen, auf 280 Zeichen kürzen
  const clean = sanitizeMessage(message);
  if (!clean.length) {
    return res.status(400).json({ error: 'Nachricht ist leer oder ungültig' });
  }

  try {
    // Sicherheits-Check: Hat der Absender ein Profil im System?
    // Das verhindert dass anonyme Bots Nachrichten schicken können.
    // Profil muss im caching-Spot existieren.
    const senderExists = await pool.query(
      `SELECT 1 FROM profiles WHERE code = $1 AND spot = 'caching' LIMIT 1`,
      [sender_code]
    );
    if (!senderExists.rows.length) {
      return res.status(403).json({ error: 'Absender hat kein Profil' });
    }

    // Postfach-Limit: maximal 100 ungelesene Chat-Nachrichten pro Empfänger
    // Das verhindert Spam auch wenn jemand ein Profil hat
    const countCheck = await pool.query(
      `SELECT COUNT(*) AS cnt FROM offline_messages
       WHERE recipient = $1 AND spot_type = 'caching_chat' AND read = FALSE`,
      [recipient]
    );
    if (Number(countCheck.rows[0].cnt) >= 100) {
      return res.status(429).json({ error: 'Postfach des Empfängers voll' });
    }

    // Nachricht speichern
    await pool.query(
      `INSERT INTO offline_messages
         (recipient, sender_code, sender_name, message, spot_type)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        recipient,
        sender_code,
        encrypt(sender_name?.slice(0, 50) || sender_code),
        encrypt(clean),
        spot_type || 'caching_chat'
      ]
    );

    console.log(`💬 Chat: ${sender_code} → ${recipient}`);
    res.json({ success: true });

  } catch (e) {
    console.error('POST /api/message:', e.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// ── Nachrichten abrufen ───────────────────────────────────────────────────────
// Gibt alle Chat-Nachrichten für einen Empfänger zurück.
// Optional: ?spot_type=caching_chat für gefilterten Abruf.
// Nach dem Abrufen werden die Nachrichten als "gelesen" markiert –
// wie ein Briefkasten der geleert wird wenn man die Post holt.
app.get('/api/messages/:code', async (req, res) => {
  const { code }    = req.params;
  const spot_type   = req.query.spot_type || 'caching_chat';

  try {
    // Nachrichten der letzten 48 Stunden abrufen
    // Ältere Nachrichten sind im localStorage bereits gespeichert
    const { rows } = await pool.query(
      `SELECT id, sender_code, sender_name, message, spot_type, created_at
       FROM offline_messages
       WHERE recipient = $1
         AND spot_type = $2
         AND read = FALSE
         AND created_at > NOW() - INTERVAL '48 hours'
       ORDER BY created_at ASC`,
      [code, spot_type]
    );

    // Als gelesen markieren damit beim nächsten Poll keine Duplikate kommen
    if (rows.length > 0) {
      const ids = rows.map(r => r.id);
      await pool.query(
        'UPDATE offline_messages SET read = TRUE WHERE id = ANY($1)',
        [ids]
      );
      console.log(`📬 ${rows.length} Chat-Nachrichten abgerufen für ${code}`);
    }

    // Nachrichten entschlüsseln bevor sie ans Frontend geschickt werden
    res.json(rows.map(r => ({
      ...r,
      sender_name: decrypt(r.sender_name),
      message:     decrypt(r.message),
    })));

  } catch (e) {
    console.error('GET /api/messages:', e.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

app.delete('/api/offline-message/:id', async (req, res) => {
  const { id } = req.params;
  const { code, token, spot = 'gay' } = req.body;

  if (!code || !token) return res.status(401).json({ error: 'Token fehlt' });

  try {
    const auth = await pool.query(
      'SELECT token FROM profiles WHERE code = $1 AND spot = $2',
      [code, spot]
    );
    if (!auth.rows.length || auth.rows[0].token !== token) {
      return res.status(403).json({ error: 'Ungültiger Token' });
    }
    await pool.query(
      'UPDATE offline_messages SET read = TRUE WHERE id = $1 AND recipient = $2',
      [id, code]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

app.delete('/api/offline-messages/:code', async (req, res) => {
  const { code } = req.params;
  const token = req.body?.token || req.headers['x-spotme-token'];
  const spot  = req.body?.spot  || 'gay';

  if (!token) return res.status(401).json({ error: 'Token fehlt' });

  try {
    const auth = await pool.query(
      'SELECT token FROM profiles WHERE code = $1 AND spot = $2',
      [code, spot]
    );
    if (!auth.rows.length || auth.rows[0].token !== token) {
      return res.status(403).json({ error: 'Ungültiger Token' });
    }
    await pool.query(
      'UPDATE offline_messages SET read = TRUE WHERE recipient = $1',
      [code]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// PROFILE COMMENTS (Story-Kommentare)
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/profile-comment', async (req, res) => {
  const { profileCode, profileSpot = 'dates', senderCode, senderName, message } = req.body;

  if (!profileCode || !senderCode || !senderName || !message) {
    return res.status(400).json({ error: 'profileCode, senderCode, senderName, message erforderlich' });
  }

  const clean = message.trim().slice(0, 140);
  if (!clean.length) {
    return res.status(400).json({ error: 'Nachricht ist leer' });
  }

  if (/https?:\/\/|www\./i.test(clean)) {
    return res.status(400).json({ error: 'Keine Links erlaubt' });
  }

  try {
    await pool.query(
      `INSERT INTO profile_comments (profile_code, profile_spot, sender_code, sender_name, message, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [profileCode, profileSpot, senderCode, encrypt(senderName.slice(0, 50)), encrypt(clean), Date.now()]
    );

    console.log(`💬 Kommentar: ${senderName} → ${profileCode}: "${clean.slice(0, 30)}..."`);
    res.json({ success: true });
  } catch (e) {
    console.error('POST /api/profile-comment:', e.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

app.get('/api/profile-comments/:code', async (req, res) => {
  const { code } = req.params;
  const spot = req.query.spot || 'dates';

  try {
    const { rows } = await pool.query(
      `SELECT id, sender_code AS "senderCode", sender_name AS "senderName",
              message, created_at AS "createdAt"
       FROM profile_comments
       WHERE profile_code = $1 AND profile_spot = $2
       ORDER BY created_at DESC
       LIMIT 999`,
      [code, spot]
    );
    res.json(rows.map(r => ({
      ...r,
      senderName: decrypt(r.senderName),
      message:    decrypt(r.message),
    })));
  } catch (e) {
    console.error('GET /api/profile-comments:', e.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

app.delete('/api/profile-comment/:id', async (req, res) => {
  const { id } = req.params;
  const { code, token, spot = 'dates' } = req.body;

  if (!code || !token) {
    return res.status(401).json({ error: 'Token fehlt' });
  }

  try {
    const auth = await pool.query(
      'SELECT token FROM profiles WHERE code = $1 AND spot = $2',
      [code, spot]
    );
    if (!auth.rows.length || auth.rows[0].token !== token) {
      return res.status(403).json({ error: 'Nur der Profilinhaber kann Kommentare löschen' });
    }

    const comment = await pool.query(
      'SELECT id FROM profile_comments WHERE id = $1 AND profile_code = $2 AND profile_spot = $3',
      [id, code, spot]
    );
    if (!comment.rows.length) {
      return res.status(404).json({ error: 'Kommentar nicht gefunden' });
    }

    await pool.query('DELETE FROM profile_comments WHERE id = $1', [id]);
    console.log(`🗑️ Kommentar gelöscht: ID ${id} von Profil ${code}`);
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /api/profile-comment:', e.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// EINLADUNGEN (Messenger – RAM)
// ══════════════════════════════════════════════════════════════════════════════

const invites = {}; // { empfaengerCode: [{ from, to, ts, room }] }

// Cleanup: Einladungen nach 2 Stunden löschen
setInterval(() => {
  const now = Date.now();
  for (const code of Object.keys(invites)) {
    invites[code] = invites[code].filter(i => now - i.ts < 2 * 60 * 60 * 1000);
    if (invites[code].length === 0) delete invites[code];
  }
}, 60000);

// Einladung zum Messenger

app.post('/api/invites/send', async (req, res) => {
  // time_start und time_end aus dem Body lesen – das war vorher vergessen
  const { from, to, spot_id, time_start, time_end } = req.body;

  if (!from || !to || from.length !== 6 || to.length !== 6) {
    return res.status(400).json({ error: 'Ungültige Codes' });
  }
  if (from === to) {
    return res.status(400).json({ error: 'Selbst-Einladung nicht möglich' });
  }

  // ── RAM (wie bisher, aber jetzt MIT Zeitdaten) ──────────────────────────
  if (!invites[to]) invites[to] = [];
  const exists = invites[to].find(i => i.from === from);
  if (!exists) {
    const room = [from, to].sort().join('-');
    invites[to].push({
      from,
      to,
      ts:   Date.now(),
      room,
      // NEU: Zeitfenster mitspeichern damit der RAM-Kanal auch die Zeit kennt
      time_start: time_start || Date.now(),
      time_end:   time_end   || Date.now() + 7 * 24 * 60 * 60 * 1000
    });
    console.log(`📨 Einladung: ${from} → ${to} (Raum ${room})`);
  }

  // ── Datenbank (nur wenn spot_id vorhanden) ──────────────────────────────
  if (spot_id) {
    try {
      // Fallback-Werte falls kein Zeitfenster mitgeschickt wurde –
      // das kann passieren wenn jemand den Chat-Button ohne Modal nutzt
      const ts = time_start || Date.now();
      const te = time_end   || ts + 7 * 24 * 60 * 60 * 1000;

      await pool.query(
        `INSERT INTO spot_cache_invites
           (from_code, to_code, spot_id, time_start, time_end, status, created_at)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6)
         ON CONFLICT DO NOTHING`,
        [from, to, spot_id, ts, te, Date.now()]
        //                   ↑  ↑
        // Jetzt kommen die echten Zeitwerte aus dem Frontend-Modal,
        // nicht mehr der berechnete Standardwert vom Server
      );
    } catch (e) {
      console.error('DB invite error:', e.message);
    }
  }

  res.json({ success: true });
});

// Liefert alle Einladungen für einen Nutzer (als Sender UND Empfänger)
// inklusive Status – das ist der Unterschied zum RAM-Endpunkt
app.get('/api/spotcache/invites/:code', async (req, res) => {
  const { code } = req.params;
  try {
    const { rows } = await pool.query(
      // Wir joinieren die profiles-Tabelle ZWEIMAL – einmal für den Sender (pf)
      // und einmal für den Empfänger (pt). LEFT JOIN statt INNER JOIN damit die
      // Einladung auch erscheint wenn ein Profil zwischenzeitlich gelöscht wurde.
      // Die Namen sind verschlüsselt gespeichert und werden unten entschlüsselt.
      `SELECT i.*,
              u.name  AS spot_name,
              u.lat,
              u.lng,
              pf.name AS from_name_enc,
              pt.name AS to_name_enc
       FROM spot_cache_invites i
       JOIN user_spots u   ON u.id       = i.spot_id
       LEFT JOIN profiles pf ON pf.code  = i.from_code AND pf.spot = 'caching'
       LEFT JOIN profiles pt ON pt.code  = i.to_code   AND pt.spot = 'caching'
       WHERE i.from_code = $1 OR i.to_code = $1
       ORDER BY i.created_at DESC`,
      [code]
    );

    // Namen entschlüsseln bevor sie ans Frontend gehen –
    // decrypt() gibt null zurück wenn der Wert null/undefined ist, also sicher.
    res.json(rows.map(row => ({
      ...row,
      from_name:     row.from_name_enc ? decrypt(row.from_name_enc) : null,
      to_name:       row.to_name_enc   ? decrypt(row.to_name_enc)   : null,
      // Rohdaten entfernen damit keine verschlüsselten Werte ans Frontend gelangen
      from_name_enc: undefined,
      to_name_enc:   undefined,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Einladung annehmen oder ablehnen
app.patch('/api/spotcache/invite/:id', async (req, res) => {
  const { id } = req.params;
  const { status, code } = req.body;

  if (!['accepted', 'declined'].includes(status)) {
    return res.status(400).json({ error: 'Ungültiger Status' });
  }

  try {
    const result = await pool.query(
      // Nur der Empfänger (to_code) darf antworten – Sicherheits-Check
      `UPDATE spot_cache_invites SET status = $1
       WHERE id = $2 AND to_code = $3
       RETURNING *`,
      [status, id, code]
    );
    if (result.rowCount === 0) {
      return res.status(403).json({ error: 'Nicht berechtigt' });
    }


if (status === 'accepted') {
  const invite = result.rows[0];
  const room = [invite.from_code, invite.to_code].sort().join('-');
  if (!invites[invite.from_code]) invites[invite.from_code] = [];
  invites[invite.from_code].push({   // ← hier öffnet ein Objekt
    from: invite.to_code,
    to: invite.from_code,
    ts: Date.now(),
    room
  });                                 // ← Objekt geschlossen
}                                     // ← if-Block geschlossen
    res.json({ ok: true, invite: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ══════════════════════════════════════════════════════════════════════════════
// ADMIN – Avatar Moderation
// ══════════════════════════════════════════════════════════════════════════════

function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Kein Zugriff' });
  }
  next();
}

app.get('/api/admin/pending-avatars', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT code, spot, avatar, avatar_status, updated_at
       FROM profiles
       WHERE avatar IS NOT NULL AND avatar_status = 'pending'
       ORDER BY updated_at ASC`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

app.post('/api/admin/avatar-action', requireAdmin, async (req, res) => {
  const { code, spot, action } = req.body;
  if (!code || !spot || !['approve', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'code, spot und action (approve/reject) erforderlich' });
  }
  try {
    if (action === 'approve') {
      await pool.query(
        'UPDATE profiles SET avatar_status = $1 WHERE code = $2 AND spot = $3',
        ['approved', code, spot]
      );
      console.log(`✅ Avatar freigegeben: ${code} (${spot})`);
    } else {
      await pool.query(
        'UPDATE profiles SET avatar = NULL, avatar_status = NULL WHERE code = $1 AND spot = $2',
        [code, spot]
      );
      console.log(`❌ Avatar abgelehnt & gelöscht: ${code} (${spot})`);
    }
    res.json({ success: true, action, code, spot });
  } catch (e) {
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// SPOTCACHE – GEHEIME TREFFPUNKTE
// ══════════════════════════════════════════════════════════════════════════════

// 1️⃣ Matching: gemeinsame Wünsche + nahe Profile
app.get('/api/spotcache/match/:code', async (req, res) => {
  const { code } = req.params;
  const spot = req.query.spot || 'gay';
  const now  = Date.now();

  try {
    const myProfile = await pool.query(
      'SELECT wish_tags, offer_tags, region FROM profiles WHERE code = $1 AND spot = $2 AND visible_until > $3',
      [code, spot, now]
    );
    if (!myProfile.rows.length) return res.json({ matches: [] });
    const my = myProfile.rows[0];
    const myWishes = my.wish_tags ? JSON.parse(decrypt(my.wish_tags)) : [];

    const candidates = await pool.query(`
      SELECT p.code, p.name, p.city, p.region,
             p.wish_tags, p.offer_tags,
             l.lat, l.lng
      FROM profiles p
      LEFT JOIN LATERAL (
        SELECT data->>'lat' AS lat, data->>'lng' AS lng
        FROM (
          SELECT value::jsonb AS data
          FROM jsonb_each((SELECT jsonb_object_agg(key, value) FROM (SELECT * FROM location_cache) t))
        ) sub
        WHERE key = p.code || ':' || $2
        LIMIT 1
      ) l ON true
      WHERE p.code <> $1 AND p.spot = $2 AND p.visible_until > $3
    `, [code, spot, now]);

    const matches = candidates.rows.filter(c => {
      const theirWishes = c.wish_tags ? JSON.parse(decrypt(c.wish_tags)) : [];
      return theirWishes.some(w => myWishes.includes(w));
    }).map(c => {
      const theirWishes = c.wish_tags ? JSON.parse(decrypt(c.wish_tags)) : [];
      const common = myWishes.filter(w => theirWishes.includes(w));
      return {
        code: c.code,
        name: decrypt(c.name),
        city: c.city,
        region: c.region,
        commonWishes: common,
        lat: c.lat ? parseFloat(c.lat) : null,
        lng: c.lng ? parseFloat(c.lng) : null
      };
    });
    res.json({ matches });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Matching fehlgeschlagen' });
  }
});

// 2️⃣ Cache-Anfrage senden
app.post('/api/spotcache/request', async (req, res) => {
  const { from, to, wish } = req.body;
  if (!from || !to || !wish) return res.status(400).json({ error: 'Fehlende Felder' });

  try {
    const existing = await pool.query(
      `SELECT id FROM spot_cache_requests
       WHERE from_code = $1 AND to_code = $2 AND wish = $3 AND status IN ('pending','accepted')`,
      [from, to, wish]
    );
    if (existing.rows.length) return res.status(409).json({ error: 'Bereits angefragt' });

    await pool.query(
      `INSERT INTO spot_cache_requests (from_code, to_code, wish, status, created_at)
       VALUES ($1, $2, $3, 'pending', $4)`,
      [from, to, wish, Date.now()]
    );
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Fehler beim Erstellen' });
  }
});

// 3️⃣ Eigene Anfragen anzeigen
app.get('/api/spotcache/requests/:code', async (req, res) => {
  const { code } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT id, from_code AS "from", to_code AS "to", wish, status,
              location_lat AS lat, location_lng AS lng, unlocked_at
       FROM spot_cache_requests
       WHERE (from_code = $1 OR to_code = $1) AND status != 'declined'
       ORDER BY created_at DESC`,
      [code]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Fehler beim Abrufen' });
  }
});

// 4️⃣ Auf Anfrage antworten
app.post('/api/spotcache/respond', async (req, res) => {
  const { id, code, action } = req.body; // action: 'accept' | 'decline'
  if (!id || !code || !['accept', 'decline'].includes(action)) {
    return res.status(400).json({ error: 'Ungültige Parameter' });
  }

  try {
    const request = await pool.query(`SELECT * FROM spot_cache_requests WHERE id = $1`, [id]);
    if (!request.rows.length) return res.status(404).json({ error: 'Nicht gefunden' });

    const reqData = request.rows[0];
    if (reqData.to_code !== code && reqData.from_code !== code) {
      return res.status(403).json({ error: 'Keine Berechtigung' });
    }

    if (action === 'decline') {
      await pool.query(`UPDATE spot_cache_requests SET status = 'declined' WHERE id = $1`, [id]);
      return res.json({ success: true, status: 'declined' });
    }

    // Empfänger akzeptiert
    if (reqData.status === 'pending' && reqData.to_code === code) {
      await pool.query(`UPDATE spot_cache_requests SET status = 'accepted' WHERE id = $1`, [id]);

      // Gegenseitige Anfrage prüfen
      const reciprocal = await pool.query(
        `SELECT id FROM spot_cache_requests
         WHERE from_code = $1 AND to_code = $2 AND wish = $3 AND status = 'accepted'`,
        [reqData.to_code, reqData.from_code, reqData.wish]
      );
      if (reciprocal.rows.length) {
        await unlockCache(reqData, reciprocal.rows[0].id);
      }
      return res.json({ success: true, status: 'accepted' });
    }

    res.status(400).json({ error: 'Ungültiger Zustand' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Fehler' });
  }
});

// Hilfsfunktion: Treffpunkt generieren und beide Requests updaten
async function unlockCache(reqA, reqBId) {
  const latA = reqA.location_lat || 39.47;
  const lngA = reqA.location_lng || -0.38;
  const requestB = await pool.query(
    `SELECT location_lat, location_lng FROM spot_cache_requests WHERE id = $1`,
    [reqBId]
  );
  const latB = requestB.rows[0]?.location_lat || 39.47;
  const lngB = requestB.rows[0]?.location_lng || -0.38;

  const midLat = (latA + latB) / 2;
  const midLng = (lngA + lngB) / 2;
  const offset = 0.01; // ~1 km
  const targetLat = midLat + (Math.random() - 0.5) * offset * 2;
  const targetLng = midLng + (Math.random() - 0.5) * offset * 2;

  const now = Date.now();
  await pool.query(
    `UPDATE spot_cache_requests SET status = 'unlocked', location_lat = $1, location_lng = $2, unlocked_at = $3
     WHERE id IN ($4, $5)`,
    [targetLat, targetLng, now, reqA.id, reqBId]
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// SPOTCACHE V2 – USER SPOTS & EINLADUNGEN
// ══════════════════════════════════════════════════════════════════════════════

// 🟠 Eigenen Spot anlegen
app.post('/api/userspots', async (req, res) => {
  const { code, lat, lng, name, description, wishTag, image } = req.body;
  if (!code || lat == null || lng == null || !name || !wishTag) {
    return res.status(400).json({ error: 'Pflichtfelder: code, lat, lng, name, wishTag' });
  }
  try {
    await pool.query(
      // active=true ist der Standard – jeder neue Spot ist sofort sichtbar
      `INSERT INTO user_spots (code, lat, lng, name, description, wish_tag, image, active, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8)`,
      [code, lat, lng, name, description || null, wishTag, image || null, Date.now()]
    );
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Fehler beim Speichern' });
  }
});

// 🌍 Alle öffentlichen Spots abrufen (für die Karte)
// Nur aktive Spots werden geliefert – deaktivierte Spots sind unsichtbar
app.get('/api/userspots/all', async (req, res) => {
  const noImage = req.query.noimage === '1';
  try {
    const { rows } = await pool.query(
      `SELECT id, code, lat, lng, name, description, wish_tag AS "wishTag",
              ${noImage ? 'NULL AS image' : 'CASE WHEN image_status = \'approved\' THEN image ELSE NULL END AS image'},
              active, created_at
       FROM user_spots
       WHERE active = true
       ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Fehler beim Abrufen' });
  }
});

// 🟠 Eigene Spots abrufen
app.get('/api/userspots/:code', async (req, res) => {
  const { code } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT id, lat, lng, name, description, wish_tag AS "wishTag",
              CASE WHEN image_status = 'approved' THEN image ELSE NULL END AS image,
              created_at
       FROM user_spots WHERE code = $1 ORDER BY created_at DESC`,
      [code]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Fehler beim Abrufen' });
  }
});

// 🟠 Spot löschen
app.put('/api/userspots/:id', async (req, res) => {
  const { id } = req.params;
  const { code, name, description, wishTag, image } = req.body;
  if (!code || !name || !wishTag) {
    return res.status(400).json({ error: 'code, name, wishTag erforderlich' });
  }
  try {
    // Eigentümer prüfen
    const check = await pool.query('SELECT code FROM user_spots WHERE id = $1', [id]);
    if (!check.rows.length) return res.status(404).json({ error: 'Nicht gefunden' });
    if (check.rows[0].code !== code) return res.status(403).json({ error: 'Keine Berechtigung' });

    // Neues Bild → pending, kein neues Bild → Status beibehalten
    if (image) {
      await pool.query(
        `UPDATE user_spots SET name=$1, description=$2, wish_tag=$3, image=$4, image_status='pending' WHERE id=$5`,
        [name, description||null, wishTag, image, id]
      );
    } else {
      await pool.query(
        `UPDATE user_spots SET name=$1, description=$2, wish_tag=$3 WHERE id=$4`,
        [name, description||null, wishTag, id]
      );
    }
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Fehler beim Aktualisieren' });
  }
});

app.delete('/api/userspots/:id', async (req, res) => {
  const { id } = req.params;
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code fehlt' });
  try {
    await pool.query('DELETE FROM user_spots WHERE id = $1 AND code = $2', [id, code]);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Fehler beim Löschen' });
  }
});

// ⏸ Spot deaktivieren / reaktivieren (Soft Delete)
// PATCH statt DELETE – wir ändern nur den active-Status, löschen nichts.
// Der Spot bleibt in der Datenbank erhalten und kann jederzeit reaktiviert werden.
// Auf der Karte und in der Spot-Liste erscheint er solange active=false ist nicht mehr.
app.patch('/api/userspots/:id/toggle', async (req, res) => {
  const { id }          = req.params;
  const { code, token } = req.body;

  if (!code || !token) {
    return res.status(400).json({ error: 'Code und Token erforderlich' });
  }

  try {
    // Sicherheits-Check 1: Gehört dieser Spot wirklich diesem Nutzer?
    // Wir prüfen gleichzeitig ob der Spot überhaupt existiert.
    const check = await pool.query(
      `SELECT active FROM user_spots WHERE id = $1 AND code = $2`,
      [id, code]
    );
    if (!check.rows.length) {
      return res.status(403).json({ error: 'Nicht berechtigt oder Spot nicht gefunden' });
    }

    // Sicherheits-Check 2: Ist das Token gültig?
    // Ein gestohlener Code allein reicht nicht aus – das Token muss stimmen.
    const auth = await pool.query(
      `SELECT token FROM profiles WHERE code = $1 AND spot = 'caching'`,
      [code]
    );
    if (!auth.rows.length || auth.rows[0].token !== token) {
      return res.status(403).json({ error: 'Ungültiger Token' });
    }

    // Status umkehren: true → false, false → true
    // Das NOT in SQL funktioniert wie das ! in JavaScript
    const result = await pool.query(
      `UPDATE user_spots
       SET active = NOT active
       WHERE id = $1 AND code = $2
       RETURNING active`,
      [id, code]
    );

    const newStatus = result.rows[0].active;
    console.log(`🔄 Spot ${id} (${code}): ${newStatus ? '▶ aktiviert' : '⏸ deaktiviert'}`);
    res.json({ success: true, active: newStatus });

  } catch (e) {
    console.error('PATCH /api/userspots/toggle:', e.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// 🟣 Gemeinsame Spots finden (gleicher Wunsch + Nähe)
app.get('/api/userspots/common/:code1/:code2', async (req, res) => {
  const { code1, code2 } = req.params;
  try {
    const { rows } = await pool.query(`
      SELECT s1.id AS "spot1Id", s1.lat, s1.lng,
             s1.name AS "spotName", s1.description AS "spotDesc",
             s1.wish_tag AS "wishTag", s1.code AS "creatorCode"
      FROM user_spots s1
      JOIN user_spots s2 ON s1.wish_tag = s2.wish_tag
      WHERE s1.code = $1 AND s2.code = $2
        AND ABS(s1.lat - s2.lat) < 0.02
        AND ABS(s1.lng - s2.lng) < 0.02
      ORDER BY s1.created_at DESC
    `, [code1, code2]);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Fehler bei der Suche' });
  }
});


// 📨 Treffpunkt-Einladung senden
app.post('/api/spotcache/invite', async (req, res) => {
  const { from, to } = req.body;
  const spotId    = req.body.spot_id    || req.body.spotId;
  const timeStart = req.body.time_start || req.body.timeStart;
  const timeEnd   = req.body.time_end   || req.body.timeEnd;

  if (!from || !to || !spotId || !timeStart || !timeEnd) {
    return res.status(400).json({ error: 'Fehlende Felder' });
  }

  try {
    // Schritt 1: Alte Einladungen für diesen Spot archivieren.
    // Wir prüfen BEIDE Richtungen (A→B und B→A) weil Einladungen
    // symmetrisch sind – es ist egal wer wen zuerst eingeladen hat.
    // Wir archivieren sowohl 'accepted' als auch 'pending' Einladungen,
    // damit der UNIQUE-Constraint für den INSERT frei wird.
    await pool.query(
      `UPDATE spot_cache_invites
       SET status = 'expired'
       WHERE spot_id = $1
         AND (
           (from_code = $2 AND to_code = $3) OR
           (from_code = $3 AND to_code = $2)
         )
         AND status IN ('accepted', 'pending')
         AND time_end < $4`,
      [spotId, from, to, Date.now()]
    );

    // Schritt 2: Neue Einladung einfügen.
    // ON CONFLICT als Sicherheitsnetz – falls doch noch ein Konflikt
    // entsteht (z.B. Race Condition), wird die bestehende Einladung
    // mit den neuen Zeitwerten aktualisiert statt einen Fehler zu werfen.
    await pool.query(
      `INSERT INTO spot_cache_invites
         (from_code, to_code, spot_id, time_start, time_end, status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6)
       ON CONFLICT (from_code, to_code, spot_id)
       DO UPDATE SET
         time_start = EXCLUDED.time_start,
         time_end   = EXCLUDED.time_end,
         status     = 'pending',
         created_at = EXCLUDED.created_at`,
      [from, to, spotId, timeStart, timeEnd, Date.now()]
    );

    res.json({ success: true });

  } catch (e) {
    console.error('POST /api/spotcache/invite:', e.message);
    res.status(500).json({ error: 'Fehler beim Einladen' });
  }
});


// 📨 Einladung beantworten
app.post('/api/spotcache/invite/respond', async (req, res) => {
  const { id, code, action } = req.body;
  if (!id || !code || !['accept','decline'].includes(action)) {
    return res.status(400).json({ error: 'Ungültige Parameter' });
  }
  try {
    const invite = await pool.query('SELECT * FROM spot_cache_invites WHERE id = $1', [id]);
    if (!invite.rows.length) return res.status(404).json({ error: 'Nicht gefunden' });
    const inv = invite.rows[0];
    if (inv.to_code !== code) return res.status(403).json({ error: 'Keine Berechtigung' });

    if (action === 'decline') {
      await pool.query(`UPDATE spot_cache_invites SET status = 'declined' WHERE id = $1`, [id]);
      return res.json({ success: true, status: 'declined' });
    }

    await pool.query(`UPDATE spot_cache_invites SET status = 'accepted' WHERE id = $1`, [id]);
    res.json({ success: true, status: 'accepted' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Fehler' });
  }
});

// ❌ Einladung stornieren
// Sowohl Sender (from_code) als auch Empfänger (to_code) dürfen stornieren.
// Der Partner bekommt automatisch eine System-Nachricht damit er informiert ist.
// Wir setzen status = 'cancelled' statt zu löschen – so bleibt die Historie erhalten.
app.patch('/api/spotcache/invite/:id/cancel', async (req, res) => {
  const { id }          = req.params;
  const { code, token } = req.body;

  if (!code || !token) {
    return res.status(400).json({ error: 'Code und Token erforderlich' });
  }

  try {
    // Einladung laden und prüfen ob der anfragende Nutzer beteiligt ist.
    // Sowohl Sender als auch Empfänger dürfen stornieren.
    const inv = await pool.query(
      `SELECT i.*, u.name AS spot_name
       FROM spot_cache_invites i
       LEFT JOIN user_spots u ON u.id = i.spot_id
       WHERE i.id = $1 AND (i.from_code = $2 OR i.to_code = $2)`,
      [id, code]
    );
    if (!inv.rows.length) {
      return res.status(403).json({ error: 'Nicht berechtigt oder nicht gefunden' });
    }

    // Token validieren – ein gestohlener Code allein reicht nicht
    const auth = await pool.query(
      `SELECT token FROM profiles WHERE code = $1 AND spot = 'caching'`,
      [code]
    );
    if (!auth.rows.length || auth.rows[0].token !== token) {
      return res.status(403).json({ error: 'Ungültiger Token' });
    }

    const invite   = inv.rows[0];
    const spotName = invite.spot_name || 'Spot';

    // Nur aktive Einladungen können storniert werden –
    // abgelaufene oder bereits abgelehnte brauchen keine Stornierung mehr
    if (['expired', 'cancelled', 'declined', 'completed'].includes(invite.status)) {
      return res.status(400).json({ error: 'Diese Einladung kann nicht mehr storniert werden' });
    }

    // Status auf 'cancelled' setzen
    await pool.query(
      `UPDATE spot_cache_invites SET status = 'cancelled' WHERE id = $1`,
      [id]
    );

    // Partner bestimmen: wenn ich der Sender bin, ist der Partner der Empfänger und umgekehrt
    const partnerCode = invite.from_code === code
      ? invite.to_code
      : invite.from_code;

    // System-Nachricht an den Partner schicken damit er informiert wird.
    // spot_type = 'system' unterscheidet diese Nachricht von normalen Chat-Nachrichten –
    // das Frontend kann sie dann anders darstellen (z.B. grau und kursiv)
    await pool.query(
      `INSERT INTO offline_messages
         (recipient, sender_code, sender_name, message, spot_type)
       VALUES ($1, $2, $3, $4, 'system')`,
      [
        partnerCode,
        code,
        'System',
        `❌ Das Treffen bei "${spotName}" wurde storniert.`
      ]
    );

    console.log(`❌ Einladung ${id} storniert von ${code} → Partner ${partnerCode} informiert`);
    res.json({ success: true });

  } catch (e) {
    console.error('PATCH /cancel:', e.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// FAVORITEN – Öffentliche Spot-Kategorien ohne Einladungspflicht
// ══════════════════════════════════════════════════════════════════════════════

// ⭐ Favorit hinzufügen
app.post('/api/favorites', async (req, res) => {
  const { code, spot_id } = req.body;
  if (!code || !spot_id) return res.status(400).json({ error: 'code und spot_id erforderlich' });
  try {
    await pool.query(
      `INSERT INTO spot_favorites (code, spot_id, created_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (code, spot_id) DO NOTHING`,
      [code, spot_id, Date.now()]
    );
    res.json({ success: true });
  } catch (e) {
    console.error('POST /api/favorites:', e.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// ⭐ Favorit entfernen
app.delete('/api/favorites/:spotId', async (req, res) => {
  const { spotId } = req.params;
  const { code }   = req.body;
  if (!code) return res.status(400).json({ error: 'code erforderlich' });
  try {
    await pool.query(
      `DELETE FROM spot_favorites WHERE code = $1 AND spot_id = $2`,
      [code, spotId]
    );
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /api/favorites:', e.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// ⭐ Alle Favoriten eines Nutzers abrufen – mit Spot-Details und letztem Check-in
app.get('/api/favorites/:code', async (req, res) => {
  const { code } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT f.spot_id,
              u.name      AS spot_name,
              u.lat, u.lng,
              u.wish_tag  AS "wishTag",
              u.code      AS owner_code,
              -- Letzter Check-in an diesem Spot (aus verifications)
              v.created_at AS last_checkin,
              v.from_code  AS last_checkin_code,
              p.name       AS last_checkin_name_enc
       FROM spot_favorites f
       JOIN user_spots u ON u.id = f.spot_id
       -- Neuester Check-in pro Spot – LATERAL macht das effizient
       LEFT JOIN LATERAL (
         SELECT from_code, created_at
         FROM verifications
         WHERE to_code = u.code AND to_spot = 'caching' AND type = 'personal'
         ORDER BY created_at DESC
         LIMIT 1
       ) v ON true
       LEFT JOIN profiles p ON p.code = v.from_code AND p.spot = 'caching'
       WHERE f.code = $1
         AND u.active = true
       ORDER BY f.created_at DESC`,
      [code]
    );
    res.json(rows.map(r => ({
      ...r,
      last_checkin_name: r.last_checkin_name_enc ? decrypt(r.last_checkin_name_enc) : null,
      last_checkin_name_enc: undefined,
    })));
  } catch (e) {
    console.error('GET /api/favorites:', e.message);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// ⭐ Prüfen ob ein Spot bereits als Favorit gespeichert ist (für den ⭐-Button)
app.get('/api/favorites/:code/:spotId', async (req, res) => {
  const { code, spotId } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM spot_favorites WHERE code = $1 AND spot_id = $2`,
      [code, spotId]
    );
    res.json({ isFavorite: rows.length > 0 });
  } catch (e) {
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// 📍 Einchecken am Treffpunkt
app.post('/api/spotcache/checkin', async (req, res) => {
  const { id, code, lat, lng } = req.body;
  if (!id || !code || lat == null || lng == null) return res.status(400).json({ error: 'Fehlende Felder' });

  try {
    const invite = await pool.query('SELECT * FROM spot_cache_invites WHERE id = $1', [id]);
    if (!invite.rows.length) return res.status(404).json({ error: 'Nicht gefunden' });
    const inv = invite.rows[0];
    if (inv.from_code !== code && inv.to_code !== code) return res.status(403).json({ error: 'Keine Berechtigung' });
    if (inv.status !== 'accepted') return res.status(400).json({ error: 'Noch nicht akzeptiert' });

    const now = Date.now();
    if (now < inv.time_start || now > inv.time_end) return res.status(400).json({ error: 'Außerhalb des Zeitfensters' });

    // 50m‑Radius prüfen
    const spot = await pool.query('SELECT lat, lng FROM user_spots WHERE id = $1', [inv.spot_id]);
    const dist = Math.sqrt(Math.pow(lat - spot.rows[0].lat, 2) + Math.pow(lng - spot.rows[0].lng, 2)) * 111000;
    if (dist > 50) return res.status(400).json({ error: 'Nicht nah genug am Spot (50m)' });

    const isFrom = inv.from_code === code;
    await pool.query(
      `UPDATE spot_cache_invites SET ${isFrom ? 'checked_in_from' : 'checked_in_to'} = TRUE WHERE id = $1`,
      [id]
    );

    const updated = await pool.query('SELECT * FROM spot_cache_invites WHERE id = $1', [id]);
    const u = updated.rows[0];
    if (u.checked_in_from && u.checked_in_to) {
      await pool.query(`UPDATE spot_cache_invites SET status = 'completed' WHERE id = $1`, [id]);

      // ✅ Echtheits‑Verifikation
      const nowTS = Date.now();
      await pool.query(
        `INSERT INTO verifications (to_code, to_spot, from_code, type, created_at)
         VALUES ($1, 'caching', $2, 'personal', $3)
         ON CONFLICT (to_code, to_spot, from_code, type) DO NOTHING`,
        [inv.from_code, inv.to_code, nowTS]
      );
      await pool.query(
        `INSERT INTO verifications (to_code, to_spot, from_code, type, created_at)
         VALUES ($1, 'caching', $2, 'personal', $3)
         ON CONFLICT (to_code, to_spot, from_code, type) DO NOTHING`,
        [inv.to_code, inv.from_code, nowTS]
      );

      return res.json({ success: true, bothCheckedIn: true, message: 'Ihr habt euch gefunden!' });
    }

    // ⭐ Favoriten benachrichtigen wenn jemand an diesem Spot eincheckt.
    // Wir holen alle Nutzer die diesen Spot als Favorit gespeichert haben,
    // ausgenommen die beiden die gerade am Treffen beteiligt sind –
    // die wissen bereits dass jemand da ist.
    try {
      const spotData = await pool.query(
        `SELECT name FROM user_spots WHERE id = $1`, [inv.spot_id]
      );
      const spotName = spotData.rows[0]?.name || 'Spot';

      const favorites = await pool.query(
        `SELECT code FROM spot_favorites
         WHERE spot_id = $1
           AND code != $2
           AND code != $3`,
        [inv.spot_id, inv.from_code, inv.to_code]
      );

      // Für jeden Favoriten eine stille Benachrichtigung schicken
      for (const fav of favorites.rows) {
        await pool.query(
          `INSERT INTO offline_messages
             (recipient, sender_code, sender_name, message, spot_type)
           VALUES ($1, $2, $3, $4, 'favorite_checkin')`,
          [
            fav.code,
            code,
            'SpotMe',
            `⭐ Jemand ist gerade bei "${spotName}" eingecheckt!`
          ]
        );
      }
      if (favorites.rows.length > 0) {
        console.log(`⭐ ${favorites.rows.length} Favoriten über Check-in bei Spot ${inv.spot_id} benachrichtigt`);
      }
    } catch (e) {
      // Benachrichtigungs-Fehler soll den Check-in nicht blockieren
      console.error('Favorites notify error:', e.message);
    }

    res.json({ success: true, bothCheckedIn: false });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Fehler beim Einchecken' });
  }
});

app.get('/api/admin/pending-spot-images', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, code, name, description, wish_tag, image, image_status, created_at
       FROM user_spots
       WHERE image IS NOT NULL AND (image_status = 'pending' OR image_status IS NULL)
       ORDER BY created_at ASC`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

app.post('/api/admin/spot-image-action', requireAdmin, async (req, res) => {
  const { id, action } = req.body;
  if (!id || !['approve','reject'].includes(action)) {
    return res.status(400).json({ error: 'id und action (approve/reject) erforderlich' });
  }
  try {
    if (action === 'approve') {
      await pool.query(
        `UPDATE user_spots SET image_status = 'approved' WHERE id = $1`, [id]
      );
      console.log(`✅ Spot-Bild freigegeben: ID ${id}`);
    } else {
      await pool.query(
        `UPDATE user_spots SET image = NULL, image_status = NULL WHERE id = $1`, [id]
      );
      console.log(`❌ Spot-Bild abgelehnt & gelöscht: ID ${id}`);
    }
    res.json({ success: true, action, id });
  } catch (e) {
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// PING & START
// ══════════════════════════════════════════════════════════════════════════════

app.all('/ping',     (req, res) => res.status(204).end());
app.all('/api/ping', (req, res) => res.status(204).end());
app.get('/',         (req, res) => res.send('SpotMe PG-Server läuft ✅'));

const PORT = process.env.PORT || 3000;

initDB()
  .then(() => {
    server.listen(PORT, () => console.log(`🚀 Server läuft auf Port ${PORT}`));
  })
  .catch(e => {
    console.error('❌ DB-Initialisierung fehlgeschlagen:', e.message);
    process.exit(1);
  });
