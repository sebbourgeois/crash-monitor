// Site definitions. Everything site-specific lives here: the page to open and
// the parser that turns one raw websocket frame into the normalized event the
// rest of the pipeline understands.
//
// parseFrame() receives the CDP `Network.webSocketFrameReceived` response
// verbatim — `{ opcode, payloadData }` — because the wire format is itself a
// site difference: Stake, Shuffle and Goated send JSON text frames (opcode 1)
// while Roobet sends a packed binary payload (opcode 2, base64-encoded by CDP).
// The JSON sites are wrapped in jsonFrame() below so their parsers stay pure
// functions of the decoded object.
//
// Normalized event shape (or null when the frame is not a crash update):
//   { status, gameId, multiplier, timestamp? }
//     status     — 'starting' | 'start' | 'in_progress' | 'crash'
//     gameId     — string, the dedupe boundary and PRIMARY KEY
//     multiplier — Number; the final crash point when status === 'crash'
//     timestamp  — optional ISO 8601 string; falls back to now when absent
//
// Only 'crash' is persisted; the other statuses drive the live display.

// Adapts a JSON-text parser to the raw-frame contract: drop binary frames, and
// treat unparseable text as "not a crash update" rather than throwing.
function jsonFrame(parse) {
  return (response) => {
    if (response.opcode !== 1) return null;
    let data;
    try {
      data = JSON.parse(response.payloadData);
    } catch (e) {
      return null;
    }
    return parse(data);
  };
}

// Stake ships a GraphQL subscription over its main websocket. Two payload
// shapes are in use (`crash.event` and a bare `event`), both carrying
// __typename 'MultiplayerCrash', and its status strings are already the
// normalized vocabulary.
function parseStakeFrame(data) {
  if (data.type !== 'data' && data.type !== 'next') return null;

  const payload = data.payload?.data;
  if (!payload) return null;

  const event = payload.crash?.event || payload.event;
  if (!event || event.__typename !== 'MultiplayerCrash') return null;

  const { status, id: gameId, multiplier = 1.00 } = event;
  if (!status || gameId == null) return null;

  return {
    status,
    gameId: String(gameId),
    multiplier: Number(multiplier),
    timestamp: event.timestamp
  };
}

// Shuffle publishes `crashEventUpdate` (__typename 'CrashEventPayload') on
// wss://shuffle.com/main-api/bp-subscription/stable-subscription/graphql. The
// round cycles ACCEPTING_BETS → BLOCK → IN_PROGRESS → CRASHED, and the payload
// differs from Stake's in three ways that matter:
//   - multipliers arrive as decimal *strings*, live in `currentPoint` and final
//     in `crashPoint` (null until the round ends),
//   - the id is the numeric `crashGameId`,
//   - there is no timestamp field; `startedAt` (epoch ms) plus `elapsed` (ms)
//     is the actual moment of the crash, which beats the receive time.
const SHUFFLE_STATUS = {
  ACCEPTING_BETS: 'starting',
  BLOCK: 'start',
  IN_PROGRESS: 'in_progress',
  CRASHED: 'crash'
};

function parseShuffleFrame(data) {
  if (data.type !== 'next' && data.type !== 'data') return null;

  const event = data.payload?.data?.crashEventUpdate;
  if (!event || event.__typename !== 'CrashEventPayload') return null;

  const status = SHUFFLE_STATUS[event.status];
  if (!status || event.crashGameId == null) return null;

  const raw = status === 'crash' ? event.crashPoint : event.currentPoint;
  const multiplier = raw == null ? 1.00 : Number.parseFloat(raw);

  // A CRASHED frame without a usable crashPoint would poison the archive with a
  // bogus 1.00x, so drop it and let the round go unrecorded instead.
  if (!Number.isFinite(multiplier)) return null;

  const crashedAt = status === 'crash' && event.startedAt
    ? new Date(event.startedAt + (event.elapsed || 0)).toISOString()
    : undefined;

  return {
    status,
    gameId: String(event.crashGameId),
    multiplier,
    timestamp: crashedAt
  };
}

