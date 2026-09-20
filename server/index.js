const path = require('path');
const crypto = require('crypto');
const express = require('express');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const APP_PASSWORD = process.env.APP_PASSWORD || '';

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ---------- optional PIN auth (defense in depth on top of Tailscale) ----------
const validTokens = new Set();

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  });
  return out;
}

if (APP_PASSWORD) {
  app.get('/login', (req, res) => {
    res.type('html').send(`<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ログイン - Poker Memo</title>
<style>body{font-family:system-ui,sans-serif;background:#0b3d2e;color:#fff;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
form{background:#123;padding:24px;border-radius:12px;width:min(320px,90vw)}
input{width:100%;padding:12px;font-size:16px;border-radius:8px;border:none;margin-top:8px;box-sizing:border-box}
button{width:100%;padding:12px;font-size:16px;border-radius:8px;border:none;margin-top:16px;background:#2e7d55;color:#fff;font-weight:bold}
h1{font-size:18px;margin:0 0 8px}
.err{color:#ffb4b4;margin-top:8px}
</style></head><body>
<form method="post" action="/login">
<h1>Poker Memo</h1>
<label>パスワード<input type="password" name="password" autofocus></label>
${req.query.error ? '<div class="err">パスワードが違います</div>' : ''}
<button type="submit">入室</button>
</form></body></html>`);
  });

  app.post('/login', (req, res) => {
    if (req.body && req.body.password === APP_PASSWORD) {
      const token = crypto.randomBytes(24).toString('hex');
      validTokens.add(token);
      res.setHeader('Set-Cookie', `pm_auth=${token}; HttpOnly; SameSite=Lax; Max-Age=2592000; Path=/`);
      res.redirect('/');
    } else {
      res.redirect('/login?error=1');
    }
  });

  app.get('/logout', (req, res) => {
    const { pm_auth } = parseCookies(req);
    if (pm_auth) validTokens.delete(pm_auth);
    res.setHeader('Set-Cookie', 'pm_auth=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/');
    res.redirect('/login');
  });

  app.use((req, res, next) => {
    const { pm_auth } = parseCookies(req);
    if (pm_auth && validTokens.has(pm_auth)) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
    return res.redirect('/login');
  });
}

app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- helpers ----------
const now = () => new Date().toISOString();

function getSessionSummary(id) {
  return db.prepare(`
    SELECT s.*, (SELECT COUNT(*) FROM hands h WHERE h.session_id = s.id) AS hand_count
    FROM sessions s WHERE s.id = ?
  `).get(id);
}

function getHandDetail(handId) {
  const hand = db.prepare('SELECT * FROM hands WHERE id = ?').get(handId);
  if (!hand) return null;
  const participants = db.prepare(`
    SELECT hp.player_id, hp.hole_cards, hp.folded, p.name, p.is_me, p.seat_order
    FROM hand_players hp JOIN players p ON p.id = hp.player_id
    WHERE hp.hand_id = ? ORDER BY p.seat_order ASC
  `).all(handId);
  const actions = db.prepare(`
    SELECT * FROM actions WHERE hand_id = ? ORDER BY seq ASC
  `).all(handId);
  return { hand, participants, actions };
}

// ---------- sessions ----------
app.get('/api/sessions', (req, res) => {
  const rows = db.prepare(`
    SELECT s.*, (SELECT COUNT(*) FROM hands h WHERE h.session_id = s.id) AS hand_count
    FROM sessions s ORDER BY s.created_at DESC
  `).all();
  res.json(rows);
});

app.post('/api/sessions', (req, res) => {
  const { title, small_blind, big_blind, players } = req.body || {};
  if (!title || !Array.isArray(players) || players.length === 0) {
    return res.status(400).json({ error: 'title and at least one player are required' });
  }
  const insertSession = db.prepare(`
    INSERT INTO sessions (title, small_blind, big_blind, memo, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertPlayer = db.prepare(`
    INSERT INTO players (session_id, name, seat_order, is_me) VALUES (?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    const info = insertSession.run(title, small_blind || null, big_blind || null, null, now());
    const sessionId = info.lastInsertRowid;
    players.forEach((p, i) => {
      insertPlayer.run(sessionId, String(p.name || `プレイヤー${i + 1}`).trim(), i, p.is_me ? 1 : 0);
    });
    return sessionId;
  });
  const sessionId = tx();
  const session = getSessionSummary(sessionId);
  const playerRows = db.prepare('SELECT * FROM players WHERE session_id = ? ORDER BY seat_order ASC').all(sessionId);
  res.status(201).json({ session, players: playerRows });
});

app.get('/api/sessions/:id', (req, res) => {
  const session = getSessionSummary(req.params.id);
  if (!session) return res.status(404).json({ error: 'not found' });
  const players = db.prepare('SELECT * FROM players WHERE session_id = ? ORDER BY seat_order ASC').all(req.params.id);
  const hands = db.prepare('SELECT * FROM hands WHERE session_id = ? ORDER BY hand_no ASC').all(req.params.id);
  res.json({ session, players, hands });
});

