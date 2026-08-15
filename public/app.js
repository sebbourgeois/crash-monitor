// Brutalist Chart.js theme (shared look across both pages)
if (window.Chart) {
  Chart.defaults.font.family = "'Space Mono', monospace";
  Chart.defaults.font.weight = '700';
  Chart.defaults.color = '#8b8b84';
  Chart.defaults.borderColor = 'rgba(255,255,255,0.06)';
}

// State Management
//
// Every site's feed arrives over the same socket, so the page keeps a full
// state bag per site and only the active one is rendered. Switching tabs is
// then instant and does not drop the other site's live updates.
const State = {
  site: null,
  sites: {},
  chart: null,
  isAudioEnabled: false,
  colors: {
    red: '#f6465d',
    orange: '#ff9f43',
    green: '#0ecb81',
    purple: '#a855f7',
    turquoise: '#00d2d3'
  }
};

function siteState(key) {
  if (!State.sites[key]) {
    State.sites[key] = {
      results: [],
      streaks: null,
      liveGame: { status: 'waiting', multiplier: 1.00, gameId: null }
    };
  }
  return State.sites[key];
}

const active = () => siteState(State.site);
const isActive = (key) => key === State.site;

// DOM Elements
const Elements = {
  status: document.getElementById('status'),
  siteTabs: document.getElementById('site-tabs'),
  brandSub: document.getElementById('brand-sub'),
  resultsGrid: document.getElementById('results-grid'),
  statAverage: document.getElementById('stat-average'),
  statMedian: document.getElementById('stat-median'),
  statMax: document.getElementById('stat-max'),
  statSince1x: document.getElementById('stat-since1x'),
  statSince1000x: document.getElementById('stat-since1000x'),
  statSinceDouble1x: document.getElementById('stat-since-double1x'),
  liveDisplay: document.getElementById('live-display'),
  liveStatus: document.getElementById('live-status'),
  liveMultiplier: document.getElementById('live-multiplier'),
  audioToggle: document.getElementById('audio-toggle')
};

// WebSocket Logic
let ws = null;
let reconnectInterval = 3000;

