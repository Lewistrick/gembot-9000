"""Protocol layer: what each client is sent, and how its input is applied."""

import base64
import math
import random

import numpy as np

from app.connection import VIEW_MAX, VIEW_MIN, Connection, hue_for
from app.game import Game
from app.grid import BASE_RADIUS, CHUNK


def make() -> tuple[Game, Connection, Connection]:
    game = Game("2026-10-22", rng=random.Random(3))
    a, b = game.join("a", "Ann"), game.join("b", "Bob")
    assert a and b
    a.place(0, 0)
    b.place(3, 3)
    return game, Connection(game, a), Connection(game, b)


def of(frame: list[dict], kind: str) -> list[dict]:
    return [m for m in frame if m["t"] == kind]


def test_welcome_describes_the_world() -> None:
    _, ca, _ = make()
    w = ca.welcome()
    assert w["t"] == "welcome" and w["day"] == "2026-10-22"
    assert w["chunk"] == CHUNK and w["base"] == BASE_RADIUS and w["cap"] == 100
    assert w["you"]["id"] == "a" and w["you"]["hue"] == hue_for(1)


def test_first_frame_sends_chunks_nearest_first_within_budget() -> None:
    _, ca, _ = make()
    budget = [5]
    reliable, tick = ca.frame(budget)
    chunks = of(reliable, "chunk")
    assert len(chunks) == 5 and budget[0] == 0
    assert (chunks[0]["cx"], chunks[0]["cy"]) in {(-1, -1), (0, -1), (-1, 0), (0, 0)}
    assert tick is not None and tick["x"] == 0 and tick["y"] == 0
    # the next frame carries on with different chunks, never repeats
    seen = {(c["cx"], c["cy"]) for c in chunks}
    more = of(ca.frame([100])[0], "chunk")
    assert not seen & {(c["cx"], c["cy"]) for c in more}


def test_chunk_message_round_trips_terrain_and_gems() -> None:
    game, ca, _ = make()
    msgs = of(ca.frame([100])[0], "chunk")
    m = next(c for c in msgs if (c["cx"], c["cy"]) == (0, 0))
    bits = np.unpackbits(np.frombuffer(base64.b64decode(m["bits"]), dtype=np.uint8))
    grid = bits[: CHUNK * CHUNK].reshape(CHUNK, CHUNK).astype(bool)
    assert (grid == game.world.chunk(0, 0).floor).all()
    assert {(x, y): v for x, y, v in m["gems"]} == game.world.chunk_gems(0, 0)


def test_mined_gems_reach_every_client_and_new_chunks_include_them() -> None:
    game, ca, cb = make()
    ca.frame([100])
    cb.frame([100])
    x, y = 150, 150
    game.mined.add((x, y))
    game.mined_log.append((x, y))
    assert of(ca.frame([0])[0], "mined") == [{"t": "mined", "c": [[x, y]]}]
    assert of(cb.frame([0])[0], "mined") == [{"t": "mined", "c": [[x, y]]}]
    assert not of(ca.frame([0])[0], "mined")  # delivered once only
    # a client that loads the chunk later is told what is already mined there
    gem = next(iter(game.world.chunk_gems(0, 0)))
    game.mined.add(gem)
    late = Connection(game, game.players["a"])
    m = next(
        c for c in of(late.frame([100])[0], "chunk") if (c["cx"], c["cy"]) == (0, 0)
    )
    assert list(gem) in m["mined"]


def test_meta_is_sent_once_then_again_only_when_chat_changes() -> None:
    game, ca, _ = make()
    first = of(ca.frame([0])[0], "meta")
    assert {m["name"] for m in first[0]["list"]} == {"Ann", "Bob"}
    assert not of(ca.frame([0])[0], "meta")
    game.set_chat("b", "hello")
    again = of(ca.frame([0])[0], "meta")
    assert again[0]["list"] == [
        {
            "n": 2,
            "id": "b",
            "name": "Bob",
            "chat": "hello",
            "hue": hue_for(2),
            "crown": False,
        }
    ]


def test_others_are_sent_at_10hz_and_only_when_near() -> None:
    game, ca, _ = make()
    rows = []
    for _ in range(2):
        game.tick_count += 1
        rows.append(ca.frame([0])[1].get("o"))
    assert rows.count(None) == 1  # one odd tick without the list
    on_even = next(r for r in rows if r is not None)
    assert [r[0] for r in on_even] == [2]
    game.players["b"].place(500, 500)
    game.tick_count = 2
    assert ca.frame([0])[1]["o"] == []


def test_far_chunks_are_dropped_and_can_be_resent() -> None:
    game, ca, _ = make()
    ca.frame([100])
    game.players["a"].place(1000, 1000)
    game.tick_count = 20
    reliable, _ = ca.frame([0])
    drops = of(reliable, "drop")
    assert drops and [0, 0] in drops[0]["c"]
    assert (0, 0) not in ca.sent


def test_resize_is_clamped_and_garbage_ignored() -> None:
    _, ca, _ = make()
    ca.handle({"action": "resize", "cols": 9999, "rows": 1})
    assert (ca.cols, ca.rows) == (VIEW_MAX | 1, VIEW_MIN | 1)
    ca.handle({"action": "resize", "cols": "x"})
    ca.handle({"action": "nonsense"})
    ca.handle({})
    assert (ca.cols, ca.rows) == (VIEW_MAX | 1, VIEW_MIN | 1)


def test_controls_chat_and_flip_reach_the_game() -> None:
    game, ca, _ = make()
    ca.handle({"action": "controls", "up": True, "left": True, "down": "yes"})
    p = game.players["a"]
    assert (p.up, p.left, p.down, p.right) == (
        True,
        True,
        False,
        False,
    )  # only real booleans
    ca.handle({"action": "chat", "text": "hi there"})
    assert p.chat == "hi there"
    ca.handle({"action": "flip"})
    assert p.flip_remaining == math.pi


def test_notices_are_delivered_once() -> None:
    game, ca, _ = make()
    game.players["a"].notices.append({"t": "gain", "v": 5, "mega": False})
    assert of(ca.frame([0])[0], "gain") == [{"t": "gain", "v": 5, "mega": False}]
    assert not of(ca.frame([0])[0], "gain")


def test_board_is_sent_once_per_epoch() -> None:
    game, ca, _ = make()
    game.tick()
    assert len(of(ca.frame([0])[0], "board")) == 1
    assert not of(ca.frame([0])[0], "board")
    game.tick_count += 40
    b = of(ca.frame([0])[0], "board")[0]
    assert b["online"] == 2 and "pal" in b