app.delete('/api/sessions/:id', (req, res) => {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

app.post('/api/sessions/:id/players', (req, res) => {
  const { name, is_me } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
  const session = getSessionSummary(req.params.id);
  if (!session) return res.status(404).json({ error: 'not found' });
  const maxSeat = db.prepare('SELECT COALESCE(MAX(seat_order), -1) AS m FROM players WHERE session_id = ?').get(req.params.id).m;
  const info = db.prepare('INSERT INTO players (session_id, name, seat_order, is_me) VALUES (?, ?, ?, ?)')
    .run(req.params.id, String(name).trim(), maxSeat + 1, is_me ? 1 : 0);
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(player);
});

// ---------- hands ----------
app.post('/api/sessions/:id/hands', (req, res) => {
  const session = getSessionSummary(req.params.id);
  if (!session) return res.status(404).json({ error: 'not found' });
  const { participant_player_ids, dealer_player_id } = req.body || {};
  if (!Array.isArray(participant_player_ids) || participant_player_ids.length === 0) {
    return res.status(400).json({ error: 'participant_player_ids is required' });
  }
  const tx = db.transaction(() => {
    const maxHandNo = db.prepare('SELECT COALESCE(MAX(hand_no), 0) AS m FROM hands WHERE session_id = ?').get(req.params.id).m;
    const info = db.prepare(`
      INSERT INTO hands (session_id, hand_no, dealer_player_id, created_at)
      VALUES (?, ?, ?, ?)
    `).run(req.params.id, maxHandNo + 1, dealer_player_id || null, now());
    const handId = info.lastInsertRowid;
    const insertHp = db.prepare('INSERT INTO hand_players (hand_id, player_id) VALUES (?, ?)');
    participant_player_ids.forEach((pid) => insertHp.run(handId, pid));
    return handId;
  });
  const handId = tx();
  res.status(201).json(getHandDetail(handId));
});

app.get('/api/hands/:id', (req, res) => {
  const detail = getHandDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: 'not found' });
  res.json(detail);
});

app.patch('/api/hands/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM hands WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const fields = ['board_flop', 'board_turn', 'board_river', 'pot_size', 'winner_player_id', 'memo'];
  const updates = [];
  const values = [];
  fields.forEach((f) => {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, f)) {
      updates.push(`${f} = ?`);
      values.push(req.body[f]);
    }
  });
  if (updates.length) {
    values.push(req.params.id);
    db.prepare(`UPDATE hands SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }
  res.json(getHandDetail(req.params.id));
});

app.delete('/api/hands/:id', (req, res) => {
  db.prepare('DELETE FROM hands WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

app.patch('/api/hands/:handId/players/:playerId', (req, res) => {
  const { hole_cards } = req.body || {};
  const info = db.prepare('UPDATE hand_players SET hole_cards = ? WHERE hand_id = ? AND player_id = ?')
    .run(hole_cards || null, req.params.handId, req.params.playerId);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json(getHandDetail(req.params.handId));
});

// ---------- actions ----------
app.post('/api/hands/:id/actions', (req, res) => {
  const hand = db.prepare('SELECT * FROM hands WHERE id = ?').get(req.params.id);
  if (!hand) return res.status(404).json({ error: 'not found' });
  const { player_id, street, action_type, amount } = req.body || {};
  const validStreets = ['preflop', 'flop', 'turn', 'river'];
  const validActions = ['fold', 'check', 'call', 'bet', 'raise', 'allin'];
  if (!player_id || !validStreets.includes(street) || !validActions.includes(action_type)) {
    return res.status(400).json({ error: 'invalid action' });
  }
  const tx = db.transaction(() => {
    const maxSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM actions WHERE hand_id = ?').get(req.params.id).m;
    const info = db.prepare(`
      INSERT INTO actions (hand_id, player_id, street, seq, action_type, amount, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(req.params.id, player_id, street, maxSeq + 1, action_type, amount || null, now());
    if (action_type === 'fold') {
      db.prepare('UPDATE hand_players SET folded = 1 WHERE hand_id = ? AND player_id = ?').run(req.params.id, player_id);
    }
    return info.lastInsertRowid;
  });
  tx();
  res.status(201).json(getHandDetail(req.params.id));
});

app.delete('/api/actions/:id', (req, res) => {
  const action = db.prepare('SELECT * FROM actions WHERE id = ?').get(req.params.id);
  if (!action) return res.status(404).json({ error: 'not found' });
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM actions WHERE id = ?').run(req.params.id);
    if (action.action_type === 'fold') {
      const remainingFold = db.prepare(`
        SELECT COUNT(*) AS c FROM actions WHERE hand_id = ? AND player_id = ? AND action_type = 'fold'
      `).get(action.hand_id, action.player_id).c;
      if (remainingFold === 0) {
        db.prepare('UPDATE hand_players SET folded = 0 WHERE hand_id = ? AND player_id = ?').run(action.hand_id, action.player_id);
      }
    }
  });
  tx();
  res.json(getHandDetail(action.hand_id));
});

app.listen(PORT, HOST, () => {
  console.log(`Poker Memo server listening on http://${HOST}:${PORT}`);
  if (!APP_PASSWORD) {
    console.log('APP_PASSWORD is not set - no login gate (rely on Tailscale/LAN isolation).');
  }
});