function connect() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${window.location.host}`);

  ws.onopen = () => {
    Elements.status.textContent = 'Connected';
    Elements.status.className = 'status connected';
  };

  ws.onclose = () => {
    Elements.status.textContent = 'Disconnected';
    Elements.status.className = 'status disconnected';
    setTimeout(connect, reconnectInterval);
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    // Messages predating the multi-site protocol carried no site tag.
    const key = data.site || 'stake';
    switch (data.type) {
      case 'history': {
        const s = siteState(key);
        s.results = data.results;
        if (data.streaks) s.streaks = data.streaks;
        if (isActive(key)) renderAll();
        break;
      }
      case 'result':
        handleNewResult(key, data.result);
        break;
      case 'live':
        handleLive(key, data.state);
        break;
    }
  };
}

function handleNewResult(key, result) {
  const s = siteState(key);
  s.results.unshift(result);
  if (s.results.length > 1000) s.results.pop();

  s.streaks = {
    gamesSinceLast1x: result.gamesSinceLast1x,
    gamesSinceLast1000x: result.gamesSinceLast1000x,
    gamesSinceDouble1x: result.gamesSinceDouble1x
  };

  if (!isActive(key)) return; // background site: keep the data, skip the DOM

  addNewPill(result);
  updateStats();
  updateChart();

  if (State.isAudioEnabled) playAlert(result.multiplier);
}

function handleLive(key, state) {
  const s = siteState(key);
  const prevStatus = s.liveGame.status; // captured before the store — the reset below needs the transition
  s.liveGame = { ...state };
  if (isActive(key)) updateLiveDisplay(state, prevStatus);
}

// UI Rendering Helpers
function getColorClass(m) {
  if (m < 1.01) return 'red';
  if (m < 2) return 'orange';
  if (m < 100) return 'green';
  if (m < 1000) return 'purple';
  return 'turquoise';
}

function formatMultiplier(m, decimals = 2) {
  if (m >= 1000) return Math.floor(m) + 'x';
  const f = Math.pow(10, decimals);
  return (Math.floor(m * f) / f).toFixed(decimals) + 'x';
}

let displayMultiplier = 1.00;
let lastFrameTime = performance.now();

function animateMultiplier() {
  const now = performance.now();
  const dt = (now - lastFrameTime) / 1000;
  lastFrameTime = now;

  const liveGame = State.site ? active().liveGame : { status: 'waiting', multiplier: 1.00 };
  const targetMultiplier = parseFloat(liveGame.multiplier) || 1.00;
  const status = liveGame.status;

  if (status === 'in_progress') {
    // 1. Prediction: Always drift upwards at the base crash rate (~6% per second)
    // This ensures the number never stops moving even if packets are slow.
    const drift = displayMultiplier * 0.06 * dt;
    displayMultiplier += drift;

    // 2. Correction: If we are behind the server's last known value, catch up.
    // We use a relatively high catch-up factor to stay close to reality.
    if (displayMultiplier < targetMultiplier) {
      displayMultiplier += (targetMultiplier - displayMultiplier) * 0.2;
    }

    // 3. Safety: Don't let the prediction fly too far ahead of the last known server value
    // (cap at 0.1x ahead to maintain accuracy)
    if (displayMultiplier > targetMultiplier + 0.1) {
      displayMultiplier = targetMultiplier + 0.1;
    }

    Elements.liveMultiplier.textContent = formatMultiplier(displayMultiplier, 2);

    // Update tier color dynamically during progress
    const tier = getColorClass(displayMultiplier);
    Elements.liveDisplay.classList.remove('tier-orange', 'tier-green', 'tier-purple', 'tier-turquoise');
    Elements.liveDisplay.classList.add(`tier-${tier}`);
  } else {
    // Reset or show the final result
    displayMultiplier = targetMultiplier;
    Elements.liveMultiplier.textContent = formatMultiplier(displayMultiplier, 2);

    // Final color on crash
    if (status === 'crash') {
      Elements.liveDisplay.classList.remove('tier-orange', 'tier-green', 'tier-purple', 'tier-turquoise');
    }
  }

  requestAnimationFrame(animateMultiplier);
}

requestAnimationFrame(animateMultiplier);

function updateLiveDisplay(state, prevStatus = state.status) {
  const { status, multiplier } = state;

  // Reset display when a new game starts
  if (status === 'starting' || status === 'start' || (status === 'in_progress' && prevStatus !== 'in_progress')) {
    displayMultiplier = 1.00;
  }

  const statusLabels = {
    'in_progress': 'CRASHING...',
    'starting': 'PREPARING',
    'start': 'STARTING',
    'crash': 'CRASHED',
    'waiting': 'WAITING',
    'pending': 'WAITING'
  };

  Elements.liveStatus.textContent = statusLabels[status] || status.toUpperCase();

  const currentStatusClass = Elements.liveDisplay.classList.contains(status);

  // Remove all current tier classes
  Elements.liveDisplay.classList.remove('tier-orange', 'tier-green', 'tier-purple', 'tier-turquoise');

  // Update base status class
  Elements.liveDisplay.className = `live-display ${status}`;

  // Apply initial tier class if in progress
  if (status === 'in_progress') {
    Elements.liveDisplay.classList.add(`tier-${getColorClass(multiplier)}`);
  }

  // Apply crash impact effect if transitioning to crash
  if (status === 'crash' && !currentStatusClass) {
    Elements.liveDisplay.classList.add('crash-impact');
    setTimeout(() => Elements.liveDisplay.classList.remove('crash-impact'), 500);
  }
}

function addNewPill(result) {
  const pill = document.createElement('div');
  pill.className = `pill ${getColorClass(result.multiplier)} new`;
  pill.textContent = formatMultiplier(result.multiplier);
  pill.title = `Game: ${result.gameId}\n${new Date(result.timestamp).toLocaleString()}`;

  Elements.resultsGrid.insertBefore(pill, Elements.resultsGrid.firstChild);
  if (Elements.resultsGrid.children.length > 200) {
    Elements.resultsGrid.removeChild(Elements.resultsGrid.lastChild);
  }
}

function updateStats() {
  const s = active();
  if (s.results.length === 0) {
    [Elements.statAverage, Elements.statMedian, Elements.statMax,
     Elements.statSince1x, Elements.statSince1000x, Elements.statSinceDouble1x]
      .forEach(el => { el.textContent = '--'; });
    return;
  }

  const multipliers = s.results.map(r => r.multiplier);
  const sorted = [...multipliers].sort((a, b) => a - b);
  const avg = multipliers.reduce((a, b) => a + b, 0) / multipliers.length;
  const median = sorted[Math.floor(sorted.length / 2)];

  Elements.statAverage.textContent = avg.toFixed(2) + 'x';
  Elements.statMedian.textContent = median.toFixed(2) + 'x';
  Elements.statMax.textContent = formatMultiplier(sorted[sorted.length - 1]);

  const streaks = s.streaks || s.results[0];
  Elements.statSince1x.textContent = streaks.gamesSinceLast1x ?? '--';
  Elements.statSince1000x.textContent = streaks.gamesSinceLast1000x ?? '--';
  Elements.statSinceDouble1x.textContent = streaks.gamesSinceDouble1x ?? '--';
}

function updateChart() {
  const dist = { red: 0, orange: 0, green: 0, purple: 0, turquoise: 0 };
  active().results.forEach(r => dist[getColorClass(r.multiplier)]++);

  const data = [dist.red, dist.orange, dist.green, dist.purple, dist.turquoise];

  if (State.chart) {
    State.chart.data.datasets[0].data = data;
    State.chart.update('none');
  } else {
    const ctx = document.getElementById('distributionChart').getContext('2d');
    State.chart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: ['1.00x', '1.01-1.99', '2-99', '100-999', '1000x+'],
        datasets: [{
          data,
          backgroundColor: Object.values(State.colors).map(c => c + '33'),
          borderColor: Object.values(State.colors),
          borderWidth: 2,
          borderRadius: 0
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.06)' }, ticks: { color: '#8b8b84' } },
          x: { grid: { display: false }, ticks: { color: '#8b8b84' } }
        }
      }
    });
  }
}

function renderAll() {
  Elements.resultsGrid.innerHTML = '';
  active().results.slice(0, 200).forEach(r => {
    const pill = document.createElement('div');
    pill.className = `pill ${getColorClass(r.multiplier)}`;
    pill.textContent = formatMultiplier(r.multiplier);
    pill.title = `Game: ${r.gameId}\n${new Date(r.timestamp).toLocaleString()}`;
    Elements.resultsGrid.appendChild(pill);
  });
  updateStats();
  updateChart();
}

// Repaints everything from the state already held for that site.
function switchSite(key) {
  State.site = key;
  const site = SiteTabs.find(key);
  Elements.brandSub.textContent = `live signal · ${site.tab || site.label}`;
  // Snap to this site's current round instead of drifting up from the other one.
  displayMultiplier = parseFloat(active().liveGame.multiplier) || 1.00;
  renderAll();
  updateLiveDisplay(active().liveGame);
}

// Audio Alerts
function playAlert(multiplier) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.connect(gain);
  gain.connect(ctx.destination);

  if (multiplier < 1.01) {
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(150, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(40, ctx.currentTime + 0.5);
  } else if (multiplier >= 1000) {
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1760, ctx.currentTime + 1);
  } else if (multiplier >= 100) {
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(440, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.3);
  } else {
    return; // No sound for normal results
  }

  gain.gain.setValueAtTime(0.1, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);

  osc.start();
  osc.stop(ctx.currentTime + 1);
}

// Event Listeners
Elements.audioToggle.onclick = () => {
  State.isAudioEnabled = !State.isAudioEnabled;
  Elements.audioToggle.classList.toggle('active', State.isAudioEnabled);
};

// Init — tabs first so the socket's very first messages land in a known site.
(async function init() {
  await SiteTabs.load();
  const start = SiteTabs.initial();
  SiteTabs.render(Elements.siteTabs, start, switchSite);
  switchSite(start);
  connect();
})();
