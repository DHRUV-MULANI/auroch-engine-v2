# Auroch Engine v2 — Summary & Explanation of Every Graph

Live dashboard: https://auroch.dhruvmulani.com/ (Cloudflare tunnel → `localhost:6001`)

All plots are rendered live with Chart.js from the raw CSV/JSON in `data/`. No screenshots are embedded in the UI.

---

## 1. Executive summary

We built a full Auroch protocol engine (RREQ/RREP → auction → Rule 1/2 bidding → Eq6/Eq7 LP → HTLC → settlement) and benchmarked payment delivery on the **exact paper snapshot**: 18,331 nodes / 80,918 channels (2021-11-27 21:00).

The central question was: *can the reported 0.8–0.9+ payment success ratio be reached honestly?*

**Answer: yes, but only with a realistic workload and enough capacity.** At 10× capacity with one fresh sender–receiver pair per payment, success is **86.8%** (4,342 / 5,000). At 30× it is **95.9%**. At 1× it is only **60.7%**, and a max-flow ceiling computed on untouched balances is **61.4%** — so roughly 39% of payments at 1× are impossible for *any* routing algorithm because the sender's outbound or receiver's inbound liquidity is already too small. The old 128-reused-pair proxy workload scored just **37.9%** at 10×, which is where the gap in the earlier plots came from.

Everything is labelled a **proxy study**: synthetic log-uniform amounts (1,000–1,000,000 sat), 50:50 initial liquidity, policies ignored, parallel channels aggregated, `paper_faithful: false`. No numbers are fudged.

---

## 2. Success Ratio tab — the four headline graphs

Data source: `data/success_experiment.json` (50 summary points, 3 runs each where applicable, seed 20261116).

### Graph 1 — Success ratio vs capacity scale
- **X:** capacity multiplier (1×…70×, logarithmic axis). **Y:** `successful_payments / attempted_payments`.
- **Lines:** old proxy (cached 3 paths, fixed 128 pairs), routing fix (live max-flow, same pairs), routing + diverse OD, and the liquidity ceiling.
- **Error bars:** ±1σ across 3 runs. Dashed horizontal lines mark the 0.8 and 0.9 targets.
- **What it shows:** at 10×, old proxy **37.9%** → routing fix **45.8%** (+7.9 pp, real algorithm gain) → diverse workload **86.8%** (+41.9 pp, workload-realism gain) → ceiling **87.2%**. The diverse line tracks the ceiling; the fixed-128 line falls far below it because reused endpoints drain. At 1× the diverse line is **60.7%**, so scale, not just routing, is required.

### Graph 2 — Success volume vs capacity scale
- **X:** same capacity scale. **Y:** `delivered_sats / attempted_sats` (amount-weighted).
- **Why it exists:** a router can deliver many small payments and still fail the big ones. Count ratio and volume ratio answer different questions.
- **What it shows:** at 10×, old proxy **15.3%**, routing fix **25.4%**, diverse **55.4%**, ceiling **56.5%**. Volume lags count everywhere because large payments are harder to fit through residual balances — the honest reason "0.9 success" is not the same as "0.9 of value moved".

### Graph 3 — Success by payment position (10×)
- **X:** 5,000 payments in sequence, split into 10 equal groups of 500. **Y:** success ratio inside each group.
- **What it shows:** the cached proxy collapses from **78.3%** in the first group to **12.7%** in the last — reused endpoints drain as the run progresses. Live flow on the same pairs goes 83.3% → 19.6% (better early, still drained). With diverse OD it stays **87.9% → 87.5%**, essentially flat. This is the clearest visual proof that the reused-pair workload, not the route solver, created the late-run collapse.

### Graph 4 — Why payments fail (10×)
- **X:** failed-payment count (stacked). **Y:** two scenarios — fixed 128 and diverse OD.
- **Causes:** sender out of outbound liquidity, receiver out of inbound liquidity, internal min-cut.
- **What it shows:** at 10×, fixed 128 has **401** sender failures, **53** receiver failures, **348** internal-cut failures (802 total). Diverse OD has only **130** total failures. Sender/receiver failures are inside the liquidity ceiling — no routing change can fix them; they need more capacity or different endpoints.

---

## 3. Measured Data tab — the five graphs

Sources: `data/averaged.csv`, `data/measured_results.json`, `data/snapshot_summary.csv`.

