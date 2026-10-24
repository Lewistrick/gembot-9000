"""Rail in play: building, tolls, riding, carts, and what other clients are sent."""

import math
import random

from app.connection import Connection
from app.game import Game
from app.grid import World
from app.player import Player
from app.rail import HUB_COST, RIDE_SPEED
from app.store import Store


class Open(World):
    """Floor everywhere and no gems, so only the rail rules matter."""

    def is_floor(self, x: int, y: int) -> bool:
        return True

    def gem_on_floor(self, x: int, y: int) -> int | None:
        return None


def make(*names: str, score: int = 1000) -> tuple[Game, list[Player]]:
    game = Game("2026-10-22", rng=random.Random(1))
    game.world = Open("t")
    players = []
    for name in names:
        p = game.join(name.lower(), name)
        assert p is not None
        p.delivered = score
        p.place(0, 0)
        players.append(p)
    return game, players


def notes(p: Player, kind: str) -> list[dict]:
    return [n for n in p.notices if n["t"] == kind]


def lay(game: Game, p: Player, x: int, y: int) -> int:
    """Stand on a hub (where p is), build a track to (x, y), return the new hub id."""
    before = set(game.rail.hubs)
    game.build_track(p.pid, x, y, True)
    new = set(game.rail.hubs) - before
    assert len(new) == 1, p.notices
    return new.pop()


def settle(game: Game, ticks: int = 200) -> None:
    for _ in range(ticks):
        game.tick()


# -- building -------------------------------------------------------------- #
def test_build_track_needs_a_confirmed_second_tap_and_spends_score() -> None:
    game, (ann,) = make("Ann")
    game.build_track("ann", 14, 0, False)  # preview only
    quote = notes(ann, "quote")[0]
    assert quote["ok"] and quote["cost"] == HUB_COST + 14 and quote["new"]
    assert len(game.rail.hubs) == 1 and ann.score == 1000
    game.build_track("ann", 14, 0, True)
    assert len(game.rail.hubs) == 2 and ann.score == 1000 - (HUB_COST + 14)
    assert game.rail.hubs[1].builder == "ann"


def test_you_must_be_parked_on_a_hub_to_build_a_track() -> None:
    game, (ann,) = make("Ann")
    ann.place(40, 40)
    game.build_track("ann", 50, 40, True)
    assert "Stop on a hub" in notes(ann, "rail")[0]["msg"]
    ann.place(0, 0)
    ann.speed = 9.0  # driving through, not stopped
    game.build_track("ann", 14, 0, True)
    assert len(game.rail.hubs) == 1


def test_refusals_cost_nothing_and_explain_why() -> None:
    game, (ann,) = make("Ann", score=20)
    game.build_track("ann", 14, 0, True)
    assert not notes(ann, "built") and ann.score == 20
    assert "Needs 39" in notes(ann, "rail")[0]["msg"]
    game.hub_options("ann")  # at the base disk
    assert "base" in notes(ann, "rail")[-1]["msg"]


def test_placing_a_hub_offers_nearby_hubs_and_builds_hub_and_track_together() -> None:
    game, (ann,) = make("Ann")
    a = lay(game, ann, 14, 0)
    ann.place(20, 6)
    game.hub_options("ann")
    opts = notes(ann, "hubopts")[0]
    assert (opts["x"], opts["y"]) == (20, 6)
    assert [o["to"] for o in opts["opts"]] == [a, 0]
    assert opts["opts"][0]["cost"] == HUB_COST + 8 and opts["opts"][0]["linked"]
    assert opts["opts"][0]["short"] == HUB_COST + 8  # no cargo: all of it from score
    before = ann.score
    game.build_hub("ann", a, 20, 6, pay_score=True)
    new = game.rail.hubs[max(game.rail.hubs)]
    assert (new.x, new.y, new.out, new.builder) == (20, 6, a, "ann")
    assert ann.score == before - (HUB_COST + 8)
    assert notes(ann, "built")[-1] == {
        "t": "built",
        "v": HUB_COST + 8,
    }  # the client floats "-33"


