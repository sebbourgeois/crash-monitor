// Site definitions. Everything site-specific lives here: the page to open and
// the parser that turns one raw websocket frame into the normalized event the
// rest of the pipeline understands.
//
// Normalized event shape (or null when the frame is not a crash update):
//   { status, gameId, multiplier, timestamp? }
//     status     — 'starting' | 'start' | 'in_progress' | 'crash'
//     gameId     — string, the dedupe boundary and PRIMARY KEY
//     multiplier — Number; the final crash point when status === 'crash'
//     timestamp  — optional ISO 8601 string; falls back to now when absent
//
// Only 'crash' is persisted; the other statuses drive the live display.

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

// key       — URL/query identifier and the WebSocket message tag
// label     — short name for logs and notifications
// tab       — what the dashboards print on the tab
// dbEnv     — env var overriding the SQLite path (one file per site, never shared)
// enabledEnv— set to 'false' to archive-only this site: no browser, data still served
const SITES = {
  stake: {
    key: 'stake',
    label: 'STAKE',
    tab: 'Stake.com',
    url: 'https://stake.com/casino/games/crash',
    dbEnv: 'DB_PATH',
    defaultDb: 'crash_results.db',
    enabledEnv: 'STAKE_ENABLED',
    parseFrame: parseStakeFrame
  },
  shuffle: {
    key: 'shuffle',
    label: 'SHUFFLE',
    tab: 'Shuffle.com',
    url: 'https://shuffle.com/games/originals/crash',
    dbEnv: 'SHUFFLE_DB_PATH',
    defaultDb: 'shuffle_crash_results.db',
    enabledEnv: 'SHUFFLE_ENABLED',
    parseFrame: parseShuffleFrame
  }
};

module.exports = { SITES, parseStakeFrame, parseShuffleFrame };
