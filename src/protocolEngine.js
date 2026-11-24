// Full Auroch protocol engine — RREQ/RREP, AUC, Rule 1/2 bidding,
// Eq 6 auction allocation LP, Eq 7 sender route-selection LP, HTLC settlement.
// Written fresh for auroch-engine-v2. All algorithm logic lives here.

import solver from 'javascript-lp-solver';
import SUBGRAPH from '../data/snapshot_subgraph.json';

export const F_MIN = 1;
export const F_MAX = 10;

/* ------------------------------------------------------------------ */
/* Utilities                                                           */
/* ------------------------------------------------------------------ */

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function tauFromLiquidity(available, capacity, alpha = 2) {
  if (capacity <= 0) return F_MAX;
  const r = Math.min(1, Math.max(0, available / capacity));
  return F_MIN + (F_MAX - F_MIN) * Math.pow(1 - r, alpha);
}

const DEMO_NODES = [
  { id: 'Alice', label: 'Alice', type: 'sender', x: -55, y: 0, color: '#00e5ff' },
  { id: 'Peter', label: 'Peter', type: 'intermediary', x: -26, y: 30, color: '#a855f7' },
  { id: 'Alexa', label: 'Alexa', type: 'intermediary', x: -26, y: -30, color: '#ec4899' },
  { id: 'Ivan', label: 'Ivan', type: 'intermediary', x: 26, y: 30, color: '#10b981' },
  { id: 'Sam', label: 'Sam', type: 'intermediary', x: 26, y: -30, color: '#f59e0b' },
  { id: 'Chloe', label: 'Chloe', type: 'receiver', x: 55, y: 0, color: '#3b82f6' },
];

const DEMO_CHANNELS = [
  { id: 'Alice-Peter', u: 'Alice', v: 'Peter', balance_u: 25, balance_v: 50, capacity: 75 },
  { id: 'Alice-Alexa', u: 'Alice', v: 'Alexa', balance_u: 30, balance_v: 20, capacity: 50 },
  { id: 'Peter-Ivan', u: 'Peter', v: 'Ivan', balance_u: 15, balance_v: 35, capacity: 50 },
  { id: 'Alexa-Ivan', u: 'Alexa', v: 'Ivan', balance_u: 20, balance_v: 10, capacity: 30 },
  { id: 'Alexa-Sam', u: 'Alexa', v: 'Sam', balance_u: 25, balance_v: 15, capacity: 40 },
  { id: 'Ivan-Chloe', u: 'Ivan', v: 'Chloe', balance_u: 30, balance_v: 20, capacity: 50 },
  { id: 'Sam-Chloe', u: 'Sam', v: 'Chloe', balance_u: 40, balance_v: 10, capacity: 50 },
];

/* ------------------------------------------------------------------ */
/* Network                                                             */
/* ------------------------------------------------------------------ */

export class Network {
  constructor(nodes, channels, scale = 1) {
    this.nodes = nodes;
    this.channels = channels.map((c) => ({
      ...c,
      cap: c.capacity * scale,
      balU: (c.balance_u != null ? c.balance_u : c.capacity / 2) * scale,
      balV: (c.balance_v != null ? c.balance_v : c.capacity / 2) * scale,
    }));
    this.byPair = new Map();
    this.adj = new Map(nodes.map((n) => [n.id, []]));
    for (const ch of this.channels) {
      this.byPair.set(`${ch.u}|${ch.v}`, ch);
      this.byPair.set(`${ch.v}|${ch.u}`, ch);
      this.adj.get(ch.u).push(ch.v);
      this.adj.get(ch.v).push(ch.u);
    }
  }

