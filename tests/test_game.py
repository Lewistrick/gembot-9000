"""Game rules: joining, names, idle removal, mining, delivery, chat, ranking."""

import math
import random

import pytest

from app.game import (
    CARGO_MAX,
    CHAT_MAX,
    DISCONNECT_GRACE,
    IDLE_CROWD,
    IDLE_KICK,
    IDLE_WARN,
    LIGHT_EVERY,
    MAX_PLAYERS,
    NAME_MAX,
    Game,
    clean_text,
)
from app.grid import BASE_RADIUS, MEGA_VALUE, World
from app.player import Player, Ride
from app.rail import Hub


class FakeClock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()


@pytest.fixture
def game(clock: FakeClock) -> Game:
    return Game("2026-10-22", clock=clock, rng=random.Random(7))


def crowd(game: Game) -> list[str]:
    """Fill the mine past IDLE_CROWD with busy players, so the idle rule applies."""
    pids = [f"busy{i}" for i in range(IDLE_CROWD)]
    for pid in pids:
        assert game.join(pid, pid) is not None
    return pids


def busy_tick(game: Game, pids: list[str]) -> None:
    """A tick in which the crowd has just given input (only the others are idle)."""
    for pid in pids:
        game.touch(pid)
    game.tick()


def far_gem(game: Game) -> tuple[int, int, int]:
    """A gem site outside the base disk (so pickup is not instantly delivered)."""
    sites = [
        g
        for g in game.world.gems_in(-120, -120, 240, 240)
        if math.hypot(g[0], g[1]) > BASE_RADIUS + 2
    ]
    assert sites
    return min(sites, key=lambda g: math.hypot(g[0], g[1]))


# -- joining ------------------------------------------------------------- #
def test_join_spawns_on_floor_inside_base(game: Game) -> None:
    p = game.join("a", "Ann")
    assert p is not None and p.in_world and p.connected
    assert math.hypot(p.x, p.y) <= BASE_RADIUS
    assert game.world.is_floor(round(p.x), round(p.y))
    assert game.online_count() == 1


def test_server_full_at_100_and_slot_frees_on_quit(game: Game) -> None:
    for i in range(MAX_PLAYERS):
        assert game.join(f"p{i}", f"P{i}") is not None
    assert game.online_count() == MAX_PLAYERS
    assert game.join("extra", "Extra") is None
    game.quit("p0")
    assert game.join("extra", "Extra") is not None
    assert game.join("p0", "P0") is None  # the slot is gone again


def test_rejoin_resumes_position_and_score(game: Game) -> None:
    p = game.join("a", "Ann")
    assert p is not None
    p.place(5, 5)
    p.delivered = 120
    game.quit("a")
    assert not p.in_world
    again = game.join("a", "Ann")
    assert again is p and again.in_world
    assert (again.x, again.y) == (5, 5) and again.score == 120


# -- names --------------------------------------------------------------- #
def test_duplicate_name_gets_numbered_suffix(game: Game) -> None:
    a, b, c = game.join("a", "Zed"), game.join("b", "zed"), game.join("c", "ZED")
    assert a and b and c
    assert (a.name, b.name, c.name) == ("Zed", "zed#2", "ZED#3")


def test_name_stays_reserved_while_owner_is_away(game: Game, clock: FakeClock) -> None:
    owner = game.join("owner", "Kobold")
    assert owner is not None
    busy = crowd(game)
    clock.t += IDLE_KICK + 1
    busy_tick(game, busy)  # the idle kick removes the owner from the world
    assert not owner.in_world
    thief = game.join("thief", "Kobold")
    assert thief is not None and thief.name == "Kobold#2"
    back = game.join("owner", "Kobold")
    assert back is not None and back.name == "Kobold"


def test_long_names_are_truncated_with_suffix_inside_the_limit(game: Game) -> None:
    long = "x" * 40
    a, b = game.join("a", long), game.join("b", long)
    assert a and b
    assert len(a.name) == NAME_MAX and len(b.name) == NAME_MAX
    assert b.name.endswith("#2")


def test_empty_name_falls_back_to_bot_number(game: Game) -> None:
    p = game.join("a", "   \x00" + chr(0x200B) + " ")
    assert p is not None and p.name == f"Bot-{p.num}"


def test_rejoin_with_new_name_releases_the_old_one(game: Game) -> None:
    p = game.join("a", "Old")
    assert p is not None
    game.join("a", "New")
    assert p.name == "New"
    q = game.join("b", "Old")
    assert q is not None and q.name == "Old"


# -- idle and disconnect ------------------------------------------------- #
def test_idle_warning_then_kick(game: Game, clock: FakeClock) -> None:
    p = game.join("a", "Ann")
    assert p is not None
    busy = crowd(game)
    p.notices.clear()
    clock.t += IDLE_WARN + 1
    busy_tick(game, busy)
    assert p.in_world
    assert [n["t"] for n in p.notices] == ["warn"]
    clock.t += IDLE_KICK - IDLE_WARN
    busy_tick(game, busy)
    assert not p.in_world
    assert p.notices[-1] == {"t": "kicked", "why": "idle"}