// Roobet speaks Socket.IO on a `/crash` namespace, and every game update is the
// single event `stateUpdate` carrying one binary attachment. Socket.IO splits
// that into two websocket frames — a text announcement
// (`451-/crash,["stateUpdate",{"_placeholder":true,"num":0}]`) followed by the
// binary payload — so the announcement is ignored and the attachment is parsed
// directly. That is safe because `stateUpdate` is the only event on the
// namespace (verified over ~7.4k frames) and each payload is self-describing:
// byte 0 is a tag, and only the two tags below are game state.
//
// Strings are length-prefixed with one byte; integers are big-endian int32.
//
//   tag 0x04, 5 bytes            round tick, every 150ms
//     [0]=0x04 [1..5]=elapsed ms since the round started
//
//   tag 0x03, 35 or 104 bytes    round lifecycle
//     [0]=0x03 [1]=idLen [2..]=gameId (24-char Mongo ObjectId)
//     then phase, then two int32 clock offsets (ms, negative once the round is
//     under way), and for phase 4 a 64-char provably-fair hash plus the crash
//     point in hundredths:
//       1 = round opened, starts in ~6s   3 = running
//       2 = bets locking                  4 = crashed
//
// Two things follow from this that no other site has:
//   - ticks carry no game id, so the id from the last lifecycle frame is held
//     in `roobetGameId`. Until one arrives (a fresh browser joining mid-round)
//     ticks are dropped rather than attributed to a null game;
//   - ticks carry no multiplier either — the client derives it from elapsed
//     time. ROOBET_GROWTH_PER_MS / ROOBET_LAUNCH_MS below are a least-squares
//     fit over 21 observed rounds (max error 0.5% from 1.01x to 28.23x). Only
//     the live display uses them: the archived crash point is the exact integer
//     the server sends in phase 4, never a value computed from this curve.
const ROOBET_GROWTH_PER_MS = 6.014e-5;
const ROOBET_LAUNCH_MS = 233;

const ROOBET_PHASE = {
  1: 'starting',
  2: 'start',
  3: 'in_progress',
  4: 'crash'
};

const roobetMultiplier = (elapsedMs) =>
  Math.max(1, Math.exp(ROOBET_GROWTH_PER_MS * (elapsedMs - ROOBET_LAUNCH_MS)));

let roobetGameId = null;

function parseRoobetFrame(response) {
  if (response.opcode !== 2) return null; // the text half is just the announcement
  const buf = Buffer.from(response.payloadData, 'base64');
  if (buf.length < 5) return null;

  if (buf[0] === 0x04) {
    if (buf.length !== 5 || roobetGameId === null) return null;
    return {
      status: 'in_progress',
      gameId: roobetGameId,
      multiplier: roobetMultiplier(buf.readInt32BE(1))
    };
  }

  if (buf[0] !== 0x03) return null; // 0x05 is player bet traffic

  const idLen = buf[1];
  const phaseAt = 2 + idLen;
  // gameId becomes a PRIMARY KEY, so a zero-length id is rejected outright
  // rather than archived as an empty string.
  if (!idLen || buf.length < phaseAt + 9) return null;

  const status = ROOBET_PHASE[buf[phaseAt]];
  if (!status) return null;

  const gameId = buf.toString('latin1', 2, phaseAt);
  roobetGameId = gameId;

  if (status !== 'crash') return { status, gameId, multiplier: 1.00 };

  // phase 4: two int32 offsets, then the hash, then the crash point.
  const hashAt = phaseAt + 9;
  const pointAt = hashAt + 1 + buf[hashAt];
  if (buf.length < pointAt + 4) return null;

  const point = buf.readInt32BE(pointAt);
  // A truncated or nonsensical crash point would archive a bogus round, so drop
  // it instead — same guard as Shuffle's missing crashPoint.
  if (!Number.isFinite(point) || point < 100) return null;

  return { status, gameId, multiplier: point / 100 };
}