  neighbors(id) { return this.adj.get(id) || []; }
  channel(from, to) { return this.byPair.get(`${from}|${to}`) || null; }
  available(from, to) {
    const c = this.channel(from, to);
    if (!c) return 0;
    return from === c.u ? c.balU : c.balV;
  }
  capacity(from, to) {
    const c = this.channel(from, to);
    return c ? c.cap : 0;
  }
  channelId(from, to) {
    const c = this.channel(from, to);
    return c ? c.id : null;
  }
  lock(from, to, amount) {
    const c = this.channel(from, to);
    if (!c) return false;
    if (from === c.u) c.balU -= amount; else c.balV -= amount;
    return true;
  }
  unlock(from, to, amount) {
    const c = this.channel(from, to);
    if (!c) return;
    if (from === c.u) c.balU += amount; else c.balV += amount;
  }
  tau(from, to, mode, alpha, rng) {
    if (mode === 'dynamic') return tauFromLiquidity(this.available(from, to), this.capacity(from, to), alpha);
    return F_MIN + Math.floor(rng() * (F_MAX - F_MIN + 1));
  }
  label(id) {
    const n = this.nodes.find((x) => x.id === id);
    return n ? n.label : String(id);
  }
  snapshotBalances() {
    return this.channels.map((c) => ({
      id: c.id, u: c.u, v: c.v, cap: c.cap,
      uLiquidity: c.balU, vLiquidity: c.balV,
      uRatio: c.cap ? c.balU / c.cap : 0,
      vRatio: c.cap ? c.balV / c.cap : 0,
      uTau: tauFromLiquidity(c.balU, c.cap, 2),
      vTau: tauFromLiquidity(c.balV, c.cap, 2),
    }));
  }
}

export function buildNetwork(topology, scale) {
  if (topology === 'snapshot') {
    const nodes = SUBGRAPH.nodes.map((n, i) => ({
      id: i, label: n.alias || `#${i}`, type: n.isHub ? 'hub' : 'intermediary',
      x: n.x, y: n.y, color: n.isHub ? '#00f0ff' : '#5b7fa8', degree: n.degree,
    }));
    const channels = SUBGRAPH.edges.map((e) => ({
      id: e.id, u: e.u, v: e.v, capacity: e.cap,
      balance_u: e.liquidity, balance_v: e.cap - e.liquidity,
    }));
    const net = new Network(nodes, channels, scale);
    // The extracted 90-node subgraph is a hub-and-spoke star around the
    // highest-degree node. Use one leaf as receiver and let every other leaf
    // be a valid sender: the auction winner becomes the actual sender.
    const hubNode = nodes.find((n) => n.type === 'hub');
    const hub = hubNode ? hubNode.id : 0;
    const leaves = nodes.filter((n) => n.id !== hub);
    const destination = leaves.length ? leaves[0].id : hub;
    const sourceCandidates = new Set(leaves.filter((n) => n.id !== destination).map((n) => n.id));
    const source = leaves.find((n) => sourceCandidates.has(n.id))?.id ?? destination;
    return { net, source, sourceCandidates, destination, meta: SUBGRAPH.counts };
  }
  const net = new Network(DEMO_NODES, DEMO_CHANNELS, scale);
  return { net, source: 'Alice', destination: 'Chloe', meta: { nodes: 6, channels: 7 } };
}

function bfsDistance(net, start) {
  const dist = new Map([[start, 0]]);
  const q = [start];
  while (q.length) {
    const cur = q.shift();
    for (const nb of net.neighbors(cur)) {
      if (!dist.has(nb)) { dist.set(nb, dist.get(cur) + 1); q.push(nb); }
    }
  }
  return dist;
}

/* ------------------------------------------------------------------ */
/* Exact LP solvers (javascript-lp-solver / simplex)                   */
/* ------------------------------------------------------------------ */

// Eq 6: max Σ BidPrice_i · Cap_i
//   s.t. Σ Cap_i ≤ MaxCap                          (constraint 6b)
//        0 ≤ Cap_i ≤ BidCap_i                     (constraints 6c/6d)
// This is the same LP solved by scipy.optimize.linprog in auction_result.py.
export function solveAuctionLP(bids, maxCap) {
  const variables = {};
  const constraints = {
    maxCap: { max: Math.max(0, maxCap) },
  };
  bids.forEach((b, i) => {
    const key = `x${i}`;
    variables[key] = { revenue: b.bid_price, maxCap: 1, [`bidCap${i}`]: 1 };
    constraints[`bidCap${i}`] = { max: Math.max(0, b.bid_cap) };
  });
  const model = { optimize: 'revenue', opType: 'max', constraints, variables };
  const result = solver.Solve(model);
  if (!result || result.feasible !== true) {
    return { allocation: bids.map(() => 0), totalAllocated: 0, totalRevenue: 0, objective: 0, sortedByPrice: [], feasible: false, solverMessage: result?.boundedness || 'infeasible' };
  }
  const allocation = bids.map((_, i) => Math.max(0, result[`x${i}`] || 0));
  const totalAllocated = allocation.reduce((s, v) => s + v, 0);
  const totalRevenue = allocation.reduce((s, v, i) => s + v * bids[i].bid_price, 0);
  const order = bids.map((b, i) => i).sort((i, j) => bids[j].bid_price - bids[i].bid_price);
  return {
    allocation, totalAllocated, totalRevenue, objective: totalRevenue,
    sortedByPrice: order.map((i) => ({ bidder: bids[i].bidder, price: bids[i].bid_price, cap: bids[i].bid_cap, allocated: allocation[i] })),
    feasible: true, solverMessage: result.solver || 'simplex',
  };
}

