// Dashboard UI for the full Auroch engine.
// All numbers come from data inside this folder (snapshot subgraph, measured CSV/JSON/plots).

import { runProtocol, tauFromLiquidity, F_MIN, F_MAX } from './protocolEngine.js';
import SUBGRAPH from '../data/snapshot_subgraph.json';
import MEASURED from '../data/measured_results.json';
import METADATA from '../data/metadata.json';
import AVG_CSV from '../data/averaged.csv?raw';
import SNAPSHOT_CSV from '../data/snapshot_summary.csv?raw';
import SUCCESS from '../data/success_experiment.json';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import Chart from 'chart.js/auto';


const el = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v, digits = 2) => (typeof v === 'number' ? Number(v.toFixed(digits)).toLocaleString() : (v ?? '—'));

let current = null;
let stepIndex = 0;
let playing = false;
let playTimer = null;

/* ------------------------------------------------------------------ */
/* Tabs                                                                */
/* ------------------------------------------------------------------ */

el('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === btn));
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  el(`view-${btn.dataset.tab}`).classList.add('active');
});

el('insp-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.insp-tab');
  if (!btn) return;
  document.querySelectorAll('.insp-tab').forEach((t) => t.classList.toggle('active', t === btn));
  document.querySelectorAll('.insp-body').forEach((b) => b.classList.remove('active'));
  el(`insp-${btn.dataset.insp}`).classList.add('active');
});

/* ------------------------------------------------------------------ */
/* Engine controls                                                     */
/* ------------------------------------------------------------------ */

el('cfg-alpha').addEventListener('input', () => { el('alpha-val').textContent = Number(el('cfg-alpha').value).toFixed(1); });
el('cfg-speed').addEventListener('input', () => { el('speed-val').textContent = `${el('cfg-speed').value}x`; });
el('btn-run').addEventListener('click', runEngine);
el('btn-reset').addEventListener('click', resetEngine);
el('btn-prev').addEventListener('click', () => { stopPlay(); if (current) { stepIndex = Math.max(0, stepIndex - 1); renderStep(); } });
el('btn-next').addEventListener('click', () => { stopPlay(); if (current) { stepIndex = Math.min(current.steps.length - 1, stepIndex + 1); renderStep(); } });
el('btn-play').addEventListener('click', togglePlay);
el('scrubber').addEventListener('input', (e) => { stopPlay(); if (current) { stepIndex = Number(e.target.value); renderStep(); } });

function readConfig() {
  return {
    topology: el('cfg-topology').value,
    amount: Math.max(1, Number(el('cfg-amount').value) || 1),
    tauMode: el('cfg-tau-mode').value,
    alpha: Number(el('cfg-alpha').value),
    scale: Number(el('cfg-scale').value),
    seed: Number(el('cfg-seed').value) || 1,
  };
}

function runEngine() {
  stopPlay();
  const cfg = readConfig();
  current = runProtocol(cfg);
  stepIndex = 0;
  el('engine-status').textContent = current.summary.success ? 'RUN OK' : 'NO ROUTE';
  el('source-info').innerHTML = cfg.topology === 'snapshot'
    ? `<b>lngraph_2021_11_27__21_00.json</b><br>${SUBGRAPH.counts.nodes.toLocaleString()} nodes / ${SUBGRAPH.counts.channels.toLocaleString()} channels in full snapshot; ${SUBGRAPH.counts.nodes} / ${SUBGRAPH.counts.channels} shown as subgraph.<br>50:50 directional liquidity assumption.`
    : '<b>6-node protocol demonstration</b><br>Exact message-by-message execution of RREQ, RREP, AUC, BID, Eq6, Eq7, HTLC and settle.';
  el('phase-strip').innerHTML = '';
  current.steps.forEach((s, i) => {
    const chip = document.createElement('button');
    chip.className = 'phase-chip';
    chip.textContent = s.phase;
    chip.title = s.title;
    chip.addEventListener('click', () => { stopPlay(); stepIndex = i; renderStep(); });
    el('phase-strip').appendChild(chip);
  });
  renderStep();
}

function resetEngine() {
  stopPlay();
  current = null;
  stepIndex = 0;
  el('engine-status').textContent = 'READY';
  el('phase-strip').innerHTML = '';
  el('network-map').innerHTML = '';
  el('step-detail').innerHTML = '<div class="empty">Run the engine to watch every protocol message.</div>';
  el('insp-log').innerHTML = '';
  el('insp-tables').innerHTML = '';
  el('insp-metrics').innerHTML = '';
  el('scrubber').max = 1;
  el('scrubber').value = 0;
  el('scrub-label').textContent = '0 / 0';
}

function togglePlay() {
  if (!current) return;
  if (playing) { stopPlay(); return; }
  if (stepIndex >= current.steps.length - 1) stepIndex = 0;
  playing = true;
  el('btn-play').textContent = '❚❚ Pause';
  const tick = () => {
    if (!playing || !current) return;
    if (stepIndex >= current.steps.length - 1) { stopPlay(); return; }
    stepIndex++;
    renderStep();
    playTimer = setTimeout(tick, Math.max(220, 1500 - Number(el('cfg-speed').value) * 130));
  };
  playTimer = setTimeout(tick, 300);
}

function stopPlay() {
  playing = false;
  if (playTimer) clearTimeout(playTimer);
  playTimer = null;
  el('btn-play').textContent = '▶ Play';
}

/* ------------------------------------------------------------------ */
/* Engine rendering                                                    */
/* ------------------------------------------------------------------ */

function renderStep() {
  if (!current) return;
  const s = current.steps[stepIndex];
  renderEngineMap(s);
  renderDetail(s);
  renderInspector(s);
  document.querySelectorAll('.phase-chip').forEach((c, i) => {
    c.classList.toggle('current', i === stepIndex);
    c.classList.toggle('done', i < stepIndex);
  });
  el('scrubber').max = current.steps.length - 1;
  el('scrubber').value = stepIndex;
  el('scrub-label').textContent = `${stepIndex + 1} / ${current.steps.length}`;
}

function nodeMap(net) {
  const m = new Map();
  net.nodes.forEach((n) => m.set(n.id, n));
  return m;
}

function drawMap(svg, nodes, channels, opts = {}) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const padX = Math.max(8, (maxX - minX) * 0.12), padY = Math.max(8, (maxY - minY) * 0.12);
  svg.setAttribute('viewBox', `${minX - padX} ${minY - padY} ${maxX - minX + 2 * padX} ${maxY - minY + 2 * padY}`);

  const packets = opts.packets || [];
  const activeNodes = new Set(opts.activeNodes || []);
  const activeEdges = new Set();
  packets.forEach((p) => activeEdges.add(`${p.from}|${p.to}`));

  const parts = [];
  channels.forEach((c) => {
    const a = byId.get(c.u), b = byId.get(c.v);
    if (!a || !b) return;
    const on = activeEdges.has(`${c.u}|${c.v}`) || activeEdges.has(`${c.v}|${c.u}`);
    parts.push(`<line class="edge${on ? ' active' : ''}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" />`);
  });

  const r = nodes.length > 30 ? 1.15 : 2.4;
  nodes.forEach((n) => {
    const on = activeNodes.has(n.id);
    const color = n.color || (on ? '#00e5ff' : '#5b7fa8');
    parts.push(`<circle cx="${n.x}" cy="${n.y}" r="${on ? r * 1.5 : r}" fill="${color}" stroke="${on ? '#fff' : 'none'}" stroke-width="${on ? .5 : 0}" opacity="${on ? 1 : .82}" />`);
    if (opts.showAllLabels || on || nodes.length <= 10) {
      parts.push(`<text class="node-label${on ? ' active' : ''}" x="${n.x + r + .6}" y="${n.y + 1}">${esc(n.label)}</text>`);
    }
  });

  packets.slice(0, 60).forEach((p) => {
    const a = byId.get(p.from), b = byId.get(p.to);
    if (!a || !b) return;
    const dur = 1.2 + (packets.indexOf(p) % 4) * 0.15;
    parts.push(`<circle r="${nodes.length > 30 ? .7 : 1.1}" fill="#f59e0b" opacity=".95"><animateMotion dur="${dur}s" repeatCount="indefinite" path="M ${a.x} ${a.y} L ${b.x} ${b.y}" /></circle>`);
  });

  svg.innerHTML = parts.join('');
}

