"""Following one other player: they are told, the follower's tick says where they are,
and inactive players can't be followed."""

import random

from app.connection import Connection
from app.game import FOLLOW_IDLE, Game
from app.player import hue_for


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


def make() -> tuple[Game, Clock]:
    clock = Clock()
    game = Game("2026-10-22", clock=clock, rng=random.Random(2))
    for pid, name in (("a", "Ann"), ("b", "Bob"), ("c", "Cy")):
        assert game.join(pid, name) is not None
    for p in game.players.values():
        p.notices.clear()
    return game, clock


def kinds(game: Game, pid: str, t: str) -> list[dict]:
    return [n for n in game.players[pid].notices if n["t"] == t]


def test_following_tells_both_players() -> None:
    game, _ = make()
    game.follow("a", "b")
    assert game.players["a"].follow == "b"
    bob = game.players["b"]
    assert kinds(game, "a", "following") == [
        {"t": "following", "id": "b", "name": "Bob", "hue": hue_for(bob.num)}
    ]
    assert kinds(game, "b", "followed") == [{"t": "followed", "by": "Ann"}]


def test_you_follow_one_player_at_a_time_and_can_stop() -> None:
    game, _ = make()
    game.follow("a", "b")
    game.follow("a", "c")
    assert game.players["a"].follow == "c" and kinds(game, "c", "followed")
    game.follow("a", None)
    assert game.players["a"].follow is None
    assert kinds(game, "a", "following")[-1] == {"t": "following", "id": None}


def test_you_cannot_follow_yourself_or_someone_unknown() -> None:
    game, _ = make()
    game.follow("a", "a")
    game.follow("a", "nobody")
    assert game.players["a"].follow is None and not kinds(game, "a", "following")


def test_inactive_players_cannot_be_followed() -> None:
    game, clock = make()
    clock.t += FOLLOW_IDLE + 1
    game.touch("a")  # Ann is active, Bob has done nothing for a while
    game.follow("a", "b")
    assert game.players["a"].follow is None
    assert kinds(game, "a", "following") == [
        {"t": "following", "id": None, "why": "inactive", "name": "Bob"}
    ]
    assert not kinds(game, "b", "followed")


def test_following_stops_when_the_other_goes_inactive_or_leaves() -> None:
    game, clock = make()
    game.follow("a", "b")
    game.follow("c", "b")
    clock.t += FOLLOW_IDLE + 1
    game.touch("a")
    game.touch("c")
    for _ in range(20):
        game.tick()
    assert game.players["a"].follow is None
    assert kinds(game, "a", "following")[-1]["why"] == "inactive"
    game.touch("b")
    game.follow("c", "b")
    game.quit("b")
    for _ in range(20):
        game.tick()
    assert game.players["c"].follow is None
    assert kinds(game, "c", "following")[-1]["why"] == "gone"


def test_the_followers_tick_says_where_the_other_is_even_far_away() -> None:
    game, _ = make()
    game.players["b"].place(400.0, -250.0)
    conn = Connection(game, game.players["a"])
    conn.handle({"action": "follow", "id": "b"})
    _, tick = conn.frame([0])
    assert tick is not None and tick["fw"] == [400.0, -250.0]
    conn.handle({"action": "follow", "id": None})
    _, tick = conn.frame([0])
    assert tick is not None and "fw" not in tick
    for bad in (42, "", "x" * 100, [], {}):
        conn.handle(
            {"action": "follow", "id": bad}
        )  # garbage is ignored (or stops following)
    assert game.players["a"].follow is None


def test_others_see_when_a_player_goes_inactive() -> None:
    game, clock = make()
    bob = game.players["b"]
    before = bob.meta_version
    clock.t += FOLLOW_IDLE + 1
    for _ in range(20):
        game.tick()
    assert bob.inactive and bob.meta_version > before
    game.touch("b")
    for _ in range(20):
        game.tick()
    assert not bob.inactive