def test_nobody_is_removed_for_idling_with_ten_or_fewer_in_the_mine(
    game: Game, clock: FakeClock
) -> None:
    p = game.join("a", "Ann")
    assert p is not None
    busy = crowd(game)[:-1]  # Ann and nine others: ten in the mine
    game.quit(f"busy{IDLE_CROWD - 1}")
    assert game.online_count() == IDLE_CROWD
    p.notices.clear()
    clock.t += 3 * IDLE_KICK
    busy_tick(game, busy)
    assert p.in_world and not p.notices  # not even a warning


def test_when_the_mine_fills_up_a_long_idle_player_is_warned_first(
    game: Game, clock: FakeClock
) -> None:
    p = game.join("a", "Ann")
    assert p is not None
    busy = crowd(game)[:-1]
    game.quit(f"busy{IDLE_CROWD - 1}")
    clock.t += 3 * IDLE_KICK  # idle for half an hour while there was room
    busy_tick(game, busy)
    late = game.join("late", "Late")  # the eleventh player
    assert late is not None
    p.notices.clear()
    busy_tick(game, [*busy, "late"])
    assert p.in_world and [n["t"] for n in p.notices] == ["warn"]
    assert p.notices[0]["left"] == int(
        IDLE_KICK - IDLE_WARN
    )  # a full minute to respond
    clock.t += IDLE_KICK - IDLE_WARN
    busy_tick(game, [*busy, "late"])
    assert not p.in_world


def test_a_warning_is_withdrawn_when_the_mine_empties_again(
    game: Game, clock: FakeClock
) -> None:
    p = game.join("a", "Ann")
    assert p is not None
    busy = crowd(game)
    clock.t += IDLE_WARN + 1
    busy_tick(game, busy)
    assert p.warned
    game.quit(busy.pop())  # back to ten
    p.notices.clear()
    busy_tick(game, busy)
    assert p.notices == [{"t": "warn", "left": 0, "why": "idle"}] and not p.warned
    clock.t += IDLE_KICK
    busy_tick(game, busy)
    assert p.in_world


def test_input_resets_the_idle_timer(game: Game, clock: FakeClock) -> None:
    p = game.join("a", "Ann")
    assert p is not None
    busy = crowd(game)
    clock.t += IDLE_KICK - 5
    game.control("a", True, False, False, False)
    clock.t += IDLE_KICK - 5
    busy_tick(game, busy)
    assert p.in_world  # 595 s since the last input: warned, not kicked


def test_dropped_socket_lingers_for_grace_period(game: Game, clock: FakeClock) -> None:
    p = game.join("a", "Ann")
    assert p is not None
    game.leave("a")
    clock.t += DISCONNECT_GRACE - 1
    game.tick()
    assert p.in_world and not p.connected
    clock.t += 2
    game.tick()
    assert not p.in_world


def test_reconnect_within_grace_keeps_robot(game: Game, clock: FakeClock) -> None:
    p = game.join("a", "Ann")
    assert p is not None
    game.leave("a")
    clock.t += 5
    assert game.join("a", "Ann") is p
    clock.t += 60
    game.control("a", False, False, False, False)
    game.tick()
    assert p.in_world and p.connected


# -- mining and delivery -------------------------------------------------- #
def test_mining_adds_cargo_once_and_gems_never_return(game: Game) -> None:
    x, y, value = far_gem(game)
    a, b = game.join("a", "A"), game.join("b", "B")
    assert a and b
    a.place(x, y)
    b.place(x, y)
    game.tick()
    assert a.cargo == value and b.cargo == 0  # first come, first served
    assert (x, y) in game.mined
    game.tick()
    assert a.cargo == value  # standing on it again gives nothing
    assert game.mined_log == [(x, y)]


def test_a_full_cargo_hold_leaves_the_gem_where_it_is(
    game: Game, clock: FakeClock
) -> None:
    x, y, value = far_gem(game)
    a = game.join("a", "A")
    assert a is not None
    a.cargo = CARGO_MAX - value + 1  # one short of room
    a.place(x, y)
    a.notices.clear()
    game.tick()
    assert (
        a.cargo == CARGO_MAX - value + 1 and (x, y) not in game.mined
    )  # still there for others
    assert [n for n in a.notices if n["t"] == "cargofull"] == [
        {"t": "cargofull", "max": CARGO_MAX}
    ]
    game.tick()
    assert len([n for n in a.notices if n["t"] == "cargofull"]) == 1  # not every tick
    clock.t += 11
    game.tick()
    assert len([n for n in a.notices if n["t"] == "cargofull"]) == 2
    a.cargo = CARGO_MAX - value  # exactly enough room
    game.tick()
    assert a.cargo == CARGO_MAX and (x, y) in game.mined


def test_cargo_only_scores_when_delivered_to_the_base(game: Game) -> None:
    x, y, value = far_gem(game)
    a = game.join("a", "A")
    assert a is not None
    a.place(x, y)
    game.tick()
    assert (a.cargo, a.score) == (value, 0)
    a.place(0, 0)
    game.tick()
    assert (a.cargo, a.score) == (0, value)
    assert {"t": "delivered", "v": value} in a.notices