function renderEngineMap(s) {
  const cfg = readConfig();
  if (cfg.topology === 'snapshot') {
    drawMap(el('network-map'), current.net.nodes, current.net.channels, {
      packets: s.packets, activeNodes: s.activeNodes, showAllLabels: false,
    });
  } else {
    drawMap(el('network-map'), current.net.nodes, current.net.channels, {
      packets: s.packets, activeNodes: s.activeNodes, showAllLabels: true,
    });
  }
  el('map-legend').innerHTML =
    '<span><i style="background:#00e5ff"></i>active node</span>' +
    '<span><i style="background:#5b7fa8"></i>inactive</span>' +
    '<span><i style="background:#f59e0b"></i>message in flight</span>';
}

function renderDetail(s) {
  const chips = Object.entries(s.metrics || {}).map(([k, v]) =>
    `<span class="metric-chip">${esc(k.replace(/([A-Z])/g, ' $1').toLowerCase())} <b>${esc(fmt(v))}</b></span>`).join('');
  el('step-detail').innerHTML = `
    <div class="detail-head"><span class="phase-badge">${esc(s.phase)}</span><h3>${esc(s.title)}</h3></div>
    <p class="detail-text">${esc(s.detail)}</p>
    <div class="metric-chips">${chips}</div>`;
}

function messageCard(msg, cls = '') {
  if (typeof msg === 'string') return `<div class="msg-card ${cls}">${esc(msg)}</div>`;
  const rows = Object.entries(msg).map(([k, v]) =>
    `<span class="k">${esc(k)}</span>: <span class="v">${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</span>`).join('<br>');
  return `<div class="msg-card ${cls}">${rows}</div>`;
}

function tableHtml(rows) {
  if (!rows || !rows.length) return '<div class="msg-empty">No rows.</div>';
  const headers = Object.keys(rows[0]);
  const head = `<thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>`;
  const body = `<tbody>${rows.slice(0, 120).map((r) =>
    `<tr>${headers.map((h) => `<td>${esc(fmt(r[h]))}</td>`).join('')}</tr>`).join('')}</tbody>`;
  return `<table>${head}${body}</table>`;
}

function renderInspector(s) {
  el('insp-log').innerHTML = (s.messages || []).length
    ? s.messages.map((m) => messageCard(m, ['BID', 'EQ6', 'EQ7', 'HTLC', 'SETTLE'].includes(s.phase) ? 'eq' : '')).join('')
    : '<div class="msg-empty">No messages in this phase.</div>';

  const tables = Object.entries(s.tables || {});
  el('insp-tables').innerHTML = tables.length
    ? tables.map(([name, rows]) => `<div class="table-title">${esc(name)} · ${rows.length} rows</div>${tableHtml(rows)}`).join('')
    : '<div class="msg-empty">No data table for this phase.</div>';

  const m = s.metrics || {};
  const boxes = Object.entries(m).map(([k, v]) => {
    const cls = /success|ok/i.test(k) ? (v === true || v === 1 ? ' ok' : ' bad') : '';
    return `<div class="metric-box${cls}"><div class="label">${esc(k.replace(/([A-Z])/g, ' $1').toLowerCase())}</div><div class="value">${esc(fmt(v))}</div></div>`;
  }).join('');
  let summaryHtml = '';
  if (stepIndex === current.steps.length - 1) {
    const sm = current.summary;
    summaryHtml = `<div class="table-title">Run summary</div><div class="metric-grid">
      ${[['Sender', sm.source], ['Receiver', sm.destination], ['Requested', fmt(sm.requestedAmount)], ['Allocated', fmt(sm.allocated)],
         ['Total fee', fmt(sm.totalFee)], ['Auctions', fmt(sm.auctions)], ['Bids', fmt(sm.bids)], ['Rule 1 / Rule 2', `${sm.rule1} / ${sm.rule2}`],
         ['Completed routes', fmt(sm.completedRoutes)], ['Selected paths', fmt(sm.selectedPaths)], ['Mean bid price', fmt(sm.meanBidPrice)], ['Mean tau', fmt(sm.meanTau)]]
        .map(([k, v]) => `<div class="metric-box"><div class="label">${esc(k)}</div><div class="value" style="font-size:13px">${esc(v)}</div></div>`).join('')}
    </div>`;
  }
  el('insp-metrics').innerHTML = `<div class="metric-grid">${boxes}</div>${summaryHtml}`;
}

/* ------------------------------------------------------------------ */
/* Network map view                                                    */
/* ------------------------------------------------------------------ */

function initNetworkView() {
  el('network-head-note').textContent =
    `Exact snapshot ${METADATA.input_snapshot} · ${SUBGRAPH.counts.nodes.toLocaleString()} nodes / ${SUBGRAPH.counts.channels.toLocaleString()} channels in full graph · displayed subgraph: ${SUBGRAPH.counts.nodes} nodes / ${SUBGRAPH.counts.channels} channels.`;
  el('net-stats').innerHTML = [
    ['Full snapshot nodes', METADATA.snapshot_counts.nodes.toLocaleString()],
    ['Full snapshot channels', METADATA.snapshot_counts.channels.toLocaleString()],
    ['Paper-reported nodes', METADATA.paper_reported_counts.nodes.toLocaleString()],
    ['Counts match paper', String(METADATA.counts_match_paper)],
    ['Subgraph nodes', SUBGRAPH.counts.nodes],
    ['Subgraph channels', SUBGRAPH.counts.channels],
  ].map(([l, v]) => `<div class="net-stat"><div class="label">${esc(l)}</div><div class="value">${esc(v)}</div></div>`).join('');

  const nodes = SUBGRAPH.nodes.map((n, i) => ({ id: i, label: n.alias || `#${i}`, x: n.x, y: n.y, color: n.isHub ? '#00e5ff' : '#5b7fa8', degree: n.degree, hub: n.isHub }));
  const channels = SUBGRAPH.edges.map((e) => ({ u: e.u, v: e.v, cap: e.cap }));
  drawMap(el('snapshot-map'), nodes, channels, { showAllLabels: false });
  el('snapshot-map').querySelectorAll('circle').forEach((c) => {
    c.style.cursor = 'pointer';
    c.addEventListener('click', () => {
      const x = Number(c.getAttribute('cx')), y = Number(c.getAttribute('cy'));
      const n = nodes.find((z) => z.x === x && z.y === y);
      if (n) showNodeDetails(n, channels);
    });
  });
  showNodeDetails(nodes.find((n) => n.hub) || nodes[0], channels);
}

function showNodeDetails(n, channels) {
  if (!n) return;
  const adjacent = channels.filter((c) => c.u === n.id || c.v === n.id);
  const totalCap = adjacent.reduce((s, c) => s + c.cap, 0);
  const top = adjacent.slice().sort((a, b) => b.cap - a.cap).slice(0, 8);
  el('net-side').innerHTML = `
    <div class="card"><h3>NODE DETAIL</h3>
      <table><tbody>
        <tr><td>alias</td><td>${esc(n.label)}</td></tr>
        <tr><td>id</td><td>${esc(n.id)}</td></tr>
        <tr><td>degree</td><td>${esc(n.degree)}</td></tr>
        <tr><td>hub</td><td>${esc(n.hub ? 'yes' : 'no')}</td></tr>
        <tr><td>ring</td><td>${esc(SUBGRAPH.nodes[n.id].ring)}</td></tr>
        <tr><td>snapshot links</td><td>${esc(adjacent.length)}</td></tr>
        <tr><td>sum capacity</td><td>${esc(totalCap.toLocaleString())} sat</td></tr>
      </tbody></table>
    </div>
    <div class="card"><h3>LARGEST LOCAL CHANNELS</h3>
      <table><thead><tr><th>channel</th><th>peer</th><th>capacity</th></tr></thead><tbody>
      ${top.map((c) => { const peer = c.u === n.id ? c.v : c.u; const p = SUBGRAPH.nodes[peer]; return `<tr><td>${esc(String(c.u).slice(0, 10))}</td><td>${esc((p && p.alias) || `#${peer}`)}</td><td>${esc(c.cap.toLocaleString())}</td></tr>`; }).join('')}
      </tbody></table>
      <p class="projection-note">Liquidity is assumed 50:50; the snapshot records capacity and policies, not live balances.</p>
    </div>`;
}

