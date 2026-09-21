const path = require('path');
const crypto = require('crypto');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('./db');

let anthropicClient = null;
function getAnthropicClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!anthropicClient) anthropicClient = new Anthropic();
  return anthropicClient;
}

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
<title>ログイン - Notes</title>
<style>body{font-family:system-ui,sans-serif;background:#20242b;color:#fff;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
form{background:#2a2f38;padding:24px;border-radius:12px;width:min(320px,90vw)}
input{width:100%;padding:12px;font-size:16px;border-radius:8px;border:none;margin-top:8px;box-sizing:border-box}
button{width:100%;padding:12px;font-size:16px;border-radius:8px;border:none;margin-top:16px;background:#4a5568;color:#fff;font-weight:bold}
h1{font-size:18px;margin:0 0 8px}
.err{color:#ffb4b4;margin-top:8px}
</style></head><body>
<form method="post" action="/login">
<h1>Notes</h1>
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

// ---------- seat / rotation helpers ----------
const now = () => new Date().toISOString();
const SEAT_COUNT = 9;
const STREET_ORDER = ['preflop', 'flop', 'turn', 'river'];

function seatLabel(seatNo) {
  return seatNo === 0 ? '自分' : String.fromCharCode(64 + seatNo); // 1->A .. 8->H
}

// The button (and the action) moves clockwise around the table. Seat labels
// A-H are placed counter-clockwise from "me" (see seatSlot() on the client),
// so clockwise movement means walking seat_no DOWN, not up.
function stepClockwise(seatNo, steps) {
  return ((seatNo - steps) % SEAT_COUNT + SEAT_COUNT) % SEAT_COUNT;
}

// Walk clockwise starting just after `fromSeatNo`, return the first seat_no
// whose status is 'active'. Returns null if none found.
function nextActiveSeatNo(seatsByNo, fromSeatNo) {
  for (let i = 1; i <= SEAT_COUNT; i += 1) {
    const candidate = stepClockwise(fromSeatNo, i);
    if (seatsByNo[candidate] && seatsByNo[candidate].status === 'active') return candidate;
  }
  return null;
}

// Ordered list of seat_nos present in a hand, walking clockwise from the dealer.
// ring[0] = dealer, ring[1] = SB, ring[2] = BB (heads-up: ring[0] is SB, ring[1] is BB).
function ringFromDealer(dealerSeatNo, seatNosInHand) {
  const set = new Set(seatNosInHand);
  const ring = [];
  for (let i = 0; i < SEAT_COUNT; i += 1) {
    const s = stepClockwise(dealerSeatNo, i);
    if (set.has(s)) ring.push(s);
  }
  return ring;
}

function computeActionOrder(street, dealerSeatNo, seatNosInHand) {
  const ring = ringFromDealer(dealerSeatNo, seatNosInHand);
  const n = ring.length;
  if (n < 2) return ring;
  if (n === 2) {
    // heads-up: dealer is SB and acts first preflop, last postflop
    return street === 'preflop' ? ring : [ring[1], ring[0]];
  }
  // ring[0]=dealer, ring[1]=SB, ring[2]=BB; UTG is ring[3] and acts first preflop,
  // with dealer/SB/BB acting last (BB last of all, since they have the option).
  if (street === 'preflop') return [...ring.slice(3), ring[0], ring[1], ring[2]];
  return [...ring.slice(1), ring[0]];
}

// Who has to act next in a street, given the rotation order (seat_ids, already
// excluding seats that folded before this street) and the actions taken so far
// in that street. A bet/raise/allin reopens the action for everyone else who
// hasn't folded; fold/check/call only clears the actor themselves. The next
// actor is found by walking forward from whoever acted last, not by seat_no,
// so a reopened round continues past the raiser rather than jumping back to
// the earliest seat in the rotation.
function computeCurrentActor(order, streetActions) {
  const n = order.length;
  if (n < 2) return null;
  const folded = new Set();
  const allIn = new Set(); // once all-in, a seat never needs to act again this hand
  let needsAction = new Set(order);
  let lastActorIdx = -1;
  streetActions.forEach((a) => {
    const idx = order.indexOf(a.seat_id);
    if (idx === -1) return;
    if (a.action_type === 'fold') {
      folded.add(a.seat_id);
      needsAction.delete(a.seat_id);
    } else if (a.action_type === 'allin') {
      allIn.add(a.seat_id);
      needsAction = new Set(order.filter((s) => s !== a.seat_id && !folded.has(s) && !allIn.has(s)));
    } else if (['bet', 'raise'].includes(a.action_type)) {
      needsAction = new Set(order.filter((s) => s !== a.seat_id && !folded.has(s) && !allIn.has(s)));
    } else {
      needsAction.delete(a.seat_id);
    }
    lastActorIdx = idx;
  });
  const remainingUnfolded = order.filter((s) => !folded.has(s));
  if (remainingUnfolded.length <= 1 || needsAction.size === 0) return null;
  const start = lastActorIdx === -1 ? 0 : (lastActorIdx + 1) % n;
  for (let i = 0; i < n; i += 1) {
    const seat = order[(start + i) % n];
    if (needsAction.has(seat) && !folded.has(seat) && !allIn.has(seat)) return seat;
  }
  return null;
}

// ---------- shared row loaders ----------
function getSessionSummary(id) {
  return db.prepare(`
    SELECT s.*, (SELECT COUNT(*) FROM hands h WHERE h.session_id = s.id) AS hand_count
    FROM sessions s WHERE s.id = ?
  `).get(id);
}

function getSeats(sessionId) {
  const rows = db.prepare('SELECT * FROM seats WHERE session_id = ? ORDER BY seat_no ASC').all(sessionId);
  return rows.map((r) => ({ ...r, label: seatLabel(r.seat_no) }));
}

function getSessionDetail(sessionId) {
  const session = getSessionSummary(sessionId);
  if (!session) return null;
  const seats = getSeats(sessionId);
  const hands = db.prepare('SELECT * FROM hands WHERE session_id = ? ORDER BY hand_no ASC').all(sessionId);
  const activeSeatNos = seats.filter((s) => s.status === 'active').map((s) => s.seat_no);
  let sbSeatNo = null;
  let bbSeatNo = null;
  if (activeSeatNos.length >= 2) {
    const ring = ringFromDealer(session.dealer_seat, activeSeatNos);
    sbSeatNo = ring.length === 2 ? ring[0] : ring[1];
    bbSeatNo = ring.length === 2 ? ring[1] : ring[2];
  }
  const openHand = hands.find((h) => !h.finished);
  return {
    session, seats, hands, sb_seat_no: sbSeatNo, bb_seat_no: bbSeatNo,
    open_hand_id: openHand ? openHand.id : null,
  };
}

function currentStreetForHand(hand) {
  if (!hand.board_flop) return 'preflop';
  if (!hand.board_turn) return 'flop';
  if (!hand.board_river) return 'turn';
  return 'river';
}

// Running pot + the amount currently facing each player, so the client can
// offer BB-multiple / pot-percentage / facing-bet-multiple quick sizing
// buttons instead of forcing manual chip counting.
function computePotInfo(session, hand, seatNosInHand, actions) {
  const sbAmount = session.small_blind || 0;
  const bbAmount = session.big_blind || 0;
  const ring = ringFromDealer(hand.dealer_seat_no, seatNosInHand);
  let sbSeatNo = null;
  let bbSeatNo = null;
  if (ring.length === 2) { [sbSeatNo, bbSeatNo] = ring; } else if (ring.length >= 3) { [, sbSeatNo, bbSeatNo] = ring; }

  const liveStreet = currentStreetForHand(hand);
  let pot = 0;
  let facingBet = 0;
  let streetContrib = {};
  for (const street of STREET_ORDER) {
    streetContrib = {};
    facingBet = 0;
    if (street === 'preflop') {
      if (sbSeatNo !== null) { streetContrib[sbSeatNo] = sbAmount; pot += sbAmount; }
      if (bbSeatNo !== null) { streetContrib[bbSeatNo] = (streetContrib[bbSeatNo] || 0) + bbAmount; pot += bbAmount; }
      facingBet = bbAmount;
    }
    actions.filter((a) => a.street === street).forEach((a) => {
      const already = streetContrib[a.seat_no] || 0;
      if (a.action_type === 'fold' || a.action_type === 'check') return;
      if (a.action_type === 'call') {
        const add = Math.max(facingBet - already, 0);
        pot += add;
        streetContrib[a.seat_no] = already + add;
      } else {
        const amt = a.amount != null ? a.amount : facingBet;
        const add = Math.max(amt - already, 0);
        pot += add;
        streetContrib[a.seat_no] = already + add;
        facingBet = Math.max(facingBet, amt);
      }
    });
    if (street === liveStreet) break;
  }
  return {
    pot, facing_bet: facingBet, sb_amount: sbAmount, bb_amount: bbAmount,
    sb_seat_no: sbSeatNo, bb_seat_no: bbSeatNo, street_contrib: streetContrib,
  };
}

function getHandDetail(handId) {
  const hand = db.prepare('SELECT * FROM hands WHERE id = ?').get(handId);
  if (!hand) return null;
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(hand.session_id);
  const participants = db.prepare(`
    SELECT hs.seat_id, hs.hole_cards, hs.folded, hs.generation, se.seat_no, se.status, se.memo, se.stack
    FROM hand_seats hs JOIN seats se ON se.id = hs.seat_id
    WHERE hs.hand_id = ? ORDER BY se.seat_no ASC
  `).all(handId).map((p) => ({ ...p, label: seatLabel(p.seat_no), is_me: p.seat_no === 0 }));
  const actionsRaw = db.prepare('SELECT * FROM actions WHERE hand_id = ? ORDER BY seq ASC').all(handId);

  const seatNoToId = {};
  const seatIdToNo = {};
  const seatNoToStatus = {};
  participants.forEach((p) => {
    seatNoToId[p.seat_no] = p.seat_id;
    seatIdToNo[p.seat_id] = p.seat_no;
    seatNoToStatus[p.seat_no] = p.status;
  });
  const seatNosInHand = participants.map((p) => p.seat_no);
  const actions = actionsRaw.map((a) => ({ ...a, seat_no: seatIdToNo[a.seat_id] }));

  const streets = {};
  STREET_ORDER.forEach((street, idx) => {
    const orderSeatNos = computeActionOrder(street, hand.dealer_seat_no, seatNosInHand);
    const activeOrder = orderSeatNos
      .filter((sn) => {
        const seatId = seatNoToId[sn];
        // seats.status reflects the CURRENT live status, not a snapshot - if
        // someone has since stepped away or left, they can no longer act,
        // even on a street where they hadn't folded or gone all-in.
        if (seatNoToStatus[sn] !== 'active') return false;
        const foldedByNow = actions.some((a) => a.seat_id === seatId && a.action_type === 'fold'
          && STREET_ORDER.indexOf(a.street) <= idx);
        // an all-in seat still needs to appear in the order for the street it
        // went all-in on (so that action gets processed and reopens things for
        // whoever's left), but never again after that.
        const allInBefore = actions.some((a) => a.seat_id === seatId && a.action_type === 'allin'
          && STREET_ORDER.indexOf(a.street) < idx);
        return !foldedByNow && !allInBefore;
      })
      .map((sn) => seatNoToId[sn]);
    const streetActions = actions.filter((a) => a.street === street);
    streets[street] = {
      order: activeOrder,
      current_actor_seat_id: computeCurrentActor(activeOrder, streetActions),
    };
  });

  const potInfo = computePotInfo(session, hand, seatNosInHand, actions);
  const nonParticipantSeats = getSeats(hand.session_id).filter((s) => !seatNosInHand.includes(s.seat_no));
  return {
    hand, participants, actions: actionsRaw, streets, pot_info: potInfo,
    my_slot: session.my_slot, non_participant_seats: nonParticipantSeats,
  };
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
  const { title, small_blind, big_blind, my_slot } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'title is required' });
  const slot = Number.isInteger(my_slot) && my_slot >= 0 && my_slot < SEAT_COUNT ? my_slot : 0;
  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO sessions (title, small_blind, big_blind, memo, dealer_seat, my_slot, created_at)
      VALUES (?, ?, ?, ?, 0, ?, ?)
    `).run(String(title).trim(), small_blind || null, big_blind || null, null, slot, now());
    const sessionId = info.lastInsertRowid;
    const insertSeat = db.prepare(`
      INSERT INTO seats (session_id, seat_no, status, generation, memo, updated_at)
      VALUES (?, ?, ?, 1, NULL, ?)
    `);
    for (let seatNo = 0; seatNo < SEAT_COUNT; seatNo += 1) {
      insertSeat.run(sessionId, seatNo, 'active', now());
    }
    return sessionId;
  });
  const sessionId = tx();
  res.status(201).json(getSessionDetail(sessionId));
});

app.get('/api/sessions/:id', (req, res) => {
  const detail = getSessionDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: 'not found' });
  res.json(detail);
});

app.delete('/api/sessions/:id', (req, res) => {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// ---------- seats ----------
app.patch('/api/sessions/:id/seats/:seatNo', (req, res) => {
  const seat = db.prepare('SELECT * FROM seats WHERE session_id = ? AND seat_no = ?').get(req.params.id, req.params.seatNo);
  if (!seat) return res.status(404).json({ error: 'not found' });
  if (seat.seat_no === 0) return res.status(400).json({ error: 'cannot modify own seat' });
  const { status, memo, stack } = req.body || {};
  const updates = [];
  const values = [];
  if (status !== undefined) {
    if (!['active', 'away', 'empty'].includes(status)) return res.status(400).json({ error: 'invalid status' });
    updates.push('status = ?');
    values.push(status);
  }
  if (memo !== undefined) {
    updates.push('memo = ?');
    values.push(memo || null);
  }
  if (stack !== undefined) {
    updates.push('stack = ?');
    values.push(stack === null || stack === '' ? null : Number(stack));
  }
  if (updates.length) {
    updates.push('updated_at = ?');
    values.push(now(), seat.id);
    db.prepare(`UPDATE seats SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }
  res.json(getSessionDetail(req.params.id));
});

