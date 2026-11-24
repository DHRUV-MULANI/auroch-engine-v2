# Auroch Engine v2

Full Auroch protocol engine + live dashboard, benchmarked on the exact paper
Lightning snapshot (18,331 nodes / 80,918 channels, 2021-11-27 21:00).

**Live site:** https://auroch.dhruvmulani.com/
(Cloudflare tunnel → `localhost:6001`, auto-starting systemd user services)

See **[SUMMARY_AND_GRAPHS.md](SUMMARY_AND_GRAPHS.md)** for the executive summary
and a plain-language explanation of every plot in the dashboard.

## What's here

- `src/` — protocol engine + dashboard UI. Implements RREQ/RREP, auction,
  Rule 1/2 bidding, Eq6/Eq7 LP (real simplex via `javascript-lp-solver`), HTLC,
  settlement, and live Chart.js plots.
- `data/` — all raw data used by the dashboard: `averaged.csv`,
  `measured_results.json`, `snapshot_summary.csv`, `snapshot_subgraph.json`,
  and the full success study (`success_experiment.json`, `success_per_run.csv`,
  `success_deciles.csv`, `success_failures.csv`, `cached_routes.json`).
  `data/README.md` maps each file to the plot it feeds.
- `scripts/success_experiment.py` — regenerates the success-ratio dataset.
- `deploy/` — user-level systemd units + install script for the app and tunnel.
  The tunnel token is **not** in this repo; it lives at
  `~/.cloudflared/auroch.token` (mode 600) on the host.
- `dist/` — prebuilt static site (`npm run build` regenerates it).
- `docs/` — reference material copied from the original project.
- `SUMMARY_AND_GRAPHS.md` — results summary + explanation of all 9 graphs.

## Quick start

```bash
npm install
npm run dev            # dev server
npm run build          # rebuild dist/
npm run preview -- --host 0.0.0.0 --port 6001 --strictPort
```

## Honest caveat

All benchmark results are **proxies**, not a faithful reproduction of the
paper: synthetic log-uniform amounts, 50:50 initial liquidity, policies ignored,
parallel channels aggregated, and an Eq7-style max-flow feasibility solver
instead of the full auction/ECDSA stack (`paper_faithful: false`). Numbers are
reported exactly as measured; nothing is fudged. In particular, 0.8–0.9+
success is reachable only at ≥10× capacity with a diverse workload; at 1× the
measured value is ~0.61 and a max-flow ceiling confirms that most failures are
local-liquidity limited.