// Eq 7: min Σ Cost_k · p_k
//   s.t. Σ p_k ≥ amt                                        (Eq 7b)
//        Σ p_k ≤ amt + Σ Cap_k·Cost_k                       (Eq 7c)
//        0 ≤ p_k ≤ Cap_k                                    (Eq 7d/7e)
//        Σ_{k uses channel c} p_k ≤ available(c)  for every shared directed channel
//          (the channel-constraint extension from route_allocation.py)
// This is the same LP solved by scipy.optimize.linprog(method="highs").
export function solveRouteLP(routes, amount, net = null) {
  const upperBound = amount + routes.reduce((s, r) => s + r.capacity * r.cost, 0);
  const variables = {};
  const constraints = {
    payment: { min: amount },
    upperBound: { max: upperBound },
  };
  const channelKeys = new Set();

  routes.forEach((r, i) => {
    const v = { cost: r.cost, payment: 1, upperBound: 1, [`routeCap${i}`]: 1 };
    // Shared directed-channel constraints (channel_id, sender, receiver).
    const path = r.path || [];
    const ids = r.channelIds || [];
    for (let h = 0; h < path.length - 1; h++) {
      const key = `ch_${ids[h]}_${path[h]}_${path[h + 1]}`.replace(/[^\w-]/g, '_');
      channelKeys.add(key);
      v[key] = 1;
    }
    variables[`p${i}`] = v;
    constraints[`routeCap${i}`] = { max: Math.max(0, r.capacity) };
  });

  for (const key of channelKeys) {
    let available = Infinity;
    if (net) {
      // Recover channel id / endpoints from the sanitised key by matching
      // against the route that declared it.
      for (const r of routes) {
        for (let h = 0; h < (r.path || []).length - 1; h++) {
          const k = `ch_${(r.channelIds || [])[h]}_${r.path[h]}_${r.path[h + 1]}`.replace(/[^\w-]/g, '_');
          if (k === key) {
            available = Math.min(available, net.available(r.path[h], r.path[h + 1]));
          }
        }
      }
    }
    constraints[key] = { max: available === Infinity ? upperBound : Math.max(0, available) };
  }

  const model = { optimize: 'cost', opType: 'min', constraints, variables };
  const result = solver.Solve(model);
  if (!result || result.feasible !== true) {
    return {
      allocation: routes.map(() => 0), totalAllocated: 0, totalCost: 0, upperBound,
      objective: 0, success: false, sortedByCost: [],
      solverMessage: result?.boundedness || 'infeasible',
    };
  }
  const allocation = routes.map((_, i) => Math.max(0, result[`p${i}`] || 0));
  const totalAllocated = allocation.reduce((s, v) => s + v, 0);
  const totalCost = allocation.reduce((s, v, i) => s + v * routes[i].cost, 0);
  const order = routes.map((r, i) => i).sort((i, j) => routes[i].cost - routes[j].cost);
  return {
    allocation, totalAllocated, totalCost, upperBound, objective: totalCost,
    success: totalAllocated >= amount - 1e-6 && totalCost <= upperBound + 1e-6,
    sortedByCost: order.map((i) => ({ path: routes[i].path, cost: routes[i].cost, cap: routes[i].capacity, allocated: allocation[i] })),
    solverMessage: result.solver || 'simplex', channelConstraints: channelKeys.size,
  };
}

/* ------------------------------------------------------------------ */
/* Full protocol                                                       */
/* ------------------------------------------------------------------ */

