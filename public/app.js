// State
let results = [];
let chart = null;

// Live game state
let liveGame = {
  status: 'waiting',
  gameId: null
};

// DOM elements
const statusEl = document.getElementById('status');
const resultsGrid = document.getElementById('results-grid');
const statAverage = document.getElementById('stat-average');
const statMedian = document.getElementById('stat-median');
const statGames = document.getElementById('stat-games');
const statMin = document.getElementById('stat-min');
const statMax = document.getElementById('stat-max');
const statSince1x = document.getElementById('stat-since1x');
const statSince1000x = document.getElementById('stat-since1000x');
const liveDisplay = document.getElementById('live-display');
const liveStatus = document.getElementById('live-status');
const liveMultiplier = document.getElementById('live-multiplier');

// WebSocket connection
let ws = null;
let reconnectTimeout = null;

function connect() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('WebSocket connected');
    statusEl.textContent = 'connected';
    statusEl.className = 'status connected';
  };

  ws.onclose = () => {
    console.log('WebSocket disconnected');
    statusEl.textContent = 'disconnected';
    statusEl.className = 'status disconnected';

    // Reconnect after 3 seconds
    reconnectTimeout = setTimeout(connect, 3000);
  };

  ws.onerror = (err) => {
    console.error('WebSocket error:', err);
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.type === 'history') {
        // Initial history load
        results = data.results;
        renderAll();
      } else if (data.type === 'result') {
        // New result
        results.unshift(data.result);
        // Keep only last 500 results in memory
        if (results.length > 500) {
          results = results.slice(0, 500);
        }
        addNewPill(data.result);
        updateStats();
        updateChart();
      } else if (data.type === 'live') {
        // Live game state update
        updateLiveDisplay(data.state);
      }
    } catch (e) {
      console.error('Failed to parse message:', e);
    }
  };
}

// Update live display with current game state from Stake
function updateLiveDisplay(state) {
  const { status, multiplier, gameId } = state;

  // Update status text based on Stake's statuses
  const statusText = {
    'in_progress': 'IN PROGRESS',
    'starting': 'PLACE BETS',
    'start': 'STARTING...',
    'crash': 'CRASHED',
    'pending': 'WAITING'
  };
  liveStatus.textContent = statusText[status] || status.toUpperCase();

  // Update multiplier display directly from Stake's data
  liveMultiplier.textContent = formatMultiplier(multiplier);

  // Update display styling based on status
  liveDisplay.className = 'live-display';

  if (status === 'in_progress') {
    liveDisplay.classList.add('progress');
    // Add tier colors based on multiplier
    if (multiplier >= 1000) {
      liveDisplay.classList.add('tier-gold');
    } else if (multiplier >= 100) {
      liveDisplay.classList.add('tier-purple');
    } else if (multiplier >= 2) {
      liveDisplay.classList.add('tier-green');
    }
  } else if (status === 'crash') {
    liveDisplay.classList.add('crashed');
  } else if (status === 'starting' || status === 'start') {
    liveDisplay.classList.add('betting');
  }

  liveGame.status = status;
  liveGame.gameId = gameId;
}

// Get color class for multiplier
function getColorClass(multiplier) {
  if (multiplier < 1.01) return 'red';      // 1.0x instant crash
  if (multiplier < 2) return 'orange';       // 1.01x - 1.99x
  if (multiplier < 100) return 'green';      // 2.0x - 99.99x
  if (multiplier < 1000) return 'purple';    // 100x - 999.99x
  return 'gold';                             // 1000x+ moon shots
}

// Format multiplier for display
function formatMultiplier(multiplier) {
  if (multiplier >= 1000) {
    return multiplier.toFixed(0) + 'x';
  }
  return multiplier.toFixed(2) + 'x';
}

// Create a pill element
function createPill(result, isNew = false) {
  const pill = document.createElement('div');
  pill.className = `pill ${getColorClass(result.multiplier)}${isNew ? ' new' : ''}`;
  pill.textContent = formatMultiplier(result.multiplier);
  pill.title = `Game: ${result.gameId}\nTime: ${new Date(result.timestamp).toLocaleString()}`;
  return pill;
}