// person sitting in the seat changed: clear their notes and start a fresh generation
app.post('/api/sessions/:id/seats/:seatNo/reset', (req, res) => {
  const seat = db.prepare('SELECT * FROM seats WHERE session_id = ? AND seat_no = ?').get(req.params.id, req.params.seatNo);
  if (!seat) return res.status(404).json({ error: 'not found' });
  if (seat.seat_no === 0) return res.status(400).json({ error: 'cannot reset own seat' });
  db.prepare('UPDATE seats SET memo = NULL, generation = generation + 1, status = ?, updated_at = ? WHERE id = ?')
    .run('active', now(), seat.id);
  res.json(getSessionDetail(req.params.id));
});

// past rounds this occupant (current generation) took part in
// VPIP = % of hands where the seat voluntarily put money in preflop (called,
// bet, raised, or shoved) rather than just folding or checking their blind.
function computeVpip(seatId, generation) {
  const hands = db.prepare(`
    SELECT h.id FROM hand_seats hs JOIN hands h ON h.id = hs.hand_id
    WHERE hs.seat_id = ? AND hs.generation = ?
  `).all(seatId, generation);
  if (!hands.length) return { percent: null, hands: 0 };
  const voluntary = db.prepare(`
    SELECT COUNT(DISTINCT hand_id) AS c FROM actions
    WHERE seat_id = ? AND street = 'preflop' AND action_type IN ('call', 'bet', 'raise', 'allin')
      AND hand_id IN (${hands.map(() => '?').join(',')})
  `).get(seatId, ...hands.map((h) => h.id)).c;
  return { percent: Math.round((voluntary / hands.length) * 100), hands: hands.length };
}