/* ------------------------------------------------------------------ */
/* Measured data view — live Chart.js plots from raw CSV / JSON        */
/* ------------------------------------------------------------------ */

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    const row = {};
    headers.forEach((h, i) => { row[h] = cells[i]; });
    return row;
  });
}

const DV_METHODS = [
  { key: 'auroch_dynamic_proxy', label: 'Auroch + dynamic fee (α=2)', color: '#00e5ff' },
  { key: 'auroch_proxy', label: 'Auroch multipath (3 candidates)', color: '#a855f7' },
  { key: 'dijkstra_proxy', label: 'Modified Dijkstra (single path)', color: '#f59e0b' },
  { key: 'speedymurmurs_proxy', label: 'SpeedyMurmurs (3 landmarks)', color: '#10b981' },
  { key: 'spider_proxy', label: 'Spider multipath (4 candidates)', color: '#ef4444' },
];

const DV_METRICS = [
  { key: 'success_ratio', label: 'Success ratio', unit: '', fmt: (v) => `${(v * 100).toFixed(1)}%`, higherBetter: true },
  { key: 'success_volume', label: 'Success volume', unit: '', fmt: (v) => `${(v * 100).toFixed(1)}%`, higherBetter: true },
  { key: 'routing_cost', label: 'Routing cost', unit: '', fmt: (v) => v.toFixed(2), higherBetter: false },
  { key: 'mean_paths', label: 'Mean paths', unit: '', fmt: (v) => v.toFixed(2), higherBetter: true },
  { key: 'mean_hops', label: 'Mean hops', unit: '', fmt: (v) => v.toFixed(2), higherBetter: false },
  { key: 'mean_fee_sats', label: 'Mean fee (sat)', unit: ' sat', fmt: (v) => Math.round(v).toLocaleString(), higherBetter: false },
  { key: 'mean_route_seconds', label: 'Mean route time (s)', unit: ' s', fmt: (v) => v.toExponential(2), higherBetter: false },
];

const DV_JSON_METHODS = [
  { key: 'staticAuroch', label: 'Static Auroch', color: '#00e5ff' },
  { key: 'dynamicAuroch', label: 'Dynamic Auroch', color: '#a855f7' },
  { key: 'dijkstra', label: 'Dijkstra', color: '#f59e0b' },
  { key: 'spider', label: 'Spider', color: '#10b981' },
  { key: 'speedy', label: 'SpeedyMurmurs', color: '#ef4444' },
];

const DV_JSON_METRICS = [
  { key: 'success_ratio', label: 'Success ratio', fmt: (v) => `${(v * 100).toFixed(1)}%` },
  { key: 'success_volume', label: 'Success volume', fmt: (v) => `${(v * 100).toFixed(1)}%` },
  { key: 'routing_cost', label: 'Routing cost', fmt: (v) => v.toFixed(2) },
  { key: 'mean_paths', label: 'Mean paths', fmt: (v) => v.toFixed(2) },
];

let dvCharts = {};

function dvRow(count, method, scale) {
  return AVG_ROWS.find((r) => r.transaction_count === count && r.method === method && Number(r.capacity_scale) === scale);
}

function dvBaseChartOptions(yTitle, tooltipLabel, extraPlugins = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'nearest', intersect: true },
    plugins: {
      legend: { position: 'bottom', labels: { boxWidth: 20, boxHeight: 3, padding: 12, font: { size: 10 } } },
      tooltip: {
        ...srTooltipStyle,
        callbacks: {
          title: (items) => (items.length ? `${items[0].parsed.x}× capacity` : ''),
          label: (ctx) => tooltipLabel(ctx),
        },
      },
      ...extraPlugins,
    },
    scales: {
      x: {
        title: { display: true, text: 'Capacity multiplier (× initial channel capacity)', color: '#7e93ae', font: { size: 10 } },
        grid: { color: '#142034' },
        ticks: { color: '#8fa4bf', callback: (v) => `${v}×` },
      },
      y: {
        title: { display: true, text: yTitle, color: '#7e93ae', font: { size: 10 } },
        grid: { color: '#1d2b40' },
        ticks: { color: '#8fa4bf' },
      },
    },
  };
}