// Add a new pill at the beginning
function addNewPill(result) {
  const pill = createPill(result, true);
  resultsGrid.insertBefore(pill, resultsGrid.firstChild);

  // Remove excess pills (keep max 200 in DOM)
  while (resultsGrid.children.length > 200) {
    resultsGrid.removeChild(resultsGrid.lastChild);
  }
}

// Render all results
function renderResults() {
  resultsGrid.innerHTML = '';
  const displayResults = results.slice(0, 200);
  displayResults.forEach(result => {
    resultsGrid.appendChild(createPill(result));
  });
}

// Calculate statistics
function calculateStats() {
  if (results.length === 0) {
    return {
      average: null,
      median: null,
      min: null,
      max: null,
      count: 0,
      since1x: null,
      since1000x: null,
      distribution: { red: 0, orange: 0, green: 0, purple: 0, gold: 0 }
    };
  }

  const multipliers = results.map(r => r.multiplier);
  const sorted = [...multipliers].sort((a, b) => a - b);

  const sum = multipliers.reduce((a, b) => a + b, 0);
  const average = sum / multipliers.length;

  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

  // Distribution buckets
  const distribution = { red: 0, orange: 0, green: 0, purple: 0, gold: 0 };
  multipliers.forEach(m => {
    if (m < 1.01) distribution.red++;
    else if (m < 2) distribution.orange++;
    else if (m < 100) distribution.green++;
    else if (m < 1000) distribution.purple++;
    else distribution.gold++;
  });

  // Get streak counters from latest result
  const latest = results[0];

  return {
    average,
    median,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    count: results.length,
    since1x: latest?.gamesSinceLast1x ?? null,
    since1000x: latest?.gamesSinceLast1000x ?? null,
    distribution
  };
}

// Update stats display
function updateStats() {
  const stats = calculateStats();

  statGames.textContent = stats.count.toLocaleString();
  statAverage.textContent = stats.average !== null ? stats.average.toFixed(2) + 'x' : '--';
  statMedian.textContent = stats.median !== null ? stats.median.toFixed(2) + 'x' : '--';
  statMin.textContent = stats.min !== null ? stats.min.toFixed(2) + 'x' : '--';
  statMax.textContent = stats.max !== null ? formatMultiplier(stats.max) : '--';
  statSince1x.textContent = stats.since1x !== null ? stats.since1x : '--';
  statSince1000x.textContent = stats.since1000x !== null ? stats.since1000x : '--';
}

// Initialize or update chart
function updateChart() {
  const stats = calculateStats();
  const dist = stats.distribution;

  const data = {
    labels: ['1.0x', '1.01-1.99x', '2-99x', '100-999x', '1000x+'],
    datasets: [{
      data: [dist.red, dist.orange, dist.green, dist.purple, dist.gold],
      backgroundColor: [
        'rgba(255, 71, 87, 0.7)',
        'rgba(255, 165, 2, 0.7)',
        'rgba(46, 213, 115, 0.7)',
        'rgba(168, 85, 247, 0.7)',
        'rgba(255, 215, 0, 0.7)'
      ],
      borderColor: [
        '#ff4757',
        '#ffa502',
        '#2ed573',
        '#a855f7',
        '#ffd700'
      ],
      borderWidth: 1
    }]
  };

  if (chart) {
    chart.data = data;
    chart.update('none');
  } else {
    const ctx = document.getElementById('distributionChart').getContext('2d');
    chart = new Chart(ctx, {
      type: 'bar',
      data,
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: false
          },
          tooltip: {
            callbacks: {
              label: (context) => {
                const total = stats.count;
                const value = context.raw;
                const percent = total > 0 ? ((value / total) * 100).toFixed(1) : 0;
                return `${value} games (${percent}%)`;
              }
            }
          }
        },
        scales: {
          x: {
            grid: {
              color: 'rgba(255, 255, 255, 0.1)'
            },
            ticks: {
              color: '#888'
            }
          },
          y: {
            grid: {
              color: 'rgba(255, 255, 255, 0.1)'
            },
            ticks: {
              color: '#888'
            }
          }
        }
      }
    });
  }
}

// Render everything
function renderAll() {
  renderResults();
  updateStats();
  updateChart();
}

// Start connection
connect();
