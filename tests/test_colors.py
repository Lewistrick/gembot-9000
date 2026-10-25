"""Day colours: three biomes (inner, middle, outer) with hand-made themes, varied a
little by the seed and blended smoothly across their edges."""

import colorsys

from app.grid import (
    BIOME_EDGES,
    THEMES,
    World,
    biome_themes,
    colors_for_seed,
    seed_to_int,
)

DAYS = [f"2026-{m:02d}-{d:02d}" for m in (1, 4, 7, 10) for d in range(1, 29, 3)]


def rgb(hexcol: str) -> tuple[float, float, float]:
    n = int(hexcol[1:], 16)
    return ((n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255)


def luminance(hexcol: str) -> float:
    def lin(c: float) -> float:
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = (lin(c) for c in rgb(hexcol))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a: str, b: str) -> float:
    la, lb = sorted((luminance(a), luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def test_there_are_about_ten_themes_and_each_day_has_three_different_ones() -> None:
    assert len(THEMES) >= 10
    for day in DAYS:
        picked = biome_themes(seed_to_int(day))
        assert len(set(picked)) == 3


def test_floor_and_rock_always_read_apart_and_gems_stand_out() -> None:
    for day in DAYS:
        seed = seed_to_int(day)
        for d in (0, 150, 250, 400, 600, 900):
            p = colors_for_seed(seed, d)
            assert contrast(p["floor"], p["rock"]) >= 3, (day, d, p)
            assert contrast(p["gem"], p["rock"]) >= 3, (day, d, p)


def test_floors_are_richer_than_the_old_pale_pastels() -> None:
    for day in DAYS:
        _, light, _ = colorsys.rgb_to_hls(
            *rgb(colors_for_seed(seed_to_int(day))["floor"])
        )
        assert light <= 0.75  # the old generator always used 0.82


def test_the_palette_is_the_same_for_the_same_day() -> None:
    a, b = World("2026-10-25"), World("2026-10-25")
    assert a.palette(0) == b.palette(0) and a.palette(700) == b.palette(700)
    assert World("2026-10-24").palette(0) != a.palette(0)


def test_each_biome_is_flat_inside_and_blends_smoothly_across_its_edges() -> None:
    seed = seed_to_int("2026-10-25")
    assert colors_for_seed(seed, 50) == colors_for_seed(
        seed, 200
    )  # inside the inner biome
    assert colors_for_seed(seed, 300) == colors_for_seed(seed, 550)  # the middle one
    assert colors_for_seed(seed, 650) == colors_for_seed(seed, 2000)  # the outer one
    assert (
        colors_for_seed(seed, 100)
        != colors_for_seed(seed, 400)
        != colors_for_seed(seed, 800)
    )
    for edge in BIOME_EDGES:
        prev = colors_for_seed(seed, edge - 30)
        for d in range(int(edge) - 29, int(edge) + 31):  # tile by tile across the edge
            cur = colors_for_seed(seed, d)
            for key in ("floor", "rock"):
                step = max(
                    abs(x - y)
                    for x, y in zip(rgb(prev[key]), rgb(cur[key]), strict=True)
                )
                assert step < 0.06, (edge, d, key)
            prev = cur