function drawBenchCharts() {
  const count = el('bench-count').value;
  const metric = DV_METRICS.find((m) => m.key === el('bench-metric').value);
  const scales = [...new Set(AVG_ROWS.map((r) => Number(r.capacity_scale)))].sort((a, b) => a - b);
  const sdKey = `${metric.key}_std`;

  // Main: metric vs capacity scale, all five methods with error bars.
  const mainData = DV_METHODS.map((m) => ({
    label: m.label,
    data: scales.map((s) => {
      const row = dvRow(count, m.key, s);
      return { x: s, y: row ? Number(row[metric.key]) : null, row, method: m.label };
    }),
    borderColor: m.color,
    backgroundColor: m.color,
    borderWidth: 2.2,
    pointRadius: 3,
    pointHoverRadius: 6,
    pointBackgroundColor: '#0a111c',
    pointBorderColor: m.color,
    pointBorderWidth: 2,
    tension: 0.2,
    spanGaps: true,
  }));

  if (dvCharts.main) dvCharts.main.destroy();
  dvCharts.main = new Chart(el('bench-main-chart'), {
    type: 'line',
    data: { datasets: mainData },
    options: dvBaseChartOptions(metric.label, (ctx) => {
      const r = ctx.raw && ctx.raw.row;
      if (!r || r[metric.key] == null) return '';
      return [
        `${ctx.dataset.label} · ${ctx.parsed.x}× · ${count} tx`,
        `${metric.label}: ${metric.fmt(Number(r[metric.key]))} ± ${metric.fmt(Number(r[sdKey] || 0))}`,
        `Mean of ${r.runs} runs · ${Number(r[metric.key]).toFixed(6)} raw`,
      ];
    }, { srErrorBars: { key: sdKey } }),
    plugins: [srErrorBarsPlugin],
  });

  // Delta: dynamic Auroch minus each baseline, across scale.
  const baselines = DV_METHODS.slice(1);
  const deltaData = baselines.map((b) => ({
    label: `dyn Auroch − ${b.label}`,
    data: scales.map((s) => {
      const dyn = dvRow(count, 'auroch_dynamic_proxy', s);
      const base = dvRow(count, b.key, s);
      return dyn && base ? { x: s, y: Number(dyn[metric.key]) - Number(base[metric.key]) } : { x: s, y: null };
    }),
    borderColor: b.color,
    backgroundColor: b.color,
    borderWidth: 2,
    pointRadius: 2.8,
    pointHoverRadius: 5,
    tension: 0.2,
    spanGaps: true,
  }));
  if (dvCharts.delta) dvCharts.delta.destroy();
  dvCharts.delta = new Chart(el('bench-delta-chart'), {
    type: 'line',
    data: { datasets: deltaData },
    options: dvBaseChartOptions(`Δ ${metric.label} (dynamic Auroch − baseline)`, (ctx) =>
      `${ctx.dataset.label}: ${metric.fmt(ctx.parsed.y)} at ${ctx.parsed.x}×`),
  });

  // Scale gain: relative change from 1× to 10×, per method.
  const gainData = DV_METHODS.map((m) => {
    const first = dvRow(count, m.key, scales[0]);
    const last = dvRow(count, m.key, scales[scales.length - 1]);
    const a = first ? Number(first[metric.key]) : NaN;
    const b = last ? Number(last[metric.key]) : NaN;
    return {
      label: m.label,
      value: a && isFinite(a) ? (b - a) / a : null,
      color: m.color,
      from: a,
      to: b,
    };
  });
  if (dvCharts.gain) dvCharts.gain.destroy();
  dvCharts.gain = new Chart(el('bench-gain-chart'), {
    type: 'bar',
    data: {
      labels: gainData.map((g) => g.label.replace(' (', '\n(')),
      datasets: [{
        label: 'Relative change 1× → 10×',
        data: gainData.map((g) => g.value == null ? null : g.value * 100),
        backgroundColor: gainData.map((g) => g.color),
        borderColor: '#0a111c',
        borderWidth: 1,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          ...srTooltipStyle,
          callbacks: {
            label: (ctx) => {
              const g = gainData[ctx.dataIndex];
              return `${g.from != null ? metric.fmt(g.from) : '?'} → ${g.to != null ? metric.fmt(g.to) : '?'} (${ctx.parsed.y > 0 ? '+' : ''}${Number(ctx.parsed.y).toFixed(1)}%)`;
            },
          },
        },
      },
      scales: {
        x: { grid: { color: '#142034' }, ticks: { color: '#8fa4bf', font: { size: 9 }, maxRotation: 30, minRotation: 30 } },
        y: {
          title: { display: true, text: 'Relative change from 1× to 10× (%)', color: '#7e93ae', font: { size: 10 } },
          grid: { color: '#1d2b40' },
          ticks: { color: '#8fa4bf', callback: (v) => `${v > 0 ? '+' : ''}${v}%` },
        },
      },
    },
  });

  // Exact captions.
  const at10 = scales.includes(10) ? 10 : scales[scales.length - 1];
  const val = (m, s) => { const r = dvRow(count, m, s); return r ? Number(r[metric.key]) : NaN; };
  const dyn10 = val('auroch_dynamic_proxy', at10);
  const gaps = baselines.map((b) => ({ label: b.label, d: dyn10 - val(b.key, at10) }));
  const minGap = gaps.reduce((a, b) => (b.d < a.d ? b : a));
  const maxGap = gaps.reduce((a, b) => (b.d > a.d ? b : a));
  el('bench-main-caption').innerHTML =
    `<b>Source:</b> <span class="metric">data/averaged.csv</span> · <span class="metric">${count}</span> transactions per run, mean of <span class="metric">20</span> runs. X = capacity multiplier; Y = <b>${esc(metric.label)}</b>. Error bars are ±1 standard deviation across runs. At <b>${at10}×</b>: ` +
    DV_METHODS.map((m) => `${esc(m.label)} <span class="metric">${metric.fmt(val(m.key, at10))}</span>`).join(' · ') +
    `. <b>${metric.higherBetter ? 'Higher' : 'Lower'} is better.</b> Proxy simulation on the exact 18,331-node / 80,918-channel snapshot; synthetic amounts, policies ignored.`;
  el('bench-delta-caption').innerHTML =
    `<b>How to read.</b> Positive = dynamic Auroch beats that baseline; negative = baseline wins. At <b>${at10}×</b>, the gap across the four baselines ranges from <span class="metric">${metric.fmt(minGap.d)}</span> (${esc(minGap.label)}) to <span class="metric">${metric.fmt(maxGap.d)}</span> (${esc(maxGap.label)}) on ${esc(metric.label.toLowerCase())}. Every point uses the same ${count}-transaction workload, so the only differences are routing algorithm and fee policy.`;
  const dynamicGain = gainData[0];
  el('bench-gain-caption').innerHTML =
    `<b>How to read.</b> Relative change from 1× to 10× capacity: <span class="metric">${metric.fmt(dynamicGain.from)}</span> → <span class="metric">${metric.fmt(dynamicGain.to)}</span> for dynamic Auroch (<span class="metric">${dynamicGain.value != null ? (dynamicGain.value * 100).toFixed(1) + '%' : 'n/a'}</span>). Positive means capacity helps; negative means the metric improves as the graph fills. Exact counts are in the table below.`;
}

function drawMeasuredChart() {
  const count = el('measured-count').value;
  const metricKey = el('measured-metric').value;
  const metric = DV_JSON_METRICS.find((m) => m.key === metricKey);
  const data = MEASURED.byCount[count];
  const scales = MEASURED.scales;
  const datasets = DV_JSON_METHODS.filter((m) => data[m.key]).map((m) => ({
    label: m.label,
    data: scales.map((s, i) => ({
      x: s,
      y: data[m.key][metricKey] ? data[m.key][metricKey][i] : null,
    })),
    borderColor: m.color,
    backgroundColor: m.color,
    borderWidth: 2.2,
    pointRadius: 3,
    pointHoverRadius: 6,
    pointBackgroundColor: '#0a111c',
    pointBorderColor: m.color,
    pointBorderWidth: 2,
    tension: 0.2,
    spanGaps: true,
  }));

  if (dvCharts.json) dvCharts.json.destroy();
  dvCharts.json = new Chart(el('measured-chart'), {
    type: 'line',
    data: { datasets },
    options: dvBaseChartOptions(metric.label, (ctx) =>
      `${ctx.dataset.label} · ${ctx.parsed.x}× · ${count} tx · ${metric.label}: ${metric.fmt(ctx.parsed.y)}`),
  });

  const at10 = scales.includes(10) ? 10 : scales[scales.length - 1];
  const i10 = scales.indexOf(at10);
  const line = DV_JSON_METHODS.filter((m) => data[m.key]).map((m) =>
    `${esc(m.label)} <span class="metric">${metric.fmt(data[m.key][metricKey][i10])}</span>`).join(' · ');
  el('measured-caption').innerHTML =
    `<b>Source:</b> <span class="metric">data/measured_results.json</span> (<span class="metric">${esc(MEASURED.source)}</span>) · ${count} transactions. X = capacity multiplier, Y = <b>${esc(metric.label)}</b>. Values at <b>${at10}×</b>: ${line}. <b>Caveat:</b> ${esc(MEASURED.note)}.`;
}

