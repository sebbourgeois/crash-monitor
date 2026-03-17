// State Management
const State = {
  results: [],
  chart: null,
  isAudioEnabled: false,
  liveGame: { status: 'waiting', multiplier: 1.00, gameId: null },
  colors: {
    red: '#f6465d',
    orange: '#ff9f43',
    green: '#0ecb81',
    purple: '#a855f7',
    turquoise: '#00d2d3'
  }
};

// DOM Elements
const Elements = {
  status: document.getElementById('status'),
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
    switch (data.type) {
      case 'history':
        State.results = data.results;
        renderAll();
        break;
      case 'result':
        handleNewResult(data.result);
        break;
      case 'live':
        updateLiveDisplay(data.state);
        break;
    }
  };
}

function handleNewResult(result) {
  State.results.unshift(result);
  if (State.results.length > 1000) State.results.pop();
  
  addNewPill(result);
  updateStats();
  updateChart();
  
  if (State.isAudioEnabled) playAlert(result.multiplier);
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
  if (m >= 1000) return m.toFixed(0) + 'x';
  return m.toFixed(decimals) + 'x';
}

let displayMultiplier = 1.00;
let lastFrameTime = performance.now();

function animateMultiplier() {
  const now = performance.now();
  const dt = (now - lastFrameTime) / 1000;
  lastFrameTime = now;

  const targetMultiplier = parseFloat(State.liveGame.multiplier) || 1.00;
  const status = State.liveGame.status;

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

function updateLiveDisplay(state) {
  const { status, multiplier } = state;
  
  // Reset display when a new game starts
  if (status === 'starting' || status === 'start' || (status === 'in_progress' && State.liveGame.status !== 'in_progress')) {
    displayMultiplier = 1.00;
  }

  State.liveGame.status = status;
  State.liveGame.multiplier = multiplier;

  const statusLabels = {
    'in_progress': 'CRASHING...',
    'starting': 'PREPARING',
    'start': 'STARTING',
    'crash': 'CRASHED',
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
  if (State.results.length === 0) return;

  const multipliers = State.results.map(r => r.multiplier);
  const sorted = [...multipliers].sort((a, b) => a - b);
  const avg = multipliers.reduce((a, b) => a + b, 0) / multipliers.length;
  const median = sorted[Math.floor(sorted.length / 2)];
  
  Elements.statAverage.textContent = avg.toFixed(2) + 'x';
  Elements.statMedian.textContent = median.toFixed(2) + 'x';
  Elements.statMax.textContent = formatMultiplier(sorted[sorted.length - 1]);

  const latest = State.results[0];
  Elements.statSince1x.textContent = latest.gamesSinceLast1x;
  Elements.statSince1000x.textContent = latest.gamesSinceLast1000x;
  Elements.statSinceDouble1x.textContent = latest.gamesSinceDouble1x;
}

function updateChart() {
  const dist = { red: 0, orange: 0, green: 0, purple: 0, turquoise: 0 };
  State.results.forEach(r => dist[getColorClass(r.multiplier)]++);

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
          backgroundColor: Object.values(State.colors).map(c => c + '44'),
          borderColor: Object.values(State.colors),
          borderWidth: 2,
          borderRadius: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#929aa5' } },
          x: { grid: { display: false }, ticks: { color: '#929aa5' } }
        }
      }
    });
  }
}

function renderAll() {
  Elements.resultsGrid.innerHTML = '';
  State.results.slice(0, 200).forEach(r => {
    const pill = document.createElement('div');
    pill.className = `pill ${getColorClass(r.multiplier)}`;
    pill.textContent = formatMultiplier(r.multiplier);
    Elements.resultsGrid.appendChild(pill);
  });
  updateStats();
  updateChart();
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

// Init
connect();
