"""Persistence and the end of the day: save/restore, winners, rollover, rush hour."""

import random
from collections.abc import Iterator
from datetime import datetime
from typing import cast
from zoneinfo import ZoneInfo

import pytest

from app.game import Game
from app.server import Hub, Link
from app.store import Store


@pytest.fixture
def store(tmp_path) -> Iterator[Store]:
    s = Store(str(tmp_path / "game.db"))
    yield s
    s.close()


def fresh(day: str = "2026-10-22", **kw) -> Game:
    return Game(day, rng=random.Random(5), **kw)


def test_round_trip_restores_players_mined_gems_and_names(
    store: Store, tmp_path
) -> None:
    g = fresh()
    a, b = g.join("a", "Ann"), g.join("b", "Bob")
    assert a and b
    a.place(7, -3)
    a.delivered, a.spent, a.toll_income, a.cargo, a.chat = 120, 25, 4, 30, "hi"
    g.mined.add((10, 11))
    g.mined_log.append((10, 11))
    store.flush(g)
    store.close()

    again = Store(str(tmp_path / "game.db"))
    g2 = fresh()
    again.load_into(g2)
    p = g2.players["a"]
    assert (p.name, p.num, p.score, p.cargo, p.chat) == ("Ann", 1, 99, 30, "hi")
    assert (p.x, p.y) == (7, -3) and not p.in_world
    assert (10, 11) in g2.mined and g2.mined_log == [(10, 11)]
    intruder = g2.join("c", "Ann")
    assert intruder is not None and intruder.name == "Ann#2"  # still reserved
    assert g2.join("a", "Ann") is p  # the owner resumes their record
    assert g2.rank["a"] == 1  # the board was rebuilt on load
    again.close()


def test_only_changes_are_written(store: Store) -> None:
    g = fresh()
    a = g.join("a", "Ann")
    assert a is not None
    first = store.snapshot(g)
    assert set(first["players"]) == {"a"}
    store.write(first)
    assert store.snapshot(g)["players"] == {}  # nothing changed
    a.delivered = 5
    assert set(store.snapshot(g)["players"]) == {"a"}
    g.mined_log.append((1, 2))
    g.mined.add((1, 2))
    snap = store.snapshot(g)
    assert snap["mined"] == [(1, 2)]
    store.write(snap)
    assert store.snapshot(g)["mined"] == []


def test_days_are_kept_apart(store: Store) -> None:
    old = fresh("2026-10-21")
    p = old.join("a", "Ann")
    assert p is not None
    p.delivered = 50
    store.flush(old)
    new = fresh("2026-10-22")
    store.load_into(new)
    assert not new.players


def test_winners_and_missed_days_are_closed_out(store: Store) -> None:
    g = fresh("2026-10-20")
    a, b = g.join("a", "Ann"), g.join("b", "Bob")
    assert a and b
    a.delivered, b.delivered, b.spent = 40, 90, 10
    store.flush(g)
    store.close_out_past_days("2026-10-22")  # the server was down at midnight
    assert store.winners() == [
        {"day": "2026-10-20", "pid": "b", "name": "Bob", "score": 80}
    ]
    assert store.last_winner_before("2026-10-22") == "b"
    assert store.last_winner_before("2026-10-20") is None


def test_prune_keeps_recent_days_and_all_winners(store: Store) -> None:
    for d in range(10, 20):
        g = fresh(f"2026-10-{d}")
        p = g.join("a", "Ann")
        assert p is not None
        p.delivered = d
        store.flush(g)
        store.reset_bookkeeping()
    store.close_out_past_days("2026-10-25")
    store.prune("2026-10-25", keep_days=3)
    left = {r[0] for r in store.db.execute("SELECT DISTINCT day FROM players")}
    assert left == {"2026-10-17", "2026-10-18", "2026-10-19"}
    assert len(store.winners(50)) == 10


# -- the day ending ------------------------------------------------------ #
class FakeLink:
    def __init__(self) -> None:
        self.sent: list[dict] = []
        self.closed = False

    def push(self, reliable: list[dict], tick: dict | None) -> None:
        self.sent += reliable

    def finish(self) -> None:
        self.closed = True


def test_rollover_crowns_the_winner_and_starts_a_fresh_world(tmp_path) -> None:
    day = {"now": "2026-10-22"}
    hub = Hub(str(tmp_path / "h.db"), day_fn=lambda: day["now"])
    g = hub.game
    a, b = g.join("a", "Ann"), g.join("b", "Bob")
    assert a and b
    a.delivered, b.delivered, b.cargo = 30, 75, 999
    link = FakeLink()
    hub.links["a"] = cast(Link, link)

    day["now"] = "2026-10-23"
    hub.rollover("2026-10-23")

    assert link.closed and link.sent == [
        {"t": "newday", "day": "2026-10-23", "winner": {"name": "Bob", "score": 75}}
    ]
    assert hub.game.day == "2026-10-23" and hub.game.crown_pid == "b"
    assert not hub.game.players and hub.game.mined == set()  # cargo and names are gone
    assert hub.store.winners(1)[0]["name"] == "Bob"
    hub.shutdown_save()


def test_rollover_with_nobody_scoring_has_no_winner(tmp_path) -> None:
    hub = Hub(str(tmp_path / "h.db"), day_fn=lambda: "2026-10-22")
    hub.game.join("a", "Ann")
    hub.rollover("2026-10-23")
    assert hub.game.crown_pid is None and hub.store.winners() == []
    hub.shutdown_save()


def test_restart_resumes_today(tmp_path) -> None:
    path = str(tmp_path / "h.db")
    hub = Hub(path, day_fn=lambda: "2026-10-22")
    p = hub.game.join("a", "Ann")
    assert p is not None
    p.delivered = 42
    hub.shutdown_save()
    hub2 = Hub(path, day_fn=lambda: "2026-10-22")
    assert hub2.game.players["a"].score == 42
    hub2.shutdown_save()


# -- rush hour ------------------------------------------------------------ #
def at(hour: int, minute: int = 0) -> datetime:
    return datetime(2026, 10, 22, hour, minute, tzinfo=ZoneInfo("UTC"))


def test_rush_hour_doubles_gems_and_warns_once() -> None:
    now = {"t": at(12)}
    g = fresh(wall=lambda: now["t"])
    g.tick()
    assert g.multiplier == 1 and not g.announcements
    assert g.day_left == 12 * 3600
    now["t"] = at(23, 1)
    g.tick_count = 40  # next tick refreshes the board and clock
    g.tick()
    assert g.multiplier == 2 and "RUSH HOUR" in g.announcements[0][1]
    g.tick_count = 80
    g.tick()
    assert len(g.announcements) == 1  # not repeated
    now["t"] = at(23, 51)
    g.tick_count = 120
    g.tick()
    assert "10 minutes left" in g.announcements[1][1]
