#!/usr/bin/env python3
"""Success-ratio experiment for the Auroch engine.

This script answers a narrow question: what payment success ratio does the
protocol actually achieve, and which part of the gap is routing versus
workload?

It compares three things on the exact 2021-11-27 21:00 Lightning snapshot
(18,331 nodes / 80,918 channels):

1. ``cached3`` -- the original proxy used by the earlier dataset.  Three
   shortest paths are cached per OD pair and reused for all payments.  This is
   the series that produced ~0.20 at 1x and ~0.42 at 10x.
2. ``flow`` -- a per-payment liquidity-aware allocation.  Each payment runs a
   max-flow / Eq7-style feasibility flow on the *current residual balances*,
   then decomposes the flow into paths.  This is the algorithmic fix: routes
   are discovered against live liquidity instead of a frozen cache.
3. ``ceiling`` -- the same per-payment flow, but against the initial balances
   and with no depletion.  It is the local-liquidity ceiling for that workload:
   no router can exceed it, because a payment still has to fit through the
   sender's outbound and the receiver's inbound liquidity.

Two workloads are used:

* ``fixed128`` -- the original proxy workload: 128 fixed OD pairs reused for
  5,000 payments.  Each pair is therefore hit ~39 times.
* ``diverse`` -- one independently sampled OD pair per payment.  This is the
  standard workload model when a real payment trace is unavailable and it does
  not repeatedly drain the same 128 endpoints.

All results are proxy results.  The real auction/bidding/ECDSA stack is not
executed here; the flow allocation is a faithful stand-in for Equation 7's
liquidity constraints, not a paper reproduction.
"""

from __future__ import annotations

import argparse
import csv
import itertools
import json
import math
import multiprocessing as mp
import random
import sys
import time
from collections import defaultdict
from pathlib import Path

import networkx as nx
import numpy as np
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import maximum_flow

# Allow running from the project root or from scripts/.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

SEED = 20261116
SCALES = [1, 2, 3, 5, 7, 10, 20, 30, 50, 70]
RUNS = 3
COUNT = 5000
AMOUNT_MIN = 1_000
AMOUNT_MAX = 1_000_000
DECILES = 10
DEFAULT_INPUT = (
    Path(__file__).resolve().parent.parent.parent
    / "auroch-payment-channel-routing"
    / "data"
    / "lngraph_2021_11_27__21_00.json"
)
CAVEAT = (
    "Proxy experiment: synthetic log-uniform amounts, 50:50 initial liquidity, "
    "policies ignored, parallel channels aggregated. The flow solver is an "
    "Eq7-style feasibility allocation, not the paper's auction stack."
)

# Filled by load_topology(); inherited by forked workers as read-only data.
TOPO: dict = {}


# --------------------------------------------------------------------------- #
# Topology and workloads
# --------------------------------------------------------------------------- #


def load_topology(path: Path, seed: int = SEED) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    pubkeys = [n["pub_key"] for n in data["nodes"]]
    node_index = {key: i for i, key in enumerate(pubkeys)}

    # Reproduce the original proxy exactly: it used the pub_key strings as
    # graph node ids, assigned seeded fee weights in insertion order, and
    # sampled OD pairs from the resulting largest component.  Keeping that
    # order makes the cached3 series directly comparable to the old dataset.
    base_keys: dict[tuple[str, str], int] = defaultdict(int)
    for edge in data["edges"]:
        u, v = edge["node1_pub"], edge["node2_pub"]
        capacity = int(edge["capacity"])
        if capacity <= 0:
            continue
        base_keys[(u, v)] += capacity // 2
        base_keys[(v, u)] += capacity // 2

    fee_rng = random.Random(seed + 1)
    graph = nx.DiGraph()
    graph.add_nodes_from(pubkeys)
    for (u, v) in base_keys:
        graph.add_edge(u, v, weight=1 + fee_rng.randint(0, 10))

    largest = max(nx.weakly_connected_components(graph), key=len)
    graph = graph.subgraph(largest).copy()
    nodes = list(largest)
    largest_int = {node_index[key] for key in largest}

    base_directional: dict[tuple[int, int], int] = defaultdict(int)
    for (u, v), balance in base_keys.items():
        base_directional[(node_index[u], node_index[v])] = balance

    edges = [(u, v) for (u, v) in base_directional if u in largest_int and v in largest_int]
    base = np.array([base_directional[e] for e in edges], dtype=np.int64)
    rows = np.array([u for u, _ in edges], dtype=np.int32)
    cols = np.array([v for _, v in edges], dtype=np.int32)

    out_index = [[] for _ in range(len(pubkeys))]
    in_index = [[] for _ in range(len(pubkeys))]
    for i, (u, v) in enumerate(edges):
        out_index[u].append(i)
        in_index[v].append(i)

    pair_rng = random.Random(seed + 2)
    pairs_keys, seen = [], set()
    while len(pairs_keys) < 128:
        s, t = pair_rng.sample(nodes, 2)
        if (s, t) not in seen:
            seen.add((s, t))
            pairs_keys.append((s, t))
    pairs = [(node_index[s], node_index[t]) for s, t in pairs_keys]
    nodes = [node_index[key] for key in list(largest)]

    return {
        "data": data,
        "pubkeys": pubkeys,
        "graph": graph,
        "node_index": node_index,
        "nodes": nodes,
        "pairs": pairs,
        "edges": edges,
        "edge_pos": {e: i for i, e in enumerate(edges)},
        "base": base,
        "rows": rows,
        "cols": cols,
        "out_index": [np.asarray(x, dtype=np.int32) for x in out_index],
        "in_index": [np.asarray(x, dtype=np.int32) for x in in_index],
        "node_count": len(pubkeys),
        "channel_count": len(data["edges"]),
        "lcc_size": len(largest),
    }