function drawSnapshotChart() {
  const rows = SNAPSHOT_ROWS.filter((r) => r.nodes && r.channels);
  const labels = rows.map((r) => r.timestamp);
  const nodes = rows.map((r) => Number(r.nodes));
  const channels = rows.map((r) => Number(r.channels));
  if (dvCharts.snapshot) dvCharts.snapshot.destroy();
  dvCharts.snapshot = new Chart(el('snapshot-chart'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Nodes', data: nodes, borderColor: '#00e5ff', backgroundColor: '#00e5ff', yAxisID: 'y', borderWidth: 2, pointRadius: 2, tension: 0.25 },
        { label: 'Channels', data: channels, borderColor: '#a855f7', backgroundColor: '#a855f7', yAxisID: 'y1', borderWidth: 2, pointRadius: 2, tension: 0.25 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 20, boxHeight: 3, padding: 12 } },
        tooltip: {
          ...srTooltipStyle,
          callbacks: {
            title: (items) => (items.length ? labels[items[0].dataIndex] : ''),
            label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y.toLocaleString()}`,
          },
        },
      },
      scales: {
        x: {
          title: { display: true, text: 'Snapshot timestamp (6-hour samples)', color: '#7e93ae', font: { size: 10 } },
          grid: { color: '#142034' },
          ticks: { color: '#8fa4bf', maxRotation: 45, minRotation: 45, font: { size: 9 }, autoSkip: true, maxTicksLimit: 14 },
        },
        y: {
          type: 'linear', position: 'left',
          title: { display: true, text: 'Nodes', color: '#00e5ff', font: { size: 10 } },
          grid: { color: '#1d2b40' }, ticks: { color: '#8fa4bf' },
        },
        y1: {
          type: 'linear', position: 'right',
          title: { display: true, text: 'Channels', color: '#a855f7', font: { size: 10 } },
          grid: { drawOnChartArea: false }, ticks: { color: '#8fa4bf' },
        },
      },
    },
  });
  const stable = rows.filter((r) => r.timestamp.startsWith('2021-11-2'));
  const sn = stable.map((r) => Number(r.nodes));
  const sc = stable.map((r) => Number(r.channels));
  const nodeMin = Math.min(...sn), nodeMax = Math.max(...sn);
  const chMin = Math.min(...sc), chMax = Math.max(...sc);
  el('snapshot-caption').innerHTML =
    `<b>Source:</b> <span class="metric">snapshot_summary.csv</span> from the discharged-pc hourly archive. ${rows.length} snapshots sampled every 6 hours. Within the stable Nov 25–29 window (${stable.length} snapshots): nodes <span class="metric">${nodeMin.toLocaleString()}–${nodeMax.toLocaleString()}</span>, channels <span class="metric">${chMin.toLocaleString()}–${chMax.toLocaleString()}</span>. The exact paper-match snapshot used for all benchmarks is 2021-11-27 21:00 (18,331 nodes / 80,918 channels). Late snapshots fall sharply and are excluded from experiments; topology variation here is small, so metric changes come mainly from capacity multiplier and workload length.`;
}

function drawTauCanvas() {
  const canvas = el('data-tau-canvas');
  const ctx = canvas.getContext('2d');
  const alpha = Number(el('data-alpha').value);
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const pad = 34;
  ctx.strokeStyle = '#1d2b40';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad, pad); ctx.lineTo(pad, H - pad); ctx.lineTo(W - pad, H - pad);
  ctx.stroke();
  ctx.font = "10px 'Fira Code', monospace";
  ctx.fillStyle = '#7e93ae';
  ctx.textAlign = 'center';
  for (let i = 0; i <= 5; i++) {
    const r = i / 5;
    ctx.fillText(r.toFixed(1), pad + r * (W - 2 * pad), H - pad + 14);
  }
  ctx.textAlign = 'right';
  for (let v = F_MIN; v <= F_MAX; v++) {
    const y = H - pad - ((v - F_MIN) / (F_MAX - F_MIN)) * (H - 2 * pad);
    ctx.fillText(String(v), pad - 8, y + 3);
  }
  ctx.strokeStyle = '#00e5ff';
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  for (let i = 0; i <= 120; i++) {
    const r = i / 120;
    const tau = tauFromLiquidity(r, 1, alpha);
    const x = pad + r * (W - 2 * pad);
    const y = H - pad - ((tau - F_MIN) / (F_MAX - F_MIN)) * (H - 2 * pad);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  el('data-tau-readout').innerHTML =
    `<div style="font-family:var(--mono);font-size:10.5px;color:var(--muted);line-height:1.7">` +
    `<b style="color:var(--text)">τ(r) = ${F_MIN} + (${F_MAX}−${F_MIN})(1−r)^${alpha.toFixed(1)}</b><br>` +
    `r = available / capacity · τ(0)=${F_MAX} · τ(0.5)=${tauFromLiquidity(0.5, 1, alpha).toFixed(2)} · τ(1)=${F_MIN}<br>` +
    `Exact function used by the auction engine (alpha from the slider). Proxy data used α=2.</div>`;
}

const AVG_ROWS = parseCsv(AVG_CSV).map((r) => ({
  ...r,
  transaction_count: r.transaction_count,
  capacity_scale: Number(r.capacity_scale),
}));
const SNAPSHOT_ROWS = parseCsv(SNAPSHOT_CSV);

function initDataView() {
  // Populate selectors from the actual data.
  const counts = [...new Set(AVG_ROWS.map((r) => r.transaction_count))].sort();
  el('bench-count').innerHTML = counts.map((c) => `<option value="${esc(c)}">${esc(c)} tx</option>`).join('');
  el('bench-metric').innerHTML = DV_METRICS.map((m) => `<option value="${esc(m.key)}">${esc(m.label)}</option>`).join('');
  el('measured-count').innerHTML = Object.keys(MEASURED.byCount).map((c) => `<option value="${esc(c)}">${esc(c)} tx</option>`).join('');
  el('measured-metric').innerHTML = DV_JSON_METRICS.map((m) => `<option value="${esc(m.key)}">${esc(m.label)}</option>`).join('');
  el('bench-count').addEventListener('change', drawBenchCharts);
  el('bench-metric').addEventListener('change', drawBenchCharts);
  el('measured-count').addEventListener('change', drawMeasuredChart);
  el('measured-metric').addEventListener('change', drawMeasuredChart);

  // Raw averaged table.
  const rows = parseCsv(AVG_CSV);
  const headers = Object.keys(rows[0] || {});
  el('avg-table').innerHTML = `<thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${headers.map((h) => `<td>${esc(r[h])}</td>`).join('')}</tr>`).join('')}</tbody>`;

  // Tau curve (canvas, already interactive).
  el('data-alpha').addEventListener('input', drawTauCanvas);
  drawTauCanvas();

  // All live plots.
  drawBenchCharts();
  drawMeasuredChart();
  drawSnapshotChart();
}

/* ------------------------------------------------------------------ */
/* Docs view                                                           */
/* ------------------------------------------------------------------ */

function tex(latex) {
  if (typeof latex !== 'string' || !latex.trim()) return '';
  try {
    return `<div class="doc-equation">${katex.renderToString(latex, { displayMode: true, throwOnError: false })}</div>`;
  } catch (err) {
    return `<div class="doc-equation">${esc(latex)}</div>`;
  }
}

function initDocsView() {
  const cards = [
    {
      tag: 'RREQ / RREP', title: 'Route discovery and reply',
      body: '<p>The receiver floods a Route Request without the payment value (value privacy). Each node records its parents toward the receiver. Route Replies travel back along the tree, carrying path, bottleneck capacity and accumulated per-unit cost — never the amount.</p>',
      latex: String.raw`\text{RREQ}(n_s,n_d) \;\to\; \text{RREP}(P=\{n_d,\dots,n_s\},\; C=\min_i c_i,\; \text{cost}=\sum \tau_i)`,
    },
    {
      tag: 'EQ 1', title: 'Reservation price (auction setup)',
      body: '<p>The auctioneer sets its reservation price as the current winning price plus the forwarding fee it demands.</p>',
      latex: String.raw`\text{ResPrice}(n_d,n_a)=\text{WinPrice}(n_a,P(n_d,n_a))+\tau_{\text{fee}},\quad \tau_{\text{fee}}\in[f_{\min},f_{\max}]`,
    },
    {
      tag: 'EQS 2–3', title: 'Bidding — Rule 1',
      body: '<p>When a bidder receives one auction offer, it bids the reservation price plus a randomly chosen τ₁ in the allowed fee range.</p>',
      latex: String.raw`\text{BidPrice}(AN(n_b,m))=\text{ResPrice}+\tau_1,\quad \tau_1\leftarrow^{\$}[f_{\min},f_{\max}]`,
    },
    {
      tag: 'EQS 4–5', title: 'Bidding — Rule 2',
      body: '<p>With several offers, the bidder computes a volume-based price VtPrice from each offer\'s share of total capacity and price, then derives τ₂.</p>',
      latex: String.raw`\text{VtPrice}_i=\frac{\text{cap}_i}{\sum_j \text{cap}_j}\left(1-\frac{\text{res}_i}{\sum_j \text{res}_j}\right),\quad \tau_2=f_{\min}+\text{VtPrice}_i\,(f_{\max}-f_{\min})`,
    },
    {
      tag: 'EQ 6', title: 'Auction allocation LP',
      body: '<p>Each auctioneer independently maximises its revenue subject to its own channel capacity and each bidder\'s bid cap. Solved here by a real simplex LP (javascript-lp-solver), matching scipy linprog in the reference.</p>',
      latex: String.raw`\max \sum_i \text{BidPrice}_i\, \text{Cap}_i \quad \text{s.t.}\quad \sum_i \text{Cap}_i\le \text{MaxCap},\; 0\le \text{Cap}_i\le \text{BidCap}_i`,
    },
    {
      tag: 'EQ 7', title: 'Sender route-selection LP',
      body: '<p>The sender minimises total forwarding cost while allocating at least the payment amount, bounded by the paper\'s upper bound and per-route capacities.</p>',
      latex: String.raw`\min \sum_k \text{Cost}_k\, p_k \quad \text{s.t.}\quad \sum_k p_k\ge \text{amt},\; \sum_k p_k\le \text{amt}+\sum_k \text{Cap}_k\text{Cost}_k,\; 0\le p_k\le \text{Cap}_k`,
      note: 'The engine page solves this LP exactly. The success-ratio benchmark substitutes a max-flow feasibility allocation with the same directed-channel capacity constraints; it keeps the liquidity limits but drops fee minimisation.',
    },
    {
      tag: 'CHANNEL LOCKS', title: 'Shared directed-channel constraints',
      body: '<p>Overlapping routes may not spend the same directional liquidity twice. One extra row is added per directed channel (channel ID + sender + receiver), exactly as in route_allocation.py.</p>',
      latex: String.raw`\sum_{k\,:\,c\in P_k} p_k \le \text{liquidity}(c)\qquad \forall\, c=(\text{channel\_id},\text{sender},\text{receiver})`,
    },
    {
      tag: 'HTLC', title: 'Hash locks and settlement',
      body: '<p>Every selected path commits the allocated amount with an HTLC. The receiver reveals the preimage; intermediaries claim fees and directional balances update. Watch the liquidity bars and τ change after settlement.</p>',
      latex: String.raw`\text{lock}(u,v,x)\;\to\;\text{preimage}\;\to\;\text{settle}(u,v,x),\qquad \text{balance}_{u\to v}\leftarrow \text{balance}_{u\to v}-x`,
    },
    {
      tag: 'PROPOSED', title: 'Dynamic τ (not in the paper)',
      body: '<p>Our proposed extension replaces the random integer τ with a liquidity-dependent fee in the same range [1,10]. The paper itself uses a uniformly random integer; this is clearly labelled as a proposal.</p>',
      latex: String.raw`r=\frac{\text{available}}{\text{capacity}},\qquad \tau(r)=\tau_{\min}+(\tau_{\max}-\tau_{\min})(1-r)^{\alpha}`,
      note: 'tau_min = 1, tau_max = 10, alpha slider 0.5–4 (simulation default 2).',
    },
    {
      tag: 'DATA', title: 'Provenance and limits',
      body: '<p>All results and plots in this build come from data copied into this folder. The benchmark used the exact 18,331-node / 80,918-channel 2021-11-27 snapshot, but with 50:50 liquidity, synthetic amounts, parallel channels aggregated and policies ignored. It is a proxy study, not a faithful reproduction of the paper\'s implementation.</p>',
      latex: String.raw`N_{\text{nodes}}=18{,}331,\qquad N_{\text{channels}}=80{,}918,\qquad \text{runs}=2{,}400`,
      note: 'The engine page itself executes the exact auction/bidding/LP/HTLC algorithm; the measured-data page reports the proxy experiment.',
    },
  ];
  el('docs-grid').innerHTML = cards.map((c) => `
    <div class="doc-card"><span class="tag">${esc(c.tag)}</span><h3>${esc(c.title)}</h3>
      ${c.body}${tex(c.latex)}
      ${c.note ? `<p class="projection-note">${esc(c.note)}</p>` : ''}
    </div>`).join('');
}

/* ------------------------------------------------------------------ */
/* Success ratio view                                                 */
/* ------------------------------------------------------------------ */

const SR = {
  colors: {
    old: '#ef4444',
    flowFixed: '#00e5ff',
    flowDiverse: '#10b981',
    ceiling: '#a855f7',
    sender: '#f59e0b',
    receiver: '#ef4444',
    internal: '#a855f7',
  },
  scenarios: [
    { name: 'Old proxy · cached 3 · fixed 128', method: 'cached3', workload: 'fixed128', color: '#ef4444', dash: [] },
    { name: 'Routing fix · live flow · fixed 128', method: 'flow', workload: 'fixed128', color: '#00e5ff', dash: [] },
    { name: 'Routing + workload fix · diverse OD', method: 'flow', workload: 'diverse', color: '#10b981', dash: [] },
    { name: 'Liquidity ceiling · diverse OD', method: 'ceiling', workload: 'diverse', color: '#a855f7', dash: [7, 4] },
  ],
};

const pct = (v) => `${((Number(v) || 0) * 100).toFixed(1)}%`;
const pp = (v) => `${v >= 0 ? '+' : ''}${((Number(v) || 0) * 100).toFixed(1)} pp`;

function srSummary(method, workload, scale) {
  return SUCCESS.summaries.find((r) => r.method === method && r.workload === workload && r.scale === scale);
}

function srScales() {
  return [...new Set(SUCCESS.summaries.map((r) => r.scale))].sort((a, b) => a - b);
}

/* ----- shared Chart.js styling and custom drawing plugins ----- */

Chart.defaults.color = '#8fa4bf';
Chart.defaults.font.family = "'Fira Code', monospace";
Chart.defaults.font.size = 10;
Chart.defaults.borderColor = '#1d2b40';

const srTargetPlugin = {
  id: 'srTargets',
  afterDatasetsDraw(chart, _args, opts) {
    if (!opts || !opts.lines || !opts.lines.length) return;
    const { ctx, chartArea, scales } = chart;
    ctx.save();
    opts.lines.forEach(({ value, color, label }) => {
      const y = scales.y.getPixelForValue(value);
      if (y < chartArea.top || y > chartArea.bottom) return;
      ctx.beginPath();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.moveTo(chartArea.left, y);
      ctx.lineTo(chartArea.right, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.font = "10px 'Fira Code', monospace";
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText(label, chartArea.right - 5, y - 3);
    });
    ctx.restore();
  },
};

const srErrorBarsPlugin = {
  id: 'srErrorBars',
  afterDatasetsDraw(chart, _args, opts) {
    if (!opts || !opts.key) return;
    const { ctx, scales } = chart;
    const y = scales.y;
    ctx.save();
    chart.data.datasets.forEach((ds, di) => {
      const meta = chart.getDatasetMeta(di);
      if (meta.hidden) return;
      meta.data.forEach((point, i) => {
        const raw = ds.data[i];
        const sd = raw && Number(raw.row && raw.row[opts.key]);
        if (!raw || raw.y == null || !sd || !isFinite(sd) || sd <= 0) return;
        const top = y.getPixelForValue(Math.min(1, raw.y + sd));
        const bottom = y.getPixelForValue(Math.max(0, raw.y - sd));
        ctx.strokeStyle = ds.borderColor;
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.moveTo(point.x, top);
        ctx.lineTo(point.x, bottom);
        ctx.moveTo(point.x - 3, top);
        ctx.lineTo(point.x + 3, top);
        ctx.moveTo(point.x - 3, bottom);
        ctx.lineTo(point.x + 3, bottom);
        ctx.stroke();
        ctx.globalAlpha = 1;
      });
    });
    ctx.restore();
  },
};

const srTooltipStyle = {
  backgroundColor: '#0d1420',
  borderColor: '#1d2b40',
  borderWidth: 1,
  titleColor: '#dce7f5',
  bodyColor: '#a8bbd3',
  padding: 10,
  displayColors: false,
};

function srPointTooltip(raw, key) {
  const row = raw && raw.row;
  if (!row) return '';
  const label = key === 'success_volume' ? 'Success volume' : 'Success ratio';
  return [
    `${raw.seriesName} · ${row.scale}× capacity`,
    `${label}: ${pct(raw.y)}  (±${Number(row[key + '_std']).toFixed(4)})`,
    `Successful: ${row.successful_payments.toLocaleString()} / ${row.attempted_payments.toLocaleString()} payments`,
    `Other metric: ${key === 'success_volume' ? pct(row.success_ratio) + ' ratio' : pct(row.success_volume) + ' volume'}`,
    `Mean of ${row.runs} runs · ${row.elapsed_seconds.toFixed(1)} s compute`,
  ];
}

function srScaleChart(canvasId, key, yTitle, thresholds) {
  const scales = srScales();
  const datasets = SR.scenarios.map((cfg) => ({
    label: cfg.name,
    data: scales.map((s) => {
      const row = srSummary(cfg.method, cfg.workload, s);
      return { x: s, y: row ? row[key] : null, row, seriesName: cfg.name };
    }),
    borderColor: cfg.color,
    backgroundColor: cfg.color,
    borderDash: cfg.dash,
    borderWidth: 2.2,
    pointRadius: 3.4,
    pointHoverRadius: 6,
    pointBackgroundColor: '#0a111c',
    pointBorderColor: cfg.color,
    pointBorderWidth: 2,
    tension: 0.22,
    spanGaps: true,
  }));

  return new Chart(el(canvasId), {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'nearest', intersect: true },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 20, boxHeight: 3, padding: 14, font: { size: 10 } } },
        tooltip: {
          ...srTooltipStyle,
          callbacks: {
            title: (items) => (items.length ? `${items[0].parsed.x}× capacity` : ''),
            label: (ctx) => srPointTooltip(ctx.raw, key),
          },
        },
        srTargets: { lines: thresholds },
        srErrorBars: { key: key + '_std' },
      },
      scales: {
        x: {
          type: 'logarithmic',
          min: 1,
          max: 70,
          afterBuildTicks: (axis) => {
            axis.ticks = [1, 2, 3, 5, 7, 10, 20, 30, 50, 70].map((v) => ({ value: v }));
          },
          title: { display: true, text: 'Capacity scale (× initial channel capacity) · log', color: '#7e93ae', font: { size: 10 } },
          grid: { color: '#142034' },
          ticks: { color: '#8fa4bf', callback: (v) => `${v}×` },
        },
        y: {
          min: 0,
          max: 1,
          title: { display: true, text: yTitle, color: '#7e93ae', font: { size: 10 } },
          grid: { color: '#1d2b40' },
          ticks: { color: '#8fa4bf', callback: (v) => `${Math.round(v * 100)}%` },
        },
      },
    },
    plugins: [srTargetPlugin, srErrorBarsPlugin],
  });
}