def test_a_hub_is_never_built_without_a_track() -> None:
    game, (ann,) = make("Ann")
    ann.place(30, 0)
    game.build_hub("ann", 99, 30, 0)  # no such target
    assert len(game.rail.hubs) == 1 and ann.spent == 0
    game.build_hub("ann", 0, 31, 0)  # not the tile you are standing on
    assert len(game.rail.hubs) == 1 and "moved" in notes(ann, "rail")[-1]["msg"]


def test_placing_a_hub_needs_you_standing_still_and_enough_gems() -> None:
    game, (ann,) = make("Ann", score=30)
    ann.place(30, 0)
    ann.speed = 9.0
    game.hub_options("ann")
    assert "Stand still" in notes(ann, "rail")[-1]["msg"]
    ann.speed = 0.0
    game.hub_options("ann")
    assert not notes(ann, "hubopts") and "Needs 55" in notes(ann, "rail")[-1]["msg"]
    game.build_hub("ann", 0, 30, 0)
    assert len(game.rail.hubs) == 1 and ann.spent == 0


def test_standing_on_a_hub_cannot_place_another_one() -> None:
    game, (ann,) = make("Ann")
    a = lay(game, ann, 14, 0)
    ann.place(14, 0)
    game.hub_options("ann")
    assert "close" in notes(ann, "rail")[-1]["msg"]
    game.build_hub("ann", 0, 14, 0)  # would otherwise just re-link a to the base
    assert len(game.rail.hubs) == 2 and game.rail.hubs[a].out == 0


# -- riding and tolls --------------------------------------------------------- #
def two_player_network() -> tuple[Game, Player, Player, int, int]:
    """base <- A (ann's) <- B (bob's)."""
    game, (ann, bob) = make("Ann", "Bob")
    a = lay(game, ann, 14, 0)
    bob.place(14, 0)
    b = lay(game, bob, 28, 0)
    return game, ann, bob, a, b


def test_riding_pays_one_point_per_foreign_hub_from_cargo_to_the_builder() -> None:
    game, ann, bob, _a, _b = two_player_network()
    ann.place(28, 0)  # ann stands on bob's hub
    ann.cargo = 5
    spent_before, bob_income = ann.score, bob.toll_income
    game.ride("ann", 0)  # route: b (bob's), a (ann's), base
    assert ann.cargo == 4  # one toll: bob's hub at the start
    assert bob.toll_income == bob_income + 1
    assert ann.score == spent_before  # tolls come from cargo, never from score
    assert notes(bob, "toll") == [{"t": "toll", "v": 1, "from": "Ann"}]
    assert ann.ride is not None


def test_a_toll_you_cannot_cover_with_cargo_is_asked_of_your_score() -> None:
    game, ann, bob, a, _b = two_player_network()
    ann.place(28, 0)
    ann.cargo = 0
    score, income = ann.score, bob.toll_income
    game.ride("ann", a)  # bob's hub at the start: one toll
    ask = notes(ann, "pay")[-1]
    assert (
        ann.ride is None
        and ask["cost"] == 1
        and ask["score"] == 1
        and ask["cargo"] == 0
    )
    assert ask["retry"] == {"action": "ride", "to": a}
    assert ann.score == score and bob.toll_income == income  # nothing charged yet
    game.ride("ann", a, pay_score=True)
    assert (
        ann.ride is not None
        and ann.score == score - 1
        and bob.toll_income == income + 1
    )


def test_your_own_hubs_are_free() -> None:
    game, ann, _bob, _a, _b = two_player_network()
    ann.cargo = 0
    ann.place(14, 0)
    game.ride("ann", 0)  # ann's own hub then the base: free
    assert ann.ride is not None and ann.cargo == 0


def test_the_ride_carries_you_to_the_destination_and_ignores_input() -> None:
    game, ann, _bob, _a, b = two_player_network()
    ann.place(14, 0)
    ann.cargo = 3
    game.ride("ann", b)  # ends on bob's hub: one toll
    assert ann.ride is not None and ann.cargo == 2
    game.control("ann", True, False, True, False)  # steering is ignored mid-ride
    assert not ann.up and not ann.left
    start = ann.x
    game.tick()
    assert abs(ann.x - start - RIDE_SPEED * 0.05) < 1e-6  # moved along the track
    settle(game, 40)
    assert ann.ride is None and (round(ann.x), round(ann.y)) == (28, 0)
    assert ann.speed == 0.0


