const Elements = {
  overview: document.getElementById('overview-cards'),
  rare: document.getElementById('rare-cards'),
  topTbody: document.querySelector('#top-table tbody'),
  footnote: document.getElementById('footnote'),
  selector: document.getElementById('period-selector'),
  chartDistribution: document.getElementById('chart-distribution'),
  chartVolume: document.getElementById('chart-volume'),
  chartMean: document.getElementById('chart-mean'),
  chart1000x: document.getElementById('chart-1000x'),
  chartInstant: document.getElementById('chart-instant'),
  titleVolume: document.getElementById('title-volume'),
  titleMean: document.getElementById('title-mean'),
  title1000x: document.getElementById('title-1000x'),
  titleInstant: document.getElementById('title-instant')
};

const colors = {
  red: '#f6465d',
  orange: '#ff9f43',
  green: '#0ecb81',
  purple: '#a855f7',
  turquoise: '#00d2d3'
};

const State = {
  period: 'all',
  charts: {}
};

function fmtInt(n) {
  if (n === undefined || n === null || Number.isNaN(n)) return '--';
  return Math.round(n).toLocaleString();
}

function fmtFloat(n, d = 2) {
  if (n === undefined || n === null || Number.isNaN(n)) return '--';
  return Number(n).toFixed(d);
}

function fmtMult(n) {
  if (n === undefined || n === null || Number.isNaN(n)) return '--';
  if (n >= 1000) return Math.round(n).toLocaleString() + 'x';
  return Number(n).toFixed(2) + 'x';
}

function card(label, value) {
  const div = document.createElement('div');
  div.className = 'stat-card';
  div.innerHTML = `<div class="stat-label">${label}</div><div class="stat-value">${value}</div>`;
  return div;
}

function formatBucketLabel(key, unit) {
  if (!key || key === 'unknown') return key || '';
  if (unit === 'hour') {
    return key.replace('T', ' ').replace(':00', 'h');
  }
  return key;
}

function baseChartOptions(extra = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: { intersect: false, mode: 'index' } },
    scales: {
      y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#929aa5' } },
      x: { grid: { display: false }, ticks: { color: '#929aa5', maxRotation: 0, autoSkip: true, autoSkipPadding: 12 } }
    },
    ...extra
  };
}

function destroyCharts() {
  Object.values(State.charts).forEach(c => c && c.destroy && c.destroy());
  State.charts = {};
}

async function refresh() {
  Elements.overview.innerHTML = '';
  Elements.rare.innerHTML = '';
  Elements.topTbody.innerHTML = '';
  Elements.footnote.textContent = 'Loading…';
  destroyCharts();

  let data;
  try {
    const res = await fetch(`/api/analytics?period=${encodeURIComponent(State.period)}`);
    data = await res.json();
  } catch (e) {
    Elements.overview.textContent = 'Failed to load analytics.';
    Elements.footnote.textContent = '';
    console.error(e);
    return;
  }
  if (!data || !data.total) {
    Elements.overview.textContent = 'No data in this period.';
    Elements.footnote.textContent = '';
    return;
  }
  updateChartTitles(data.bucketUnit);
  renderOverview(data);
  renderRare(data);
  renderDistribution(data);
  renderBuckets(data);
  renderTop(data);
  renderFootnote(data);
}

function updateChartTitles(unit) {
  const suffix = unit === 'hour' ? 'Per Hour' : 'Per Day';
  Elements.titleVolume.textContent = `Games ${suffix}`;
  Elements.titleMean.textContent = `Mean Multiplier ${suffix === 'Per Hour' ? 'Per Hour' : 'Per Day'}`;
  Elements.title1000x.textContent = `1000x+ ${suffix}`;
  Elements.titleInstant.textContent = `Instant Crashes ${suffix}`;
}

function renderOverview(d) {
  const isShort = d.bucketUnit === 'hour';
  const rateLabel = isShort ? 'GAMES / HOUR (avg)' : 'GAMES / DAY (avg)';
  const rateValue = isShort ? fmtInt(d.gamesPerHour) : fmtInt(d.gamesPerDay);
  const spanLabel = isShort ? 'HOURS COVERED' : 'DAYS COVERED';
  const spanValue = isShort ? fmtFloat(d.spanHours, 1) : fmtFloat(d.spanDays, 1);
  const items = [
    ['TOTAL GAMES', fmtInt(d.total)],
    [spanLabel, spanValue],
    [rateLabel, rateValue],
    ['MEAN', fmtMult(d.mean)],
    ['MEDIAN', fmtMult(d.median)],
    ['P90', fmtMult(d.p90)],
    ['P99', fmtMult(d.p99)],
    ['HIGHEST', fmtMult(d.max)]
  ];
  items.forEach(([k, v]) => Elements.overview.appendChild(card(k, v)));
}