app.get('/api/sessions/:id/seats/:seatNo/history', (req, res) => {
  const seat = db.prepare('SELECT * FROM seats WHERE session_id = ? AND seat_no = ?').get(req.params.id, req.params.seatNo);
  if (!seat) return res.status(404).json({ error: 'not found' });
  const hands = db.prepare(`
    SELECT h.id, h.hand_no, h.created_at, h.pot_size, h.winner_seat_id, hs.hole_cards, hs.folded
    FROM hand_seats hs JOIN hands h ON h.id = hs.hand_id
    WHERE hs.seat_id = ? AND hs.generation = ?
    ORDER BY h.hand_no DESC
  `).all(seat.id, seat.generation);
  const vpip = computeVpip(seat.id, seat.generation);
  res.json({ seat: { ...seat, label: seatLabel(seat.seat_no) }, hands, vpip });
});

// dealer button moves to the next occupied seat; SB/BB follow automatically
app.post('/api/sessions/:id/dealer/next', (req, res) => {
  const session = getSessionSummary(req.params.id);
  if (!session) return res.status(404).json({ error: 'not found' });
  const seats = getSeats(req.params.id);
  const seatsByNo = {};
  seats.forEach((s) => { seatsByNo[s.seat_no] = s; });
  const nextSeat = nextActiveSeatNo(seatsByNo, session.dealer_seat);
  if (nextSeat !== null) {
    db.prepare('UPDATE sessions SET dealer_seat = ? WHERE id = ?').run(nextSeat, req.params.id);
  }
  res.json(getSessionDetail(req.params.id));
});