def test_rush_hour_multiplier_doubles_gem_value(game: Game) -> None:
    x, y, value = far_gem(game)
    game.multiplier = 2
    a = game.join("a", "A")
    assert a is not None
    a.place(x, y)
    game.tick()
    assert a.cargo == 2 * value


def test_mega_gem_is_announced(game: Game) -> None:
    x, y = next(iter(game.world.mega_sites))
    a = game.join("a", "Ann")
    assert a is not None
    a.place(x, y)
    game.tick()
    assert a.cargo == MEGA_VALUE
    assert any("MEGA" in text and "Ann" in text for _, text in game.announcements)


# -- chat ---------------------------------------------------------------- #
def test_clean_text_strips_control_and_invisible_characters() -> None:
    dirty = "  hi\x00 " + chr(0x202E) + "there" + chr(0x200B) + "\n  you "
    assert clean_text(dirty, 60) == "hi there you"
    assert clean_text(123, 60) == ""
    assert len(clean_text("y" * 500, CHAT_MAX)) == CHAT_MAX


def test_chat_sets_clears_and_bumps_meta_version(game: Game, clock: FakeClock) -> None:
    p = game.join("a", "Ann")
    assert p is not None
    v = p.meta_version
    assert game.set_chat("a", "hello")
    assert p.chat == "hello" and p.meta_version == v + 1
    clock.t += 2
    assert game.set_chat("a", "hello")
    assert p.meta_version == v + 1  # unchanged text does not resend
    clock.t += 2
    assert game.set_chat("a", "")
    assert p.chat == "" and p.meta_version == v + 2


def test_chat_is_rate_limited(game: Game, clock: FakeClock) -> None:
    p = game.join("a", "Ann")
    assert p is not None
    assert game.set_chat("a", "one")
    assert not game.set_chat("a", "two")  # too soon
    assert p.chat == "one"
    clock.t += 1.1
    assert game.set_chat("a", "two") and p.chat == "two"


# -- leaderboard --------------------------------------------------------- #
def test_leaderboard_ranks_by_score_then_join_order(game: Game) -> None:
    a, b, c = game.join("a", "A"), game.join("b", "B"), game.join("c", "C")
    assert a and b and c
    a.delivered, b.delivered, c.delivered = 50, 90, 50
    b.spent = 50  # 90 - 50 = 40
    game.tick()  # the first tick builds the board
    assert [r["n"] for r in game.board_rows()] == ["A", "C", "B"]
    assert game.rank["a"] == 1 and game.rank["b"] == 3


# -- light: hubs keep the robot from getting lost ------------------------ #
class OpenWorld(World):
    def is_floor(self, x: int, y: int) -> bool:
        return True


def lost_notices(player: Player) -> list[dict]:
    return [n for n in player.notices if n["t"] == "lost"]


def test_lost_far_from_every_hub_returns_to_base_with_half_the_cargo(
    game: Game,
) -> None:
    game.world = OpenWorld("t")
    p = game.join("a", "Ann")
    assert p is not None
    p.place(351, 0)
    p.cargo = 11
    for _ in range(LIGHT_EVERY):  # the light is checked every few ticks
        game.tick()
    assert math.hypot(p.x, p.y) <= BASE_RADIUS and p.speed == 0.0
    assert lost_notices(p) == [{"t": "lost", "v": 6}]  # 11 -> 5 are kept...
    assert p.cargo == 0 and p.delivered == 5  # ...and banked, being at the base


def test_a_hub_within_reach_keeps_the_robot_found(game: Game) -> None:
    game.world = OpenWorld("t")
    p = game.join("a", "Ann")
    assert p is not None
    game.rail.hubs[1] = Hub(1, 400, 0, "b", 0)
    p.place(650, 0)  # 250 from that hub, 650 from the base
    p.cargo = 10
    for _ in range(2 * LIGHT_EVERY):
        game.tick()
    assert (p.x, p.y) == (650, 0) and p.cargo == 10 and not lost_notices(p)
    p.place(751, 0)  # 351 from the hub
    for _ in range(LIGHT_EVERY):
        game.tick()
    assert math.hypot(p.x, p.y) <= BASE_RADIUS and lost_notices(p)


def test_349_tiles_from_the_base_is_still_found(game: Game) -> None:
    game.world = OpenWorld("t")
    p = game.join("a", "Ann")
    assert p is not None
    p.place(349, 0)
    for _ in range(2 * LIGHT_EVERY):
        game.tick()
    assert (p.x, p.y) == (349, 0) and not lost_notices(p)


def test_riding_players_are_never_lost(game: Game) -> None:
    p = game.join("a", "Ann")
    assert p is not None
    p.place(305, 0)
    p.ride = Ride(pts=[(305.0 + i, 0.0) for i in range(1, 40)])
    for _ in range(LIGHT_EVERY):
        game.tick()
    assert p.ride is not None and p.x > 305 and not lost_notices(p)
