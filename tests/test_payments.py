"""Payments are cargo-first; the player is asked before banked score is touched."""

import random

from app.game import Game
from app.grid import World
from app.player import Player
from app.rail import HUB_COST


class Open(World):
    """Floor everywhere and no gems, so only the payment rules matter."""

    def is_floor(self, x: int, y: int) -> bool:
        return True

    def gem_on_floor(self, x: int, y: int) -> int | None:
        return None


def make(cargo: int, score: int) -> tuple[Game, Player]:
    game = Game("2026-10-22", rng=random.Random(1))
    game.world = Open("t")
    p = game.join("ann", "Ann")
    assert p is not None
    p.delivered, p.cargo = score, cargo
    p.place(20, 0)  # outside the base, 20 tiles from the base hub
    return game, p


def notes(p: Player, kind: str) -> list[dict]:
    return [n for n in p.notices if n["t"] == kind]


COST = HUB_COST + 20  # the hub plus a 20-tile track to the base


def test_cargo_pays_first_and_score_is_untouched() -> None:
    game, p = make(cargo=100, score=500)
    game.build_hub("ann", 0, 20, 0)
    assert len(game.rail.hubs) == 2 and not notes(p, "pay")  # no question asked
    assert p.cargo == 100 - COST and p.score == 500


def test_a_shortfall_is_asked_for_not_just_taken() -> None:
    game, p = make(cargo=30, score=500)
    game.build_hub("ann", 0, 20, 0)
    ask = notes(p, "pay")[0]
    assert (ask["cost"], ask["cargo"], ask["score"]) == (COST, 30, COST - 30)
    assert ask["retry"] == {"action": "build_hub", "to": 0, "x": 20, "y": 0}
    assert len(game.rail.hubs) == 1 and p.cargo == 30 and p.score == 500  # nothing yet


def test_agreeing_spends_all_cargo_then_the_missing_part_of_score() -> None:
    game, p = make(cargo=30, score=500)
    game.build_hub("ann", 0, 20, 0, pay_score=True)
    assert len(game.rail.hubs) == 2
    assert p.cargo == 0 and p.score == 500 - (COST - 30)


def test_cargo_and_score_together_must_cover_it() -> None:
    game, p = make(cargo=10, score=10)  # 20 in total, 45 needed
    game.build_hub("ann", 0, 20, 0, pay_score=True)
    assert len(game.rail.hubs) == 1 and not notes(p, "pay")
    assert "Needs 45" in notes(p, "rail")[-1]["msg"]
    assert p.cargo == 10 and p.score == 10


def test_a_hub_option_says_how_much_would_come_from_score() -> None:
    game, p = make(cargo=30, score=500)
    game.hub_options("ann")
    opt = notes(p, "hubopts")[0]["opts"][0]
    assert opt["cost"] == COST and opt["short"] == COST - 30
    p.cargo = 1000
    p.notices.clear()
    game.hub_options("ann")
    assert notes(p, "hubopts")[0]["opts"][0]["short"] == 0


def test_options_appear_when_cargo_plus_score_can_pay_even_with_no_score() -> None:
    game, p = make(cargo=COST, score=0)
    game.hub_options("ann")
    assert notes(p, "hubopts")
    game.build_hub("ann", 0, 20, 0)
    assert len(game.rail.hubs) == 2 and p.cargo == 0


def _ride_setup(cargo: int, score: int) -> tuple[Game, Player, Player, int]:
    """Bob built a hub at (30, 0); Ann stands on it and wants to ride to the base."""
    game, ann = make(cargo=0, score=1000)
    bob = game.join("bob", "Bob")
    assert bob is not None
    bob.delivered = 1000
    bob.place(20, 0)
    game.build_hub("bob", 0, 20, 0, pay_score=True)
    hub = max(game.rail.hubs)
    ann.cargo, ann.delivered = cargo, score
    ann.place(20, 0)
    return game, ann, bob, hub


def test_tolls_are_paid_from_cargo_first_to_the_builder() -> None:
    game, ann, bob, _hub = _ride_setup(cargo=5, score=100)
    income = bob.toll_income
    game.ride("ann", 0)
    assert ann.ride is not None and ann.cargo == 4 and ann.score == 100
    assert bob.toll_income == income + 1 and not notes(ann, "pay")


def test_a_toll_shortfall_is_asked_for_then_paid_from_score() -> None:
    game, ann, bob, _hub = _ride_setup(cargo=0, score=100)
    income = bob.toll_income
    game.ride("ann", 0)
    assert ann.ride is None and notes(ann, "pay")[0]["score"] == 1
    game.ride("ann", 0, pay_score=True)
    assert ann.ride is not None and ann.score == 99 and bob.toll_income == income + 1


def test_with_neither_cargo_nor_score_you_cannot_ride_a_foreign_hub() -> None:
    game, ann, _bob, _hub = _ride_setup(cargo=0, score=0)
    game.ride("ann", 0, pay_score=True)
    assert ann.ride is None and "Not enough" in notes(ann, "rail")[-1]["msg"]


def test_a_shipment_still_pays_its_tolls_out_of_itself() -> None:
    game, ann, _bob, _hub = _ride_setup(cargo=50, score=0)
    game.send_cargo("ann")
    assert game.carts[0].value == 49 and not notes(ann, "pay")