function srPositionChart(old10, fixed10, diverse10) {
  const labels = Array.from({ length: 10 }, (_, i) => `${i * 500 + 1}–${(i + 1) * 500}`);
  const cfg = [
    { row: old10, name: 'Old proxy · fixed 128', color: SR.colors.old },
    { row: fixed10, name: 'Routing fix · fixed 128', color: SR.colors.flowFixed },
    { row: diverse10, name: 'Routing + diverse OD', color: SR.colors.flowDiverse },
  ];
  return new Chart(el('success-position-chart'), {
    type: 'line',
    data: {
      labels,
      datasets: cfg.map((c) => ({
        label: c.name,
        data: (c.row && c.row.deciles || []).map((v, i) => ({ y: v, range: labels[i], decile: i + 1, seriesName: c.name })),
        borderColor: c.color,
        backgroundColor: c.color,
        borderWidth: 2.2,
        pointRadius: 3,
        pointHoverRadius: 6,
        pointBackgroundColor: '#0a111c',
        pointBorderColor: c.color,
        pointBorderWidth: 2,
        tension: 0.25,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 20, boxHeight: 3, padding: 12, font: { size: 9 } } },
        tooltip: {
          ...srTooltipStyle,
          callbacks: {
            title: (items) => items[0] && items[0].dataset.label,
            label: (ctx) => `Group ${ctx.raw.decile} · payments ${ctx.raw.range} · ${pct(ctx.raw.y)}`,
          },
        },
      },
      scales: {
        x: {
          type: 'category',
          labels,
          title: { display: true, text: 'Payment position (5,000 payments in sequence) · 10 equal groups', color: '#7e93ae', font: { size: 9 } },
          grid: { color: '#142034' },
          ticks: { color: '#8fa4bf', maxRotation: 45, minRotation: 45, font: { size: 9 } },
        },
        y: {
          min: 0, max: 1,
          title: { display: true, text: 'Success ratio within group', color: '#7e93ae', font: { size: 10 } },
          grid: { color: '#1d2b40' },
          ticks: { color: '#8fa4bf', callback: (v) => `${Math.round(v * 100)}%` },
        },
      },
    },
  });
}