function renderRare(d) {
  const items = [
    ['1000x+ EVENTS', fmtInt(d.count1000x)],
    ['AVG GAP (1000x)', fmtFloat(d.avgGap1000x, 1)],
    ['MAX GAP (1000x)', fmtInt(d.maxGap1000x)],
    ['CURRENT GAP (1000x)', fmtInt(d.currentGap1000x)],
    ['<1.01x EVENTS', fmtInt(d.countLt1_01)],
    ['AVG GAP (<1.01x)', fmtFloat(d.avgGapLt1_01, 1)],
    ['MAX GAP (<1.01x)', fmtInt(d.maxGapLt1_01)],
    ['BACK-TO-BACK <1.01x', fmtInt(d.countDouble1x)]
  ];
  items.forEach(([k, v]) => Elements.rare.appendChild(card(k, v)));
}

function renderDistribution(d) {
  const data = [
    d.distribution.red,
    d.distribution.orange,
    d.distribution.green,
    d.distribution.purple,
    d.distribution.turquoise
  ];
  const total = data.reduce((a, b) => a + b, 0);
  State.charts.distribution = new Chart(Elements.chartDistribution, {
    type: 'bar',
    data: {
      labels: ['<1.01x', '1.01–1.99', '2–99', '100–999', '1000+'],
      datasets: [{
        data,
        backgroundColor: Object.values(colors).map(c => c + '44'),
        borderColor: Object.values(colors),
        borderWidth: 2,
        borderRadius: 4
      }]
    },
    options: baseChartOptions({
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const v = ctx.parsed.y;
              const pct = total ? ((v / total) * 100).toFixed(2) : '0';
              return `${v.toLocaleString()}  (${pct}%)`;
            }
          }
        }
      }
    })
  });
}

function renderBuckets(d) {
  const labels = d.buckets.map(b => formatBucketLabel(b.key, d.bucketUnit));
  const volume = d.buckets.map(b => b.total);
  const mean = d.buckets.map(b => b.meanMultiplier);
  const c1000x = d.buckets.map(b => b.count1000x);
  const cInstant = d.buckets.map(b => b.countLt);

  State.charts.volume = new Chart(Elements.chartVolume, {
    type: 'bar',
    data: { labels, datasets: [{ data: volume, backgroundColor: colors.green + '88', borderColor: colors.green, borderWidth: 1 }] },
    options: baseChartOptions()
  });
  State.charts.mean = new Chart(Elements.chartMean, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: mean,
        borderColor: colors.purple,
        backgroundColor: colors.purple + '33',
        tension: 0.25,
        pointRadius: 0,
        fill: true
      }]
    },
    options: baseChartOptions()
  });
  State.charts.c1000x = new Chart(Elements.chart1000x, {
    type: 'bar',
    data: { labels, datasets: [{ data: c1000x, backgroundColor: colors.turquoise + '88', borderColor: colors.turquoise, borderWidth: 1 }] },
    options: baseChartOptions()
  });
  State.charts.cInstant = new Chart(Elements.chartInstant, {
    type: 'bar',
    data: { labels, datasets: [{ data: cInstant, backgroundColor: colors.red + '88', borderColor: colors.red, borderWidth: 1 }] },
    options: baseChartOptions()
  });
}

function renderTop(d) {
  d.topMultipliers.forEach((row, i) => {
    const tr = document.createElement('tr');
    const when = row.timestamp ? new Date(row.timestamp).toLocaleString() : '--';
    tr.innerHTML = `<td>${i + 1}</td><td class="mult-cell">${fmtMult(row.multiplier)}</td><td>${when}</td><td class="game-id">${row.gameId}</td>`;
    Elements.topTbody.appendChild(tr);
  });
}

function renderFootnote(d) {
  const first = d.firstMs ? new Date(d.firstMs).toLocaleString() : '?';
  const last = d.lastMs ? new Date(d.lastMs).toLocaleString() : '?';
  Elements.footnote.textContent = `Data range: ${first} → ${last}`;
}

function setupSelector() {
  Elements.selector.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-period]');
    if (!btn) return;
    State.period = btn.dataset.period;
    Elements.selector.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
    refresh();
  });
}

setupSelector();
refresh();
