"""Validate that generated worlds satisfy each style's layout constraints.

Over a region spanning many chunks:
  * rock-borders-corridor (aisles/cave only): every rock has a floor neighbour;
  * reachability: fraction of floor in the single largest connected component.
    Aisles/cave require ~100%; dungeon is report-only (sealed chambers are fine).

Run: uv run python scripts/validate.py
"""

from app.grid import World

_NEI = ((1, 0), (-1, 0), (0, 1), (0, -1))
# Minimum reachable fraction of the inner region per style (dungeon: report-only).
_MIN_REACH = {"aisles": 0.999, "cave": 0.999, "dungeon": 0.0}


def _largest_component(floor: set[tuple[int, int]]) -> set[tuple[int, int]]:
    """Return the biggest 4-connected component of the floor cell set."""
    seen: set[tuple[int, int]] = set()
    best: set[tuple[int, int]] = set()
    for cell in floor:
        if cell in seen:
            continue
        stack = [cell]
        seen.add(cell)
        comp = [cell]
        while stack:
            x, y = stack.pop()
            for dx, dy in _NEI:
                n = (x + dx, y + dy)
                if n in floor and n not in seen:
                    seen.add(n)
                    stack.append(n)
                    comp.append(n)
        if len(comp) > len(best):
            best = set(comp)
    return best


def check(seed: str, style: str, span: int = 96) -> None:
    world = World(seed, style)
    lo, hi = -span, span
    floor = {
        (x, y) for y in range(lo, hi) for x in range(lo, hi) if world.is_floor(x, y)
    }

    # Rock-borders-corridor, where the style promises it.
    border_ok = "n/a"
    if _MIN_REACH[style] > 0.99:
        bad = sum(
            1
            for y in range(lo + 1, hi - 1)
            for x in range(lo + 1, hi - 1)
            if (x, y) not in floor
            and not any((x + dx, y + dy) in floor for dx, dy in _NEI)
        )
        assert bad == 0, f"{style}/{seed}: {bad} rocks with no adjacent corridor"
        border_ok = "rocks-bordered"

    # Reachability: largest component's share of an inner sub-region (a margin lets
    # paths detour outside the sampled window without counting as unreachable).
    margin = 28
    biggest = _largest_component(floor)
    inner = [
        c
        for c in floor
        if lo + margin < c[0] < hi - margin and lo + margin < c[1] < hi - margin
    ]
    reach = sum(c in biggest for c in inner) / len(inner)
    assert reach >= _MIN_REACH[style], (
        f"{style}/{seed}: only {reach:.1%} of floor reachable "
        f"(need {_MIN_REACH[style]:.0%})"
    )

    rock_pct = 100 * (1 - len(floor) / (hi - lo) ** 2)
    print(
        f"{style:8s} {seed}: OK  reachable={reach:5.1%}  {border_ok:16s}"
        f"(~{rock_pct:.0f}% rock)"
    )


if __name__ == "__main__":
    for style in ("dungeon", "aisles", "cave"):
        for s in ["2026-08-04", "2026-08-05", "2026-01-01", "1999-12-31", "seed-xyz"]:
            check(s, style)
    print("all constraints hold")