// Goated runs a dedicated socket, wss://casino-crash-websocket.goated.com/,
// that carries nothing but `{ type: 'crash_updates', data: [item, ...] }`
// envelopes. Every item names the round in `r` (increasing integers, like
// Shuffle) and is one of three `typ` values (observed over 9 rounds / 1.6k
// frames on 2026-09-30):
//   update        lifecycle: status waiting → betting → in_progress → crashed,
//                 with `started_at` (epoch ms) from `betting` on and the final
//                 `crash_multiplier` on `crashed`;
//   tick          ~every 100ms while running, `v` = current multiplier and
//                 `t` = elapsed ms;
//   participants  other players' bets. Ignored.
// Every numeric field is a decimal *string*, full precision (16 digits), and
// `at` is the server's epoch ms for that item, which beats the receive time
// as the crash timestamp. `data` has only ever held one item, but it is an
// array, so a batch is folded to one event with a crash winning over ticks —
// an archived round must never be lost to a live-display update.
//
// `waiting` lasts ~20ms before `betting` opens the 7s window; there is no
// bets-locked phase like Shuffle's BLOCK or Roobet's phase 2, so both map to
// 'starting' rather than mislabelling the whole window as 'start'.
const GOATED_STATUS = {
  waiting: 'starting',
  betting: 'starting',
  in_progress: 'in_progress',
  crashed: 'crash'
};

function parseGoatedItem(item) {
  if (!item || item.r == null) return null;

  if (item.typ === 'tick') {
    const multiplier = Number.parseFloat(item.v);
    if (!Number.isFinite(multiplier)) return null;
    return { status: 'in_progress', gameId: String(item.r), multiplier };
  }

  if (item.typ !== 'update') return null;
  const status = GOATED_STATUS[item.status];
  if (!status) return null;
  if (status !== 'crash') return { status, gameId: String(item.r), multiplier: 1.00 };

  // Same guard as Shuffle's missing crashPoint: a `crashed` update without a
  // usable multiplier is dropped rather than archived as a bogus 1.00x.
  const multiplier = Number.parseFloat(item.crash_multiplier);
  if (!Number.isFinite(multiplier) || multiplier < 1) return null;

  const at = Number(item.at);
  return {
    status,
    gameId: String(item.r),
    multiplier,
    timestamp: Number.isFinite(at) && at > 0 ? new Date(at).toISOString() : undefined
  };
}

function parseGoatedFrame(data) {
  if (data.type !== 'crash_updates' || !Array.isArray(data.data)) return null;

  let event = null;
  for (const item of data.data) {
    const parsed = parseGoatedItem(item);
    if (!parsed) continue;
    if (parsed.status === 'crash') return parsed;
    event = parsed;
  }
  return event;
}

// key       — URL/query identifier, the WebSocket message tag, and the name used in SITES / TELEGRAM_SITES
// label     — short name for logs and notifications
// tab       — what the dashboards print on the tab
// dbEnv     — env var overriding the SQLite path (one file per site, never shared)
// enabledEnv— set to 'false' to archive-only this site: no browser, data still served
// maskHidden— the page must not learn it sits behind the parking tab (see monitor.js)
const SITES = {
  stake: {
    key: 'stake',
    label: 'STAKE',
    tab: 'Stake.com',
    url: 'https://stake.com/casino/games/crash',
    dbEnv: 'DB_PATH',
    defaultDb: 'crash_results.db',
    enabledEnv: 'STAKE_ENABLED',
    parseFrame: jsonFrame(parseStakeFrame)
  },
  shuffle: {
    key: 'shuffle',
    label: 'SHUFFLE',
    tab: 'Shuffle.com',
    url: 'https://shuffle.com/games/originals/crash',
    dbEnv: 'SHUFFLE_DB_PATH',
    defaultDb: 'shuffle_crash_results.db',
    enabledEnv: 'SHUFFLE_ENABLED',
    maskHidden: true,
    parseFrame: jsonFrame(parseShuffleFrame)
  },
  roobet: {
    key: 'roobet',
    label: 'ROOBET',
    tab: 'Roobet.com',
    url: 'https://roobet.com/casino/game/crash',
    dbEnv: 'ROOBET_DB_PATH',
    defaultDb: 'roobet_crash_results.db',
    enabledEnv: 'ROOBET_ENABLED',
    parseFrame: parseRoobetFrame
  },
  goated: {
    key: 'goated',
    label: 'GOATED',
    tab: 'Goated.com',
    url: 'https://www.goated.com/casino/originals/crash',
    dbEnv: 'GOATED_DB_PATH',
    defaultDb: 'goated_crash_results.db',
    enabledEnv: 'GOATED_ENABLED',
    parseFrame: jsonFrame(parseGoatedFrame)
  }
};

module.exports = { SITES, jsonFrame, parseStakeFrame, parseShuffleFrame, parseRoobetFrame, parseGoatedFrame };