def fixed_workload(run: int, count: int = COUNT) -> list[tuple[int, int, int]]:
    rng = random.Random(SEED + run)
    pairs = TOPO["pairs"]
    out = []
    for _ in range(count):
        source, target = pairs[rng.randrange(len(pairs))]
        amount = int(round(10 ** rng.uniform(math.log10(AMOUNT_MIN), math.log10(AMOUNT_MAX))))
        out.append((source, target, amount))
    return out


def diverse_workload(run: int, count: int = COUNT) -> list[tuple[int, int, int]]:
    rng = random.Random(SEED + run)
    nodes = TOPO["nodes"]
    out = []
    for _ in range(count):
        source, target = rng.sample(nodes, 2)
        amount = int(round(10 ** rng.uniform(math.log10(AMOUNT_MIN), math.log10(AMOUNT_MAX))))
        out.append((source, target, amount))
    return out


def workload(name: str, run: int) -> list[tuple[int, int, int]]:
    return fixed_workload(run) if name == "fixed128" else diverse_workload(run)


# --------------------------------------------------------------------------- #
# Original cached-three-path proxy
# --------------------------------------------------------------------------- #


def precompute_cached_routes(pair_count: int = 128, cache_path: Path | None = None) -> dict:
    graph = TOPO["graph"]
    pairs = [tuple(p) for p in TOPO["pairs"][:pair_count]]

    if cache_path and cache_path.exists():
        payload = json.loads(cache_path.read_text(encoding="utf-8"))
        if payload.get("seed") == SEED and payload.get("pairs") == [list(p) for p in pairs]:
            return {tuple(p): routes for p, routes in zip(pairs, payload["routes"])}

    cache = {}
    pubkeys = TOPO["pubkeys"]
    for index, (source, target) in enumerate(pairs, 1):
        try:
            paths = list(
                itertools.islice(
                    nx.shortest_simple_paths(
                        graph, pubkeys[source], pubkeys[target], weight="weight"
                    ),
                    20,
                )
            )
        except Exception:
            paths = []
        cache[(source, target)] = [
            [TOPO["node_index"][node] for node in path] for path in paths[:3]
        ]
        if index % 16 == 0:
            print(f"  cached routes: {index}/{len(pairs)} pairs", flush=True)

    if cache_path:
        # JSON has string keys, so keep the pair order explicit.
        cache_path.write_text(
            json.dumps(
                {
                    "seed": SEED,
                    "pairs": [list(p) for p in pairs],
                    "routes": [cache[p] for p in pairs],
                }
            )
            + "\n",
            encoding="utf-8",
        )
    return cache