def test_riding_to_the_base_delivers_the_cargo() -> None:
    game, ann, _bob, _a, _b = two_player_network()
    ann.place(14, 0)
    ann.cargo = 100
    before = ann.delivered
    game.ride("ann", 0)
    settle(game, 40)
    assert ann.cargo == 0 and ann.delivered == before + 100


def test_cannot_ride_to_another_network_or_while_moving() -> None:
    game, ann, _bob, _a, _b = two_player_network()
    ann.place(40, 40)
    game.rail.restore([(50, 40, 40, "ann", None)])  # an old save's hub without a track
    loose = 50
    ann.place(14, 0)
    ann.cargo = 5
    game.ride("ann", loose)
    assert ann.ride is None and "not on this network" in notes(ann, "rail")[-1]["msg"]
    ann.speed = 10.0
    game.ride("ann", 0)
    assert ann.ride is None


# -- carts ---------------------------------------------------------------------- #
def test_shipping_pays_tolls_from_the_shipment_and_scores_on_arrival() -> None:
    game, ann, bob, _a, _b = two_player_network()
    ann.place(28, 0)
    ann.cargo = 50
    before, bob_income = ann.delivered, bob.toll_income
    game.send_cargo("ann")
    assert ann.cargo == 0 and len(game.carts) == 1
    assert game.carts[0].value == 49 and bob.toll_income == bob_income + 1
    settle(game, 200)  # 28 tiles at 12 tiles/s
    assert not game.carts and ann.delivered == before + 49


def test_a_shipment_must_be_worth_more_than_its_tolls() -> None:
    game, ann, _bob, _a, _b = two_player_network()
    ann.place(28, 0)
    ann.cargo = 1
    game.send_cargo("ann")
    assert not game.carts and "eat the whole shipment" in notes(ann, "rail")[-1]["msg"]
    ann.cargo = 0
    game.send_cargo("ann")
    assert "nothing to ship" in notes(ann, "rail")[-1]["msg"]


def test_settling_credits_carts_still_on_the_rails() -> None:
    game, ann, _bob, _a, _b = two_player_network()
    ann.place(14, 0)
    ann.cargo = 30
    game.send_cargo("ann")
    before = ann.delivered
    game.settle_carts()
    assert not game.carts and ann.delivered == before + 30


# -- network map ------------------------------------------------------------------ #
def test_network_map_lists_the_component_with_toll_quotes() -> None:
    game, ann, _bob, a, b = two_player_network()
    ann.place(28, 0)
    ann.cargo = 5
    ann.notices.clear()
    game.net_map("ann")
    net = notes(ann, "net")[0]
    assert net["at"] == b and net["cargo"] == 5
    rows = {r["id"]: r for r in net["hubs"]}
    assert set(rows) == {0, a, b}
    assert rows[0]["by"] == "BASE" and rows[a]["by"] == "Ann" and rows[b]["by"] == "Bob"
    assert rows[0]["toll"] == 1 and rows[a]["toll"] == 1  # bob's own hub at the start
    assert net["ship"] == {"toll": 1}


# -- what clients are sent ----------------------------------------------------------- #
def test_hubs_are_sent_in_full_on_join_then_as_deltas() -> None:
    game, (ann, bob) = make("Ann", "Bob")
    lay(game, ann, 14, 0)
    late = Connection(game, bob)
    first = [m for m in late.frame([0])[0] if m["t"] == "hubs"]
    assert first[0]["list"] == [[1, 14, 0, ann.num, 0]]
    assert not [m for m in late.frame([0])[0] if m["t"] == "hubs"]
    bob.place(14, 0)
    new = lay(game, bob, 28, 0)
    delta = [m for m in late.frame([0])[0] if m["t"] == "hubs"]
    assert delta[0]["list"] == [[new, 28, 0, bob.num, 1]]


def test_carts_and_riders_appear_in_the_tick() -> None:
    game, (ann, bob) = make("Ann", "Bob")
    a = lay(game, ann, 14, 0)
    ann.place(14, 0)
    ann.cargo = 20
    game.send_cargo("ann")
    conn = Connection(game, bob)
    game.tick_count = 2
    tick = conn.frame([0])[1]
    assert len(tick["k"]) == 1 and tick["k"][0][0] == game.carts[0].id
    ann.cargo = 1
    ann.place(14, 0)
    game.ride("ann", 0)
    game.tick_count = 4
    tick = conn.frame([0])[1]
    assert [row[4] for row in tick["o"] if row[0] == ann.num] == [1]
    assert a >= 1


