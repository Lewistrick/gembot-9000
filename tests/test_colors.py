"""Day colours: three biomes (inner, middle, outer) with hand-made themes, varied a
little by the seed. Which biome a tile shows is decided per tile by the client."""

import colorsys

from app.connection import Connection
from app.game import Game
from app.grid import (
    BIOME_EDGES,
    BIOME_RIDGE,
    THEMES,
    World,
    biome_palettes,
    biome_salt,
    biome_themes,
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
        assert len(set(biome_themes(seed_to_int(day)))) == 3
        assert len({p["floor"] for p in biome_palettes(seed_to_int(day))}) == 3


def test_floor_and_rock_always_read_apart_and_gems_stand_out() -> None:
    for day in DAYS:
        for p in biome_palettes(seed_to_int(day)):
            assert contrast(p["floor"], p["rock"]) >= 3, (day, p)
            assert contrast(p["gem"], p["rock"]) >= 3, (day, p)


def test_floors_are_richer_than_the_old_pale_pastels() -> None:
    for day in DAYS:
        for p in biome_palettes(seed_to_int(day)):
            _, light, _ = colorsys.rgb_to_hls(*rgb(p["floor"]))
            assert light <= 0.75  # the old generator always used 0.82


def test_the_palettes_and_ridge_pattern_are_the_same_for_the_same_day() -> None:
    a, b = World("2026-10-25"), World("2026-10-25")
    assert a.biomes == b.biomes and a.colors == a.biomes[0]
    assert biome_salt(a.seed) == biome_salt(b.seed)
    assert World("2026-10-24").biomes != a.biomes
    assert 0 <= biome_salt(a.seed) < 2**32


def test_welcome_carries_the_biomes_and_the_ridge() -> None:
    game = Game("2026-10-25")
    p = game.join("a", "Ann")
    assert p is not None
    w = Connection(game, p).welcome()
    assert w["biomes"] == game.world.biomes and len(w["biomes"]) == 3
    assert w["biome_edges"] == list(BIOME_EDGES) == [250.0, 600.0]
    assert w["biome_ridge"] == BIOME_RIDGE == 50.0
    assert w["biome_salt"] == biome_salt(game.world.seed)