def cached_route_one(balances: dict, cache: dict, source: int, target: int, amount: int):
    candidates = cache.get((source, target), [])
    allocations, reserved, left = [], defaultdict(int), amount
    active = list(candidates)
    while left > 0 and active:
        share = max(1, left // len(active))
        still_active = []
        for path in active:
            available = min(
                (balances.get((u, v), 0) - reserved[(u, v)] for u, v in zip(path, path[1:])),
                default=0,
            )
            take = min(share, max(0, available), left)
            if take > 0:
                allocations.append((path, take))
                for u, v in zip(path, path[1:]):
                    reserved[(u, v)] += take
                left -= take
            if available - take > 0:
                still_active.append(path)
        active = still_active

    if left:
        return False, 0
    for path, take in allocations:
        for u, v in zip(path, path[1:]):
            balances[(u, v)] -= take
    return True, len(allocations)


def run_cached(scale: int, run: int, routes: dict, count: int = COUNT, deciles: int = DECILES) -> dict:
    base = TOPO["base"]
    edges = TOPO["edges"]
    balances = {edge: int(base[i]) * scale for i, edge in enumerate(edges)}
    work = fixed_workload(run, count)
    successful = delivered = attempted = paths = 0
    buckets = [0] * deciles
    bucket_total = [0] * deciles
    started = time.perf_counter()
    for i, (source, target, amount) in enumerate(work):
        attempted += amount
        ok, used = cached_route_one(balances, routes, source, target, amount)
        bucket = min(deciles - 1, i * deciles // count)
        bucket_total[bucket] += 1
        if ok:
            successful += 1
            delivered += amount
            paths += used
            buckets[bucket] += 1
    return {
        "method": "cached3",
        "workload": "fixed128",
        "scale": scale,
        "run": run + 1,
        "attempted_payments": count,
        "successful_payments": successful,
        "attempted_sats": attempted,
        "successful_sats": delivered,
        "success_ratio": successful / count,
        "success_volume": delivered / attempted if attempted else 0.0,
        "mean_paths": paths / successful if successful else 0.0,
        "deciles": [buckets[i] / bucket_total[i] if bucket_total[i] else 0.0 for i in range(deciles)],
        "elapsed_seconds": time.perf_counter() - started,
    }


# --------------------------------------------------------------------------- #
# Liquidity-aware flow allocation
# --------------------------------------------------------------------------- #


def flow_paths(balances: np.ndarray, amount: int, source: int, target: int):
    """Return a list of (path, amount) that delivers exactly ``amount``.

    Capacities are capped at the payment amount (a single-commodity flow of
    value <= amount never needs an edge above amount) and a virtual super
    source/sink keeps the solver's total flow inside int32.  This makes the
    call safe at 70x, where individual channels exceed 2^31 sat.
    """
    n = TOPO["node_count"]
    rows = TOPO["rows"]
    cols = TOPO["cols"]
    capped = np.minimum(balances, amount)
    data = np.append(capped, [amount, amount])
    rows2 = np.append(rows, [n, target])
    cols2 = np.append(cols, [source, n + 1])
    matrix = csr_matrix((data, (rows2, cols2)), shape=(n + 2, n + 2))
    result = maximum_flow(matrix, n, n + 1)
    if result.flow_value < amount:
        return None

    flow = result.flow.tocoo()
    positive = flow.data > 0
    adjacency: dict[int, list[list[int]]] = {}
    for u, v, f in zip(flow.row[positive], flow.col[positive], flow.data[positive]):
        adjacency.setdefault(int(u), []).append([int(v), int(f)])

    left = amount
    allocations = []
    while left > 0:
        stack = [source]
        parent = {source: None}
        parent_edge = {}
        found = False
        while stack:
            u = stack.pop()
            if u == target:
                found = True
                break
            for i, (v, f) in enumerate(adjacency.get(u, ())):
                if f > 0 and v not in parent:
                    parent[v] = u
                    parent_edge[v] = i
                    stack.append(v)
                    if v == target:
                        found = True
                        break
        if not found:
            return None
        path = []
        v = target
        while v is not None:
            path.append(v)
            v = parent[v]
        path.reverse()
        bottleneck = left
        for u, v in zip(path, path[1:]):
            bottleneck = min(bottleneck, adjacency[u][parent_edge[v]][1])
        for u, v in zip(path, path[1:]):
            adjacency[u][parent_edge[v]][1] -= bottleneck
        allocations.append((path, bottleneck))
        left -= bottleneck
    return allocations


def flow_feasible(balances: np.ndarray, amount: int, source: int, target: int) -> bool:
    n = TOPO["node_count"]
    rows = TOPO["rows"]
    cols = TOPO["cols"]
    capped = np.minimum(balances, amount)
    data = np.append(capped, [amount, amount])
    rows2 = np.append(rows, [n, target])
    cols2 = np.append(cols, [source, n + 1])
    matrix = csr_matrix((data, (rows2, cols2)), shape=(n + 2, n + 2))
    return maximum_flow(matrix, n, n + 1).flow_value >= amount


def _failure_cause(balances: np.ndarray, source: int, target: int, amount: int) -> str:
    out_index = TOPO["out_index"][source]
    in_index = TOPO["in_index"][target]
    source_out = int(balances[out_index].sum()) if len(out_index) else 0
    target_in = int(balances[in_index].sum()) if len(in_index) else 0
    if source_out < amount:
        return "sender_outbound"
    if target_in < amount:
        return "receiver_inbound"
    return "internal_cut"


def _run_flow_task(task: tuple) -> dict:
    workload_name, scale, run, method = task
    base = TOPO["base"]
    edges = TOPO["edges"]
    edge_pos = TOPO["edge_pos"]
    balances = base * scale
    work = workload(workload_name, run)
    successful = delivered = attempted = paths = 0
    buckets = [0] * DECILES
    bucket_total = [0] * DECILES
    failures = defaultdict(int)
    started = time.perf_counter()
    for i, (source, target, amount) in enumerate(work):
        attempted += amount
        bucket = min(DECILES - 1, i * DECILES // len(work))
        bucket_total[bucket] += 1
        if method == "ceiling":
            ok = flow_feasible(balances, amount, source, target)
            used = 1
        else:
            allocations = flow_paths(balances, amount, source, target)
            ok = allocations is not None
            used = len(allocations) if allocations else 0
            if ok:
                for path, value in allocations:
                    for u, v in zip(path, path[1:]):
                        balances[edge_pos[(u, v)]] -= value
        if ok:
            successful += 1
            delivered += amount
            paths += used
            buckets[bucket] += 1
        elif method == "flow":
            failures[_failure_cause(balances, source, target, amount)] += 1
    return {
        "method": method,
        "workload": workload_name,
        "scale": scale,
        "run": run + 1,
        "attempted_payments": len(work),
        "successful_payments": successful,
        "attempted_sats": attempted,
        "successful_sats": delivered,
        "success_ratio": successful / len(work),
        "success_volume": delivered / attempted if attempted else 0.0,
        "mean_paths": paths / successful if successful else 0.0,
        "deciles": [buckets[i] / bucket_total[i] if bucket_total[i] else 0.0 for i in range(DECILES)],
        "failures": dict(failures),
        "elapsed_seconds": time.perf_counter() - started,
    }


# --------------------------------------------------------------------------- #
# Aggregation and output
# --------------------------------------------------------------------------- #


def aggregate(rows: list[dict], keys: tuple[str, ...]) -> list[dict]:
    grouped: dict[tuple, list[dict]] = defaultdict(list)
    for row in rows:
        grouped[tuple(row[k] for k in keys)].append(row)
    out = []
    for group_key, group in sorted(grouped.items()):
        first = dict(group[0])
        for metric in ("success_ratio", "success_volume", "mean_paths"):
            values = np.asarray([g[metric] for g in group], dtype=float)
            first[metric] = float(values.mean())
            first[f"{metric}_std"] = float(values.std(ddof=1)) if len(values) > 1 else 0.0
        first["runs"] = len(group)
        first["deciles"] = [
            float(np.mean([g["deciles"][i] for g in group])) for i in range(DECILES)
        ]
        failures: dict[str, int] = defaultdict(int)
        for g in group:
            for cause, count in g.get("failures", {}).items():
                failures[cause] += count
        first["failures"] = dict(failures)
        out.append(first)
    return out


def write_csv(path: Path, rows: list[dict]) -> None:
    if not rows:
        return
    fields = [k for k in rows[0] if k not in ("deciles", "failures")]
    with path.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        writer.writerows([{k: r.get(k) for k in fields} for r in rows])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output", type=Path, default=Path("data"))
    parser.add_argument("--routes-cache", type=Path, default=Path("data/cached_routes.json"))
    parser.add_argument("--workers", type=int, default=6)
    parser.add_argument("--count", type=int, default=COUNT)
    parser.add_argument("--runs", type=int, default=RUNS)
    parser.add_argument("--scales", type=int, nargs="+", default=SCALES)
    parser.add_argument("--quick", action="store_true", help="tiny smoke run")
    args = parser.parse_args()

    if args.quick:
        args.count = 200
        args.runs = 1
        args.scales = [1, 10]
        args.workers = 2

    if not args.input.exists():
        raise SystemExit(f"snapshot not found: {args.input}")

    global TOPO
    started = time.perf_counter()
    TOPO = load_topology(args.input)
    print(
        f"Loaded {args.input}: {TOPO['node_count']} nodes, {TOPO['channel_count']} channels, "
        f"LCC {TOPO['lcc_size']}, {len(TOPO['edges'])} directed edges",
        flush=True,
    )

    out = args.output
    out.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------ #
    # 1. Original cached-three-path proxy on the fixed 128-pair workload
    # ------------------------------------------------------------------ #
    print("Building cached routes for the fixed128 baseline...", flush=True)
    routes = precompute_cached_routes(128, args.routes_cache)
    cached_rows = []
    for scale in args.scales:
        for run in range(args.runs):
            cached_rows.append(run_cached(scale, run, routes, count=args.count))
            print(f"  cached3 scale={scale} run={run + 1} done", flush=True)
    write_csv(out / "success_per_run.csv", cached_rows)

    # ------------------------------------------------------------------ #
    # 2. Flow and ceiling tasks (forked workers share the read-only graph)
    # ------------------------------------------------------------------ #
    tasks = []
    for workload_name in ("fixed128", "diverse"):
        for scale in args.scales:
            for run in range(args.runs):
                tasks.append((workload_name, scale, run, "flow"))
            tasks.append((workload_name, scale, 0, "ceiling"))

    flow_rows = []
    context = mp.get_context("fork")
    with context.Pool(processes=args.workers) as pool:
        for i, row in enumerate(pool.imap_unordered(_run_flow_task, tasks), 1):
            flow_rows.append(row)
            print(
                f"  [{i}/{len(tasks)}] {row['method']} {row['workload']} "
                f"scale={row['scale']} run={row['run']} "
                f"succ={row['success_ratio']:.3f} ({row['elapsed_seconds']:.0f}s)",
                flush=True,
            )

    all_rows = cached_rows + flow_rows
    write_csv(out / "success_per_run.csv", all_rows)

    summaries = aggregate(all_rows, ("method", "workload", "scale"))
    summary_json = {
        "source": "auroch-engine-v2/scripts/success_experiment.py",
        "snapshot": {
            "path": str(args.input),
            "nodes": TOPO["node_count"],
            "channels": TOPO["channel_count"],
            "paper_nodes": 18331,
            "paper_channels": 80918,
        },
        "definition": {
            "success_ratio": "successful_payments / attempted_payments",
            "success_volume": "successful_sats / attempted_sats",
            "by_position": "success ratio inside each 1/10 of the payment sequence",
        },
        "configuration": {
            "count": args.count,
            "runs": args.runs,
            "scales": args.scales,
            "seed": SEED,
            "amounts": "seeded log-uniform 1,000-1,000,000 sat",
            "initial_liquidity": "50:50 directional split",
            "parallel_channels": "aggregated per directed endpoint pair",
            "policies": "ignored",
            "flow_solver": "scipy maximum_flow, capacities capped at payment amount, virtual source/sink",
        },
        "workloads": {
            "fixed128": "128 fixed OD pairs reused for all payments (original proxy workload)",
            "diverse": "one independently sampled OD pair per payment (standard workload model)",
        },
        "methods": {
            "cached3": "3 shortest paths cached per OD pair, water-filled (original proxy)",
            "flow": "per-payment max-flow on live residual balances, decomposed into paths",
            "ceiling": "same per-payment flow on initial balances, no depletion (local-liquidity ceiling)",
        },
        "summaries": summaries,
        "caveat": CAVEAT,
        "paper_faithful": False,
        "elapsed_seconds": time.perf_counter() - started,
    }
    (out / "success_experiment.json").write_text(
        json.dumps(summary_json, indent=2) + "\n", encoding="utf-8"
    )

    # deciles and failure causes, one row per scenario
    decile_rows = []
    for row in summaries:
        for i, value in enumerate(row["deciles"]):
            decile_rows.append(
                {
                    "method": row["method"],
                    "workload": row["workload"],
                    "scale": row["scale"],
                    "decile": i + 1,
                    "success_ratio": value,
                }
            )
    write_csv(out / "success_deciles.csv", decile_rows)

    failure_rows = []
    for row in flow_rows:
        if row["method"] != "flow":
            continue
        for cause, count in row["failures"].items():
            failure_rows.append(
                {
                    "workload": row["workload"],
                    "scale": row["scale"],
                    "run": row["run"],
                    "cause": cause,
                    "count": count,
                }
            )
    write_csv(out / "success_failures.csv", failure_rows)

    print(json.dumps({"elapsed_seconds": summary_json["elapsed_seconds"], "summaries": len(summaries)}, indent=2))
    for row in summaries:
        print(
            f"{row['method']:8s} {row['workload']:8s} x{row['scale']:<2d} "
            f"success={row['success_ratio']:.4f} volume={row['success_volume']:.4f}"
        )


if __name__ == "__main__":
    main()