function srFailureChart(fixed10, diverse10) {
  const causes = [
    { key: 'sender_outbound', label: 'Sender out of liquidity', color: SR.colors.sender },
    { key: 'receiver_inbound', label: 'Receiver out of liquidity', color: SR.colors.receiver },
    { key: 'internal_cut', label: 'Internal min-cut', color: SR.colors.internal },
  ];
  const scenarios = [
    { label: 'Fixed 128 · 10×', row: fixed10 },
    { label: 'Diverse OD · 10×', row: diverse10 },
  ];
  const totals = scenarios.map((s) => Object.values((s.row && s.row.failures) || {}).reduce((a, b) => a + b, 0));
  return new Chart(el('success-failure-chart'), {
    type: 'bar',
    data: {
      labels: scenarios.map((s) => s.label),
      datasets: causes.map((c) => ({
        label: c.label,
        data: scenarios.map((s) => ((s.row && s.row.failures) || {})[c.key] || 0),
        backgroundColor: c.color,
        borderColor: '#0a111c',
        borderWidth: 1,
      })),
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, boxHeight: 12, padding: 12, font: { size: 9 } } },
        tooltip: {
          ...srTooltipStyle,
          displayColors: true,
          callbacks: {
            label: (ctx) => {
              const n = ctx.parsed.x;
              const total = totals[ctx.dataIndex];
              return `${ctx.dataset.label}: ${n.toLocaleString()} (${total ? pct(n / total) : '0.0%'} of failures)`;
            },
          },
        },
      },
      scales: {
        x: { stacked: true, title: { display: true, text: 'Failed payments (count)', color: '#7e93ae', font: { size: 10 } }, grid: { color: '#1d2b40' }, ticks: { color: '#8fa4bf' } },
        y: { stacked: true, grid: { color: '#142034' }, ticks: { color: '#8fa4bf', font: { size: 10 } } },
      },
    },
  });
}