def test_actions_reach_the_game_through_the_protocol() -> None:
    game, (ann,) = make("Ann")
    conn = Connection(game, ann)
    conn.handle({"action": "build_track", "x": 14, "y": 0, "confirm": False})
    assert notes(ann, "quote")
    conn.handle({"action": "build_track", "x": 14, "y": 0, "confirm": True})
    assert len(game.rail.hubs) == 2
    conn.handle({"action": "build_track", "x": "nope"})  # garbage is ignored
    conn.handle({"action": "ride", "to": "x"})
    ann.place(14, 0)
    ann.notices.clear()
    conn.handle({"action": "netmap"})
    assert notes(ann, "net")


# -- persistence ------------------------------------------------------------------------ #
def test_rail_survives_a_restart(tmp_path) -> None:
    game, _ann, _bob, a, b = two_player_network()
    store = Store(str(tmp_path / "r.db"))
    store.flush(game)
    store.close()
    again = Store(str(tmp_path / "r.db"))
    game2 = Game("2026-10-22")
    again.load_into(game2)
    assert game2.rail.route(b, 0) == [b, a, 0]
    assert game2.rail.hubs[a].builder == "ann" and game2.rail.next_id == b + 1
    assert game2.rail.log  # clients that join later are sent the hubs
    again.close()


def test_base_hub_is_never_stored(tmp_path) -> None:
    game, _ = make("Ann")
    store = Store(str(tmp_path / "x.db"))
    assert store.snapshot(game)["hubs"] == {}
    store.close()


# -- the robot turns with the track while riding ------------------------- #
def wrap(a: float) -> float:
    return (a + math.pi) % math.tau - math.pi


def test_a_ride_turns_the_robot_gradually_to_face_the_way_it_travels() -> None:
    game, (ann,) = make("Ann")
    ann.place(0, 0)
    a = lay(game, ann, 0, 20)  # straight "down" from the base (heading pi)
    game.tick()
    ann.place(0, 0)
    ann.heading = 0.0  # facing up: the track below is a half turn away
    game.ride("ann", a)
    assert (
        ann.ride is not None and ann.heading == 0.0
    )  # boarding doesn't snap the robot round
    seen = []
    while ann.ride is not None:
        game.tick()
        seen.append(ann.heading)
    steps = [abs(b - a_) for a_, b in zip([0.0, *seen], seen, strict=False)]
    assert (
        max(steps) < 0.45
    )  # never a sudden swing (the old turn could jump 0.3 rad every tick)
    assert steps[0] < steps[len(steps) // 2]  # eases in: slow at first, fastest midway
    assert (
        abs(wrap(ann.heading - math.pi)) < 1e-6
    )  # faces the way it travelled on arrival


def test_a_small_turn_swings_slower_than_a_big_one() -> None:
    def biggest_step(target: tuple[int, int], start_heading: float) -> float:
        game, (ann,) = make("Ann")
        ann.place(0, 0)
        a = lay(game, ann, *target)
        game.tick()
        ann.place(0, 0)
        ann.heading = start_heading
        game.ride("ann", a)
        last, biggest = ann.heading, 0.0
        while ann.ride is not None:
            game.tick()
            biggest, last = max(biggest, abs(ann.heading - last)), ann.heading
        return biggest

    track = (20, 0)  # due "east": heading pi/2
    assert (
        biggest_step(track, math.pi / 2 - 0.2)
        < biggest_step(track, -math.pi / 2 + 0.1) / 4
    )


def test_a_ride_over_several_hubs_faces_the_last_stretch_at_the_end() -> None:
    game, (ann,) = make("Ann")
    ann.place(0, 0)
    a = lay(game, ann, 20, 0)
    ann.place(20, 0)
    game.tick()
    b = lay(game, ann, 20, -20)  # then "up"
    game.tick()
    ann.place(0, 0)
    ann.heading = math.pi
    game.ride("ann", b)
    settle(game, 80)
    assert ann.ride is None and (round(ann.x), round(ann.y)) == (20, -20)
    assert abs(wrap(ann.heading - 0.0)) < 1e-6
    assert a != b