export function runProtocol(config = {}) {
  const cfg = {
    topology: 'demo', amount: 32, tauMode: 'paper', alpha: 2,
    scale: 5, seed: 20261127, ...config,
  };
  const { net, source, sourceCandidates, destination, meta } = buildNetwork(cfg.topology, cfg.scale);
  const isSource = (node) => (sourceCandidates ? sourceCandidates.has(node) : node === source);
  const rng = mulberry32(cfg.seed);
  const steps = [];
  const txid = `TX-${cfg.seed}`;

  const push = (phase, title, detail, extra = {}) => {
    steps.push({
      index: steps.length, phase, title, detail,
      balances: net.snapshotBalances(),
      activeNodes: [], activeEdges: [], packets: [],
      messages: [], tables: {}, metrics: {},
      ...extra,
    });
  };

  const fmt = (v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v);
  const labelPath = (path) => path.map((n) => net.label(n)).join(' → ');

  /* ---- Phase 1: RREQ flood / BFS tree ---- */
  const dist = bfsDistance(net, destination);
  const towardSource = new Map();
  for (const [node, d] of dist) {
    for (const nb of net.neighbors(node)) {
      if (dist.get(nb) === d + 1) {
        if (!towardSource.has(node)) towardSource.set(node, []);
        towardSource.get(node).push(nb);
      }
    }
  }
  const rreqLog = [...dist.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([id, d]) => ({ node: net.label(id), distance: d, parents: (towardSource.get(id) || []).map((n) => net.label(n)) }));
  push('RREQ', 'Route request — BFS tree from receiver',
    `Flood RREQ from ${net.label(destination)}. Value privacy: amount ${cfg.amount} sat is NOT included in the request.`,
    { messages: rreqLog, tables: { bfs: rreqLog }, metrics: { nodesReached: dist.size, maxDepth: Math.max(...dist.values()) } });

  /* ---- Phase 2: initial RREPs ---- */
  let rreps = [];
  const initialBidders = towardSource.get(destination) || [];
  for (const a of initialBidders) {
    rreps.push({
      path: [destination, a], channelIds: [], capacity: null, cost: 0,
      receiver: a, complete: isSource(a),
    });
  }
  push('RREP', 'Initial route replies from receiver neighbours',
    `${rreps.length} RREP(s) created at distance 1. Each carries path and accumulated cost, not the payment amount.`,
    { messages: rreps.map((r) => ({ path: labelPath(r.path), receiver: net.label(r.receiver), cost: r.cost })),
      tables: { rrep: rreps.map((r) => ({ path: labelPath(r.path), receiver: net.label(r.receiver), capacity: r.capacity, cost: r.cost })) },
      activeNodes: [destination, ...initialBidders],
      packets: initialBidders.map((a) => ({ from: destination, to: a, label: 'RREP' })) });

  /* ---- Phases 3..: auction rounds back toward sender ---- */
  let round = 0;
  const maxRounds = Math.max(...dist.values()) + 2;
  const allAuc = [], allBids = [], allEq6 = [];
  let rule1 = 0, rule2 = 0;

  while (rreps.length && round < maxRounds) {
    round++;
    const active = rreps.filter((r) => !r.complete);
    if (!active.length) break;

    /* AUC messages */
    const aucMessages = [];
    for (const rrep of active) {
      const auctioneer = rrep.receiver;
      const nextHop = rrep.path[rrep.path.length - 2];
      if (nextHop === undefined) continue;
      const tauFee = net.tau(auctioneer, nextHop, cfg.tauMode, cfg.alpha, rng);
      const reservationPrice = rrep.cost + tauFee;
      const auc = {
        txid, auctionId: `${txid}::${rrep.path.join('>')}`, path: rrep.path,
        auctioneer, nextHop, bidderSet: towardSource.get(auctioneer) || [],
        channelId: net.channelId(auctioneer, nextHop),
        maxCapacity: net.available(auctioneer, nextHop),
        winPrice: rrep.cost, tauFee: fmt(tauFee), reservationPrice: fmt(reservationPrice),
      };
      aucMessages.push(auc);
      allAuc.push(auc);
    }
    push('AUC', `Round ${round} — auction setup (Eq 1)`,
      `Each auctioneer advertises ResPrice = WinPrice + τ. τ is ${cfg.tauMode === 'dynamic' ? `tau(liquidity), α=${cfg.alpha}` : 'a seeded random integer in [1,10]'}.`,
      { messages: aucMessages.map((a) => ({ auction: `…${net.label(a.auctioneer)}`, tau: a.tauFee, reservationPrice: a.reservationPrice, maxCapacity: fmt(a.maxCapacity), bidders: a.bidderSet.map((b) => net.label(b)) })),
        tables: { auc: allAuc.map((a) => ({ id: a.auctionId.slice(-24), auctioneer: net.label(a.auctioneer), tau: a.tauFee, resPrice: a.reservationPrice, maxCap: fmt(a.maxCapacity) })) },
        activeNodes: [...new Set(aucMessages.map((a) => a.auctioneer))],
        packets: aucMessages.flatMap((a) => a.bidderSet.map((b) => ({ from: a.auctioneer, to: b, label: 'AUC' }))),
        metrics: { aucMessages: aucMessages.length } });

    /* BID messages — a bidder compares ALL auction offers it received (Eqs 2-5) */
    const offersByBidder = new Map();
    for (const auc of aucMessages) {
      for (const bidder of auc.bidderSet) {
        if (!offersByBidder.has(bidder)) offersByBidder.set(bidder, []);
        offersByBidder.get(bidder).push(auc);
      }
    }
    const bidMessages = [];
    for (const [bidder, aucs] of offersByBidder.entries()) {
      if (aucs.length === 1) rule1++; else rule2++;
      const totalCap = aucs.reduce((s, a) => s + Math.max(0, a.maxCapacity), 0);
      const totalRes = aucs.reduce((s, a) => s + a.reservationPrice, 0);
      for (const auc of aucs) {
        const bidCap = net.available(bidder, auc.auctioneer);
        const bidChannel = net.channelId(bidder, auc.auctioneer);
        if (bidCap <= 0 || !bidChannel) continue;
        let extra;
        if (aucs.length === 1) {
          const tau1 = net.tau(bidder, auc.auctioneer, cfg.tauMode, cfg.alpha, rng);
          extra = { rule: 1, tau1: fmt(tau1), bid_price: fmt(auc.reservationPrice + tau1) };
        } else {
          const vt = totalCap > 0 && totalRes > 0
            ? (auc.maxCapacity / totalCap) * (1 - auc.reservationPrice / totalRes) : 0;
          const tau2 = F_MIN + vt * (F_MAX - F_MIN);
          extra = { rule: 2, vtPrice: fmt(vt), tau2: fmt(tau2), bid_price: fmt(auc.reservationPrice + tau2) };
        }
        bidMessages.push(makeBid(auc, bidder, bidCap, bidChannel, extra));
      }
    }
    allBids.push(...bidMessages);
    push('BID', `Round ${round} — bidding (Eqs 2–5)`,
      `Rule 1 (single auction): τ₁ random/derived. Rule 2 (multiple auctions): VtPrice = (cap/Σcap)·(1−res/Σres), τ₂ = f_min + VtPrice·(f_max−f_min). This round: ${rule1} Rule-1, ${rule2} Rule-2 bids total.`,
      { messages: bidMessages.map((b) => ({ bidder: net.label(b.bidder), auctioneer: net.label(b.auctioneer), rule: b.rule, tau: b.rule === 1 ? b.tau1 : b.tau2, vt: b.vtPrice, price: b.bid_price, cap: fmt(b.bid_cap) })),
        tables: { bid: allBids.map((b) => ({ bidder: net.label(b.bidder), auctioneer: net.label(b.auctioneer), rule: b.rule, tau: b.rule === 1 ? b.tau1 : b.tau2, vt: b.vtPrice, price: b.bid_price, cap: fmt(b.bid_cap) })) },
        activeNodes: [...new Set(bidMessages.map((b) => b.bidder))],
        packets: bidMessages.map((b) => ({ from: b.bidder, to: b.auctioneer, label: 'BID' })),
        metrics: { bidsThisRound: bidMessages.length, rule1, rule2 } });

    /* Eq 6 — auction allocation LP per auction */
    const grouped = new Map();
    for (const b of bidMessages) {
      if (!grouped.has(b.auctionId)) grouped.set(b.auctionId, []);
      grouped.get(b.auctionId).push(b);
    }
    const auctionResults = [];
    for (const [auctionId, bids] of grouped) {
      const maxCap = bids[0].auctioneer_max_capacity;
      const sol = solveAuctionLP(bids, maxCap);
      allEq6.push({ auctionId, bids, sol });
      bids.forEach((b, i) => {
        auctionResults.push({
          ...b, allocated_capacity: sol.allocation[i],
          objective: sol.objective, totalAllocated: sol.totalAllocated,
        });
      });
    }
    push('EQ6', `Round ${round} — auction allocation LP`,
      `For every auction: max Σ BidPrice·Cap s.t. ΣCap ≤ MaxCap and 0 ≤ Cap ≤ BidCap. Solved exactly by simplex LP (javascript-lp-solver). ${grouped.size} auction(s) solved.`,
      { messages: [...grouped.entries()].map(([id, bids]) => ({ auction: `…${id.slice(-20)}`, bids: bids.length, maxCap: fmt(bids[0].auctioneer_max_capacity), objective: fmt(allEq6.find((e) => e.auctionId === id)?.sol.objective || 0) })),
        tables: { eq6: auctionResults.map((a) => ({ auction: a.auctionId.slice(-18), bidder: net.label(a.bidder), price: a.bid_price, cap: fmt(a.bid_cap), allocated: fmt(a.allocated_capacity) })) },
        metrics: { auctionsSolved: grouped.size, totalAllocated: fmt(auctionResults.reduce((s, a) => s + a.allocated_capacity, 0)) } });

    /* RREP extension */
    // Carry forward RREPs that already reached the sender.
    const extended = rreps.filter((r) => r.complete);
    const failed = [];
    for (const rrep of active) {
      const auctioneer = rrep.receiver;
      const relevant = auctionResults.filter((a) => a.auctioneer === auctioneer && a.auctionId === `${txid}::${rrep.path.join('>')}`);
      let didExtend = false;
      for (const alloc of relevant) {
        if (alloc.allocated_capacity <= 0) continue;
        const bidder = alloc.bidder;
        if (rrep.path.includes(bidder)) { failed.push({ reason: 'cycle', path: labelPath(rrep.path), bidder: net.label(bidder) }); continue; }
        const caps = [alloc.allocated_capacity, alloc.auctioneer_max_capacity];
        if (rrep.capacity != null) caps.push(rrep.capacity);
        const pathCapacity = Math.min(...caps);
        if (pathCapacity <= 0) { failed.push({ reason: 'zero capacity', path: labelPath(rrep.path) }); continue; }
        const channelIds = rrep.channelIds.length
          ? [...rrep.channelIds, alloc.channel_id]
          : [alloc.downstream_channel_id, alloc.channel_id];
        extended.push({
          path: [...rrep.path, bidder], channelIds,
          capacity: fmt(pathCapacity), cost: alloc.bid_price,
          receiver: bidder, complete: isSource(bidder),
        });
        didExtend = true;
      }
      if (!didExtend && rrep.complete) extended.push(rrep);
    }
    rreps = extended;
    push('RREP', `Round ${round} — RREP propagation`,
      `${extended.length} RREP(s) extended toward the sender. Bottleneck capacity = min(allocated, auctioneer MaxCap, previous path capacity); cost = winning BidPrice.`,
      { messages: extended.map((r) => ({ path: labelPath(r.path), capacity: r.capacity, cost: r.cost, complete: r.complete })),
        tables: { rrep: extended.map((r) => ({ path: labelPath(r.path), capacity: r.capacity, cost: r.cost, complete: r.complete })) },
        activeNodes: [...new Set(extended.map((r) => r.receiver))],
        packets: extended.map((r) => ({ from: r.path[r.path.length - 2], to: r.receiver, label: 'RREP' })),
        metrics: { extended: extended.length, rejected: failed.length } });
  }

  /* ---- Eq 7 — sender route selection ---- */
  const completed = rreps.filter((r) => r.complete);
  const actualSender = completed.length ? completed[0].receiver : source;
  const routes = completed.map((r) => ({
    path: [...r.path].reverse(), channelIds: [...r.channelIds].reverse(),
    capacity: r.capacity, cost: r.cost,
  }));
  const eq7 = solveRouteLP(routes, cfg.amount, net);
  push('EQ7', `Sender ${net.label(actualSender)} — final route selection LP`,
    `${net.label(actualSender)} solves min Σ Costₖ·pₖ s.t. Σpₖ ≥ ${cfg.amount} sat, Σpₖ ≤ amt + ΣCapₖ·Costₖ, 0 ≤ pₖ ≤ Capₖ, and shared directed-channel liquidity limits. Solved exactly by simplex LP.`,
    { messages: eq7.sortedByCost.map((r) => ({ path: labelPath(r.path), cost: r.cost, cap: fmt(r.cap), allocated: fmt(r.allocated) })),
      tables: { eq7: eq7.sortedByCost.map((r) => ({ path: labelPath(r.path), unitCost: r.cost, cap: fmt(r.cap), allocated: fmt(r.allocated), fee: fmt(r.allocated * r.cost) })) },
      metrics: { routes: routes.length, totalAllocated: fmt(eq7.totalAllocated), totalCost: fmt(eq7.totalCost), success: eq7.success },
      packets: routes.flatMap((r, i) => eq7.allocation[i] > 0
        ? r.path.slice(0, -1).map((n, j) => ({ from: n, to: r.path[j + 1], label: `${fmt(eq7.allocation[i])} sat` })) : []) });

  /* ---- HTLC lock + settle ---- */
  const selected = routes.filter((_, i) => eq7.allocation[i] > 0);
  if (eq7.success) {
    const lockEvents = [];
    selected.forEach((r, i) => {
      const amt = eq7.allocation[i];
      for (let h = 0; h < r.path.length - 1; h++) {
        const a = r.path[h], b = r.path[h + 1];
        net.lock(a, b, amt);
        lockEvents.push({ from: net.label(a), to: net.label(b), amount: fmt(amt), channel: r.channelIds[h] });
      }
    });
    push('HTLC', 'HTLC lock — funds committed along every selected path',
      `${selected.length} path(s) locked. Directional liquidity falls, so dynamic tau rises on the channels just used.`,
      { messages: lockEvents, tables: { htlc: lockEvents },
        packets: selected.flatMap((r) => r.path.slice(0, -1).map((n, j) => ({ from: n, to: r.path[j + 1], label: 'LOCK' }))),
        metrics: { lockedPaths: selected.length, lockedSats: fmt(eq7.totalAllocated) } });

    const settleEvents = selected.map((r, i) => ({ path: labelPath(r.path), amount: fmt(eq7.allocation[i]), fee: fmt(eq7.allocation[i] * r.cost) }));
    push('SETTLE', 'HTLC settle — secret revealed, balances updated',
      `Preimage released by ${net.label(destination)}. Intermediaries claim their fees; sender pays total ${fmt(eq7.totalCost)} fee units.`,
      { messages: settleEvents, tables: { settle: settleEvents },
        packets: selected.flatMap((r) => [...r.path].reverse().slice(0, -1).map((n, j) => ({ from: n, to: [...r.path].reverse()[j + 1], label: 'SETTLE' }))),
        metrics: { settledPaths: selected.length, totalFee: fmt(eq7.totalCost) } });
  } else {
    push('FAIL', 'Payment could not be allocated',
      `Eq 7 could not allocate ${cfg.amount} sat from ${routes.length} completed route(s). Increase capacity scale or lower the amount.`,
      { metrics: { success: false } });
  }

  const summary = {
    config: cfg, meta, source: net.label(actualSender), destination: net.label(destination),
    txid, totalSteps: steps.length,
    auctions: allAuc.length, bids: allBids.length, rule1, rule2, eq6Auctions: allEq6.length,
    completedRoutes: completed.length, selectedPaths: selected.length,
    requestedAmount: cfg.amount, allocated: fmt(eq7.totalAllocated),
    totalFee: fmt(eq7.totalCost), success: eq7.success,
    meanBidPrice: fmt(allBids.reduce((s, b) => s + b.bid_price, 0) / (allBids.length || 1)),
    meanTau: fmt(allAuc.reduce((s, a) => s + a.tauFee, 0) / (allAuc.length || 1)),
  };
  return { steps, summary, net };
}

function makeBid(auc, bidder, bidCap, bidChannel, extra) {
  return {
    txid: auc.txid, auctionId: auc.auctionId, path: auc.path,
    bidder, auctioneer: auc.auctioneer, next_hop: auc.nextHop,
    channel_id: bidChannel, downstream_channel_id: auc.channelId,
    bid_cap: bidCap, auctioneer_max_capacity: auc.maxCapacity,
    reservation_price: auc.reservationPrice,
    ...extra,
  };
}

export { DEMO_NODES, DEMO_CHANNELS };
