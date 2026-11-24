"""Liquidity-dependent (dynamic) tau fee for Auroch-style forwarding.

The current prototype uses a random tau in [1, 10]. A defensible dynamic
replacement keeps that same range but makes tau a function of the *current*
directional liquidity ratio of the forwarding channel:

    r = available_liquidity / channel_capacity          (0 <= r <= 1)
    u = 1 - r                                            (utilization)
    tau(r) = tau_min + (tau_max - tau_min) * u ** alpha

Boundary conditions:
    r = 1 (idle channel)  -> tau_min (cheap, attract flow)
    r = 0 (empty channel) -> tau_max (expensive, conserve liquidity)

alpha controls how aggressively the fee rises as liquidity is consumed.
This is a proposed extension, not a rule stated by the Auroch paper.
"""

from __future__ import annotations


def tau_from_liquidity(
    available_liquidity: float,
    capacity: float,
    tau_min: float = 1.0,
    tau_max: float = 10.0,
    alpha: float = 2.0,
) -> float:
    """Return a dynamic tau in [tau_min, tau_max] from channel liquidity."""
    if capacity <= 0:
        return tau_max
    ratio = min(1.0, max(0.0, float(available_liquidity) / float(capacity)))
    utilization = 1.0 - ratio
    return tau_min + (tau_max - tau_min) * (utilization ** alpha)


def fee_from_liquidity(
    available_liquidity: float,
    capacity: float,
    amount: float,
    base_fee: float = 1.0,
    tau_min: float = 1.0,
    tau_max: float = 10.0,
    alpha: float = 2.0,
) -> float:
    """Per-hop fee: base fee + dynamic rate * amount."""
    tau = tau_from_liquidity(available_liquidity, capacity, tau_min, tau_max, alpha)
    return base_fee + tau * amount


if __name__ == "__main__":
    print("liquidity_ratio  tau(alpha=0.5)  tau(alpha=1)  tau(alpha=2)  tau(alpha=4)")
    for r in (0.0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0):
        vals = [tau_from_liquidity(r * 1000, 1000, alpha=a) for a in (0.5, 1, 2, 4)]
        print(f"{r:>14.2f}  " + "  ".join(f"{v:>13.3f}" for v in vals))