function initSuccessView() {
  const scales = srScales();
  const at10 = scales.includes(10) ? 10 : scales[scales.length - 1];
  const at1 = scales[0];
  const at30 = scales.includes(30) ? 30 : scales[scales.length - 1];
  const sum = (m, w, s) => srSummary(m, w, s) || {};
  const old10 = sum('cached3', 'fixed128', at10);
  const fixed10 = sum('flow', 'fixed128', at10);
  const diverse10 = sum('flow', 'diverse', at10);
  const ceiling10 = sum('ceiling', 'diverse', at10);
  const diverse1 = sum('flow', 'diverse', at1);
  const diverse30 = sum('flow', 'diverse', at30);
  const value = (row, key = 'success_ratio') => (row ? row[key] : 0);
  const deltaAlgo = value(fixed10) - value(old10);
  const deltaWork = value(diverse10) - value(fixed10);

  // KPI cards.
  el('success-headline').innerHTML = [
    { label: `Old proxy · ${at10}x · fixed 128 pairs`, value: pct(value(old10)), sub: 'cached 3 paths', cls: 'bad' },
    { label: `Routing fix · ${at10}x · same workload`, value: pct(value(fixed10)), sub: `${pp(deltaAlgo)} vs old`, cls: '' },
    { label: `+ workload fix · ${at10}x · diverse OD`, value: pct(value(diverse10)), sub: `${pp(deltaWork)} vs routing fix`, cls: 'good' },
    { label: `Liquidity ceiling · ${at10}x`, value: pct(value(ceiling10)), sub: 'max-flow, no depletion', cls: 'warn' },
    { label: `Diverse OD · ${at1}x capacity`, value: pct(value(diverse1)), sub: 'structural limit', cls: 'warn' },
    { label: `Diverse OD · ${at30}x capacity`, value: pct(value(diverse30)), sub: 'paper high-capacity range', cls: 'good' },
  ].map((k) => `<div class="success-kpi ${k.cls}"><div class="label">${esc(k.label)}</div><div class="value">${esc(k.value)}</div><div class="sub">${esc(k.sub)}</div></div>`).join('');

  // Real plots.
  srScaleChart('success-main-chart', 'success_ratio', 'Success ratio (successful ÷ attempted)', [
    { value: 0.8, color: '#f59e0b', label: '0.8 target' },
    { value: 0.9, color: '#10b981', label: '0.9 target' },
  ]);
  srScaleChart('success-volume-chart', 'success_volume', 'Success volume (delivered ÷ attempted sats)', []);
  srPositionChart(old10, fixed10, diverse10);
  srFailureChart(fixed10, diverse10);

  // Exact-information captions under each plot.
  const snap = `${SUCCESS.snapshot.nodes.toLocaleString()} nodes / ${SUCCESS.snapshot.channels.toLocaleString()} channels`;
  el('main-caption').innerHTML =
    `<b>How to read.</b> Every point is the mean of <span class="metric">${old10.runs || 3}</span> independent runs of <span class="metric">5,000</span> payments on the exact <span class="metric">${snap}</span> snapshot; error bars are ±1σ. The x-axis is logarithmic because capacity spans 1×–70×. At <b>${at10}×</b>: old proxy <span class="metric">${pct(value(old10))}</span> (${(old10.successful_payments || 0).toLocaleString()}/${(old10.attempted_payments || 0).toLocaleString()}), routing fix <span class="metric">${pct(value(fixed10))}</span>, diverse OD <span class="metric">${pct(value(diverse10))}</span>, ceiling <span class="metric">${pct(value(ceiling10))}</span>. Hover a point for its exact counts and σ. <b>Caveat:</b> proxy measurement, not a paper-faithful reproduction.`;
  el('volume-caption').innerHTML =
    `<b>How to read.</b> Amount-weighted companion to plot 1: delivered satoshis ÷ attempted satoshis. A protocol can deliver many small payments and still score poorly here. At <b>${at10}×</b>: old proxy <span class="metric">${pct(value(old10, 'success_volume'))}</span>, routing fix <span class="metric">${pct(value(fixed10, 'success_volume'))}</span>, diverse OD <span class="metric">${pct(value(diverse10, 'success_volume'))}</span>, ceiling <span class="metric">${pct(value(ceiling10, 'success_volume'))}</span>. Amounts are seeded log-uniform 1,000–1,000,000 sat; policies ignored.`;
  const oldDec = (old10.deciles || []);
  el('position-caption').innerHTML =
    `<b>How to read.</b> The 5,000 payments of each run are kept in sequence and split into ten groups of 500; each point is the success ratio inside that group. The cached-path proxy falls from <span class="metric">${pct(oldDec[0])}</span> in the first group to <span class="metric">${pct(oldDec[oldDec.length - 1])}</span> in the last: reused endpoints drain. Live flow allocation on the same reused pairs holds <span class="metric">${pct((fixed10.deciles || [])[0])}</span> → <span class="metric">${pct((fixed10.deciles || [])[9])}</span>; with diverse OD it holds <span class="metric">${pct((diverse10.deciles || [])[0])}</span> → <span class="metric">${pct((diverse10.deciles || [])[9])}</span>. Measured at ${at10}× capacity.`;
  const failTotal = (r) => Object.values((r && r.failures) || {}).reduce((a, b) => a + b, 0);
  const failLine = (r) => {
    const f = (r && r.failures) || {};
    const t = failTotal(r);
    return `sender ${((f.sender_outbound || 0) / (t || 1) * 100).toFixed(0)}%, receiver ${((f.receiver_inbound || 0) / (t || 1) * 100).toFixed(0)}%, internal cut ${((f.internal_cut || 0) / (t || 1) * 100).toFixed(0)}% of ${t.toLocaleString()} failures`;
  };
  el('failure-caption').innerHTML =
    `<b>How to read.</b> Only payments that failed are counted here. Fixed 128: ${failLine(fixed10)}. Diverse OD: ${failLine(diverse10)}. “Sender out of liquidity” means the sum of the sender's outbound channel balances was already below the requested amount at the first hop; “receiver inbound” is the symmetric case. No routing change can fix either — those payments are inside the liquidity ceiling.`;

  // Explanation cards.
  const answer = `Yes — but only when the workload itself is feasible. At ${at10}x capacity with one independently sampled OD pair per payment, the measured success ratio is <b>${pct(value(diverse10))}</b> (${pct(value(diverse30))} at ${at30}x). At ${at1}x it is <b>${pct(value(diverse1))}</b>: about ${pct(1 - value(diverse1))} of payments cannot fit through the sender's outbound or the receiver's inbound liquidity even at the first hop, so no routing algorithm can deliver them.`;
  el('success-explain').innerHTML = [
    { tag: 'FINDING 1', title: 'Routing was only part of the gap', cls: '', body: `With the original 128 reused pairs, replacing the cached 3 paths with live liquidity-aware flow allocation raised success from <b>${pct(value(old10))}</b> to <b>${pct(value(fixed10))}</b> at ${at10}x — <b>${pp(deltaAlgo)}</b>. That is a real algorithm change, not a graph edit: every payment re-discovers routes on the current residual balances.` },
    { tag: 'FINDING 2', title: 'The reused-pair workload was the larger cap', cls: '', body: `The old benchmark reused 128 OD pairs for 5,000 payments — about 39 payments per pair. Those endpoints drain. Sampling one fresh OD pair per payment raised success from <b>${pct(value(fixed10))}</b> to <b>${pct(value(diverse10))}</b> at ${at10}x (<b>${pp(deltaWork)}</b>). This is a workload-realism change and is reported separately.` },
    { tag: 'FINDING 3', title: 'The ceiling explains the rest', cls: '', body: `A per-payment max-flow on untouched initial balances succeeds for <b>${pct(value(ceiling10))}</b> of payments at ${at10}x. The diverse workload tracks that ceiling; the fixed-128 workload falls far below it as its endpoints empty. The remaining gap is liquidity, not implementation.` },
    { tag: 'ANSWER', title: 'Can we reach 0.8–0.9+?', cls: 'answer', body: answer },
  ].map((c) => `<div class="doc-card ${c.cls}"><span class="tag">${esc(c.tag)}</span><h3>${esc(c.title)}</h3><p>${c.body}</p></div>`).join('');

  // Full table.
  const rows = [...SUCCESS.summaries].sort((a, b) =>
    a.workload.localeCompare(b.workload) || a.method.localeCompare(b.method) || a.scale - b.scale
  );
  const headers = ['workload', 'method', 'scale', 'success_ratio', 'success_ratio_std', 'success_volume', 'mean_paths', 'runs'];
  el('success-table').innerHTML = `<thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) =>
    `<tr>${headers.map((h) => `<td>${esc(h.includes('ratio') || h.includes('volume') ? Number(r[h]).toFixed(4) : (h === 'mean_paths' ? Number(r[h]).toFixed(2) : r[h]))}</td>`).join('')}</tr>`
  ).join('')}</tbody>`;

  el('success-caveat').textContent = `Caveat: ${SUCCESS.caveat} Source: ${SUCCESS.source}. Snapshot: ${SUCCESS.snapshot.nodes.toLocaleString()} nodes / ${SUCCESS.snapshot.channels.toLocaleString()} channels. Paper-faithful: ${SUCCESS.paper_faithful}.`;
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

initSuccessView();
initNetworkView();
initDataView();
initDocsView();
el('speed-val').textContent = `${el('cfg-speed').value}x`;
el('source-info').innerHTML = '<b>Ready.</b> Choose a topology and press Run Engine to watch every protocol message.';