All five have dropdown selectors where applicable (transaction count 5k/7k/9k, metric: success ratio/volume, routing cost, mean paths, mean hops, mean fee, mean route time). Values below are for 5,000 tx.

### Graph 5 — Benchmark metric vs capacity scale (`averaged.csv`)
- **X:** capacity multiplier 1–10. **Y:** selected metric, one line per proxy method, ±1σ error bars, exact hover tooltips.
- **What it shows (success ratio, 1× → 10×):** dynamic Auroch 19.5% → 41.9%; Auroch multipath 19.5% → 41.9%; Dijkstra 17.3% → 37.7%; SpeedyMurmurs 19.0% → 41.3%; Spider 17.9% → 38.8%. All methods improve with capacity; the Auroch family leads by roughly 1–4 pp. Selecting "routing cost" reveals the real trade-off: dynamic Auroch pays cost 18.08 → 18.61 for its fee policy, while Auroch multipath pays 4.24 → 5.49 — i.e. the dynamic fee buys liquidity awareness at ~3× the routing cost.

### Graph 6 — Dynamic Auroch advantage over each baseline
- **X:** capacity scale. **Y:** dynamic Auroch minus baseline for the selected metric (positive = dynamic wins).
- **What it shows:** on success ratio the gap is small or zero (both Auroch variants use the same paths). On routing cost the gap is large and negative — dynamic Auroch is intentionally more expensive because its bid prices include the liquidity fee τ. This graph prevents the mistake of reading "dynamic fee" as "free improvement".

### Graph 7 — Scale gain: relative change 1× → 10×
- **X:** the five methods. **Y:** `(value_at_10x − value_at_1x) / value_at_1x` as a percentage.
- **What it shows:** for success ratio, dynamic Auroch gains **+114.5%** (19.5% → 41.9%); the other methods gain 84–119%. For cost metrics a negative value means the metric improves as the graph fills. This is a compact way to compare how much each method benefits from capacity.

### Graph 8 — Second dataset: `measured_results.json`
- **X:** capacity scale. **Y:** selected metric; five methods (static Auroch, dynamic Auroch, Dijkstra, Spider, SpeedyMurmurs).
- **What it shows:** an independent proxy series consistent with graph 5. At 10×: static/dynamic Auroch 41.9% success, Dijkstra 37.7%, Spider 38.8%, Speedy 41.3%. Having two datasets agree is a sanity check, not new evidence of paper fidelity.

### Graph 9 — Input topology variation (`snapshot_summary.csv`)
- **X:** snapshot timestamp (70 snapshots, 6-hour samples from the discharged-pc archive). Left Y: nodes; right Y: channels.
- **What it shows:** in the stable Nov 25–29 window (18 snapshots) nodes range **18,284–18,336** and channels **80,599–81,018** — only ~0.3–0.5% spread. The exact paper-match snapshot (2021-11-27 21:00) is in this window. Late snapshots collapse (down to ~1,900 nodes) and are excluded. Conclusion: topology drift is negligible; the metric changes in the other graphs come from capacity multiplier and workload, not from using a different hour of the snapshot.

---

## 4. Honest caveats (apply to every graph)

- Synthetic seeded log-uniform payment amounts; no real Bitcoin/Ripple workload trace was available.
- 50:50 initial directional liquidity assumed; the snapshot records capacity, not live balances.
- Channel policies ignored; parallel channels aggregated per directed pair.
- The benchmark's flow solver is an Eq7-style max-flow feasibility allocation, **not** the paper's full auction + ECDSA stack. `paper_faithful: false`.
- The ceiling is computed on untouched initial balances — it is an upper bound, not a predicted success rate for a depleted run.
- 0.8–0.9+ is reachable **only** at ≥10× capacity with diverse OD. At 1× the honest number is ~0.61, capped by local liquidity.

---

## 5. Reproduce

```bash
cd /home/boss/Documents/Collage/BTP/auroch-engine-v2
python3 scripts/success_experiment.py          # regenerates the success dataset
npm run build                                 # rebuilds the live dashboard
systemctl --user restart auroch-app.service auroch-tunnel.service
curl -sS -o /dev/null -w '%{http_code}\n' https://auroch.dhruvmulani.com/
```

Raw data: `data/success_experiment.json`, `data/averaged.csv`, `data/measured_results.json`, `data/snapshot_summary.csv`.