// ---------- hands ----------
app.post('/api/sessions/:id/hands', (req, res) => {
  const session = getSessionSummary(req.params.id);
  if (!session) return res.status(404).json({ error: 'not found' });
  const openHand = db.prepare('SELECT id FROM hands WHERE session_id = ? AND finished = 0 ORDER BY hand_no DESC LIMIT 1').get(req.params.id);
  if (openHand) return res.status(201).json(getHandDetail(openHand.id));
  const seats = getSeats(req.params.id);
  const activeSeats = seats.filter((s) => s.status === 'active');
  if (activeSeats.length < 2) {
    return res.status(400).json({ error: 'at least 2 active seats are required to start a round' });
  }
  const tx = db.transaction(() => {
    const maxHandNo = db.prepare('SELECT COALESCE(MAX(hand_no), 0) AS m FROM hands WHERE session_id = ?').get(req.params.id).m;
    const info = db.prepare(`
      INSERT INTO hands (session_id, hand_no, dealer_seat_no, created_at)
      VALUES (?, ?, ?, ?)
    `).run(req.params.id, maxHandNo + 1, session.dealer_seat, now());
    const handId = info.lastInsertRowid;
    const insertHs = db.prepare('INSERT INTO hand_seats (hand_id, seat_id, generation) VALUES (?, ?, ?)');
    activeSeats.forEach((s) => insertHs.run(handId, s.id, s.generation));
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
  const fields = ['board_flop', 'board_turn', 'board_river', 'pot_size', 'winner_seat_id', 'memo', 'finished'];
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

app.patch('/api/hands/:handId/seats/:seatId', (req, res) => {
  const { hole_cards } = req.body || {};
  const info = db.prepare('UPDATE hand_seats SET hole_cards = ? WHERE hand_id = ? AND seat_id = ?')
    .run(hole_cards || null, req.params.handId, req.params.seatId);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json(getHandDetail(req.params.handId));
});

// ---------- actions ----------
app.post('/api/hands/:id/actions', (req, res) => {
  const hand = db.prepare('SELECT * FROM hands WHERE id = ?').get(req.params.id);
  if (!hand) return res.status(404).json({ error: 'not found' });
  const { seat_id, street, action_type, amount } = req.body || {};
  const validStreets = ['preflop', 'flop', 'turn', 'river'];
  const validActions = ['fold', 'check', 'call', 'bet', 'raise', 'allin'];
  if (!seat_id || !validStreets.includes(street) || !validActions.includes(action_type)) {
    return res.status(400).json({ error: 'invalid action' });
  }
  const tx = db.transaction(() => {
    const maxSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM actions WHERE hand_id = ?').get(req.params.id).m;
    db.prepare(`
      INSERT INTO actions (hand_id, seat_id, street, seq, action_type, amount, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(req.params.id, seat_id, street, maxSeq + 1, action_type, amount || null, now());
    if (action_type === 'fold') {
      db.prepare('UPDATE hand_seats SET folded = 1 WHERE hand_id = ? AND seat_id = ?').run(req.params.id, seat_id);
    }
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
        SELECT COUNT(*) AS c FROM actions WHERE hand_id = ? AND seat_id = ? AND action_type = 'fold'
      `).get(action.hand_id, action.seat_id).c;
      if (remainingFold === 0) {
        db.prepare('UPDATE hand_seats SET folded = 0 WHERE hand_id = ? AND seat_id = ?').run(action.hand_id, action.seat_id);
      }
    }
  });
  tx();
  res.json(getHandDetail(action.hand_id));
});

// ---------- AI analysis (Claude) ----------
// Scores the user's own play in this hand and, for each opponent, analyzes
// their play across this session (same seat generation = same person) to
// suggest exploits and auto-applies play-style tags to their seat memo.
app.post('/api/hands/:id/ai-analysis', async (req, res) => {
  const client = getAnthropicClient();
  if (!client) {
    return res.status(400).json({ error: 'サーバーにANTHROPIC_API_KEYが設定されていません。環境変数を設定してサーバーを再起動してください。' });
  }
  const detail = getHandDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: 'not found' });
  const { hand, participants, actions, pot_info: potInfo } = detail;
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(hand.session_id);

  const seatNoToLabel = {};
  participants.forEach((p) => { seatNoToLabel[p.seat_no] = p.label; });
  const seatIdToSeatNo = {};
  participants.forEach((p) => { seatIdToSeatNo[p.seat_id] = p.seat_no; });

  const thisHand = {
    small_blind_bb: session.small_blind,
    big_blind_bb: session.big_blind,
    dealer_seat: seatLabel(hand.dealer_seat_no),
    board: [hand.board_flop, hand.board_turn, hand.board_river].filter(Boolean).join(' ') || null,
    pot_bb: potInfo.pot,
    winner_seat: hand.winner_seat_id ? seatNoToLabel[seatIdToSeatNo[hand.winner_seat_id]] : null,
    players: participants.map((p) => ({
      seat: p.label,
      is_me: p.seat_no === 0,
      hole_cards: p.hole_cards || null,
      folded: !!p.folded,
    })),
    actions: actions.map((a) => ({
      seat: seatNoToLabel[seatIdToSeatNo[a.seat_id]],
      street: a.street,
      action: a.action_type,
      amount_bb: a.amount,
    })),
  };

  const opponents = participants.filter((p) => p.seat_no !== 0);
  const opponentHistory = opponents.map((p) => {
    const seatRow = db.prepare('SELECT * FROM seats WHERE session_id = ? AND seat_no = ?').get(hand.session_id, p.seat_no);
    const pastHands = db.prepare(`
      SELECT h.id, h.hand_no, h.pot_size, h.winner_seat_id, hs.hole_cards, hs.folded
      FROM hand_seats hs JOIN hands h ON h.id = hs.hand_id
      WHERE hs.seat_id = ? AND hs.generation = ? AND h.id != ?
      ORDER BY h.hand_no DESC LIMIT 20
    `).all(seatRow.id, seatRow.generation, hand.id);
    const pastActions = pastHands.length ? db.prepare(`
      SELECT hand_id, street, action_type, amount FROM actions
      WHERE seat_id = ? AND hand_id IN (${pastHands.map(() => '?').join(',')})
      ORDER BY hand_id, seq
    `).all(seatRow.id, ...pastHands.map((h) => h.id)) : [];
    // Hands where they never voluntarily put money in preflop (just folded
    // their blind or folded to an open) carry no signal worth the tokens -
    // record only that they folded preflop. Hands they continued past
    // preflop keep the full action-by-action detail.
    return {
      seat: p.label,
      current_memo: seatRow.memo || null,
      vpip: computeVpip(seatRow.id, seatRow.generation),
      hands: pastHands.map((h) => {
        const handActions = pastActions.filter((a) => a.hand_id === h.id);
        const vpipThisHand = handActions.some((a) => a.street === 'preflop' && ['call', 'bet', 'raise', 'allin'].includes(a.action_type));
        if (!vpipThisHand) {
          return { hand_no: h.hand_no, result: 'folded_preflop' };
        }
        return {
          hand_no: h.hand_no,
          won: h.winner_seat_id === seatRow.id,
          pot_bb: h.pot_size,
          hole_cards: h.hole_cards || null,
          folded: !!h.folded,
          actions: handActions.map((a) => ({ street: a.street, action: a.action_type, amount_bb: a.amount })),
        };
      }),
    };
  });

  const prompt = `あなたはプロのポーカーコーチです。以下はテキサスホールデムの1ハンドの記録と、このセッションでの各対戦相手の過去のプレイ履歴です。金額は全てBB(ビッグブラインドを1とする)単位です。

# 今回のハンド
${JSON.stringify(thisHand, null, 2)}

# 対戦相手の過去のプレイ履歴(このセッション内、同一人物のみ)
vpipはプリフロップで自発的に金額を投じた割合(コール/ベット/レイズ/オールイン)。各hands中、result:"folded_preflop"はプリフロップで降りたのみで詳細アクションは記録していないハンド。それ以外はフロップ以降まで進んだハンドで、詳細なアクションを記録している。
${JSON.stringify(opponentHistory, null, 2)}

以下のJSON形式で**JSONのみ**を出力してください。前置き・説明文・コードブロック記号(\`\`\`)は一切不要です。

{
  "self_review": {
    "score": 0から100の整数,
    "summary": "一言評価(30文字程度)",
    "details": "今回のハンドでのis_me=trueのプレイヤーのプレーについての具体的なレビュー(良かった点・改善点)"
  },
  "opponents": [
    {
      "seat": "座席ラベル(例: A)",
      "tags": ["プレイスタイルを表す短いタグを1~3個。例: ルースアグレッシブ、ブラファー、タイトパッシブ"],
      "exploit_tips": "このプレイヤーから今後利益を得るための具体的なエクスプロイト方法"
    }
  ]
}

履歴データが少ない相手には、少ないなりに現時点で言えることを書いてください。opponentsには今回のハンドに参加した全相手を含めてください。`;

  let aiResult;
  try {
    const response = await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });
    const textBlock = response.content.find((b) => b.type === 'text');
    const raw = textBlock ? textBlock.text : '';
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    aiResult = JSON.parse(cleaned);
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEYが無効です。' });
    }
    if (e instanceof Anthropic.RateLimitError) {
      return res.status(500).json({ error: 'レート制限に達しました。しばらくしてから再試行してください。' });
    }
    return res.status(502).json({ error: `AI分析に失敗しました: ${e.message}` });
  }

  // auto-apply suggested tags to each opponent's seat memo (merge, dedupe)
  const updateMemo = db.prepare('UPDATE seats SET memo = ?, updated_at = ? WHERE id = ?');
  (aiResult.opponents || []).forEach((o) => {
    const p = opponents.find((pp) => pp.label === o.seat);
    if (!p || !Array.isArray(o.tags) || !o.tags.length) return;
    const seatRow = db.prepare('SELECT * FROM seats WHERE session_id = ? AND seat_no = ?').get(hand.session_id, p.seat_no);
    if (!seatRow) return;
    const existing = (seatRow.memo || '').split(/,\s*/).map((s) => s.trim()).filter(Boolean);
    o.tags.forEach((t) => { if (t && !existing.includes(t)) existing.push(t); });
    updateMemo.run(existing.join(', '), now(), seatRow.id);
  });

  res.json(aiResult);
});

app.listen(PORT, HOST, () => {
  console.log(`Notes server listening on http://${HOST}:${PORT}`);
  if (!APP_PASSWORD) {
    console.log('APP_PASSWORD is not set - no login gate (rely on Tailscale/LAN isolation).');
  }
});
