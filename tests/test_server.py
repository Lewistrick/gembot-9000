"""End to end over real websockets (FastAPI TestClient): join, play, chat, limits."""

import hashlib
import json
import time
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app.game import MAX_PLAYERS
from app.grid import World
from app.server import app

TOKEN_A = "token-aaaaaaaa"
TOKEN_B = "token-bbbbbbbb"


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(app) as c:
        yield c


def messages(ws, kinds: set[str], timeout: float = 5.0) -> dict[str, list[dict]]:
    """Read batches until every wanted kind has arrived (or time runs out)."""
    got: dict[str, list[dict]] = {k: [] for k in kinds}
    end = time.monotonic() + timeout
    while time.monotonic() < end and not all(got.values()):
        for m in json.loads(ws.receive_text()):
            if m["t"] in got:
                got[m["t"]].append(m)
    return got


def join(client: TestClient, token: str, name: str):
    ws = client.websocket_connect(f"/ws?token={token}")
    sock = ws.__enter__()
    sock.send_text(json.dumps({"action": "join", "name": name}))
    return ws, sock


def test_join_play_and_see_each_other_chat(client: TestClient) -> None:
    ws_a, a = join(client, TOKEN_A, "Ann")
    ws_b, b = join(client, TOKEN_B, "Bob")
    try:
        got = messages(a, {"welcome", "chunk", "tick", "board"})
        assert got["welcome"][0]["you"]["name"] == "Ann"
        assert len(got["chunk"]) >= 1 and got["tick"][0]["t"] == "tick"

        a.send_text(json.dumps({"action": "chat", "text": "anyone need a lift?"}))
        a.send_text(json.dumps({"action": "controls", "up": True}))
        seen = ""
        end = time.monotonic() + 5
        while time.monotonic() < end and not seen:
            for m in json.loads(b.receive_text()):
                if m["t"] == "meta":
                    for who in m["list"]:
                        if who["name"] == "Ann" and who["chat"]:
                            seen = who["chat"]
        assert seen == "anyone need a lift?"

        status = client.get("/api/status").json()
        assert status["online"] == 2 and status["cap"] == MAX_PLAYERS
    finally:
        ws_a.__exit__(None, None, None)
        ws_b.__exit__(None, None, None)


def test_101st_player_is_told_the_server_is_full(client: TestClient) -> None:
    game = app.state.hub.game
    for i in range(MAX_PLAYERS):
        assert game.join(f"fill{i}", f"F{i}") is not None
    ws, sock = join(client, TOKEN_A, "Late")
    try:
        got = messages(sock, {"full"})
        assert got["full"][0]["cap"] == MAX_PLAYERS
    finally:
        ws.__exit__(None, None, None)


def test_bad_token_and_missing_join_are_rejected(client: TestClient) -> None:
    from starlette.websockets import WebSocketDisconnect

    with (
        pytest.raises(WebSocketDisconnect),
        client.websocket_connect("/ws?token=x") as s,
    ):
        s.receive_text()
    with client.websocket_connect(f"/ws?token={TOKEN_A}") as s:
        s.send_text(json.dumps({"action": "controls", "up": True}))
        with pytest.raises(WebSocketDisconnect):
            s.receive_text()


def test_second_tab_replaces_the_first(client: TestClient) -> None:
    ws1, first = join(client, TOKEN_A, "Ann")
    try:
        messages(first, {"welcome"})
        ws2, second = join(client, TOKEN_A, "Ann")
        try:
            assert messages(second, {"welcome"})["welcome"]
            kicked = messages(first, {"kicked"})["kicked"]
            assert kicked[0]["why"] == "replaced"
            assert app.state.hub.game.online_count() == 1
        finally:
            ws2.__exit__(None, None, None)
    finally:
        ws1.__exit__(None, None, None)


class OpenWorld(World):
    """Floor everywhere, no gems: lets the rail tests ignore terrain."""

    def is_floor(self, x: int, y: int) -> bool:
        return True

    def gem_on_floor(self, x: int, y: int) -> int | None:
        return None


def test_rail_build_netmap_and_ride_over_the_wire(client: TestClient) -> None:
    pid = hashlib.sha256(TOKEN_A.encode()).hexdigest()[:10]
    ws, sock = join(client, TOKEN_A, "Ann")
    try:
        messages(sock, {"welcome"})
        game = app.state.hub.game
        game.world = OpenWorld("t")
        me = game.players[pid]
        me.delivered = 500
        me.place(0, 0)

        sock.send_text(
            json.dumps({"action": "build_track", "x": 14, "y": 0, "confirm": False})
        )
        quote = messages(sock, {"quote"})["quote"][-1]
        assert quote["ok"] and quote["cost"] == 39 and quote["new"]

        sock.send_text(
            json.dumps({"action": "build_track", "x": 14, "y": 0, "confirm": True})
        )
        got = messages(sock, {"hubs", "built"})
        assert [1, 14, 0, me.num, 0] in got["hubs"][-1]["list"]

        me.place(14, 0)
        sock.send_text(json.dumps({"action": "netmap"}))
        net = messages(sock, {"net"})["net"][-1]
        assert net["at"] == 1 and {r["id"] for r in net["hubs"]} == {0, 1}

        sock.send_text(json.dumps({"action": "ride", "to": 0}))  # own hub: free
        riding = False
        end = time.monotonic() + 5
        while time.monotonic() < end and not riding:
            for m in json.loads(sock.receive_text()):
                riding = riding or (m["t"] == "tick" and m["r"] == 1)
        assert riding
    finally:
        ws.__exit__(None, None, None)


def test_the_page_names_its_files_with_a_fingerprint(client: TestClient) -> None:
    r = client.get("/")
    assert r.status_code == 200 and r.headers["cache-control"] == "no-cache"
    v = r.text.split('name="asset-v" content="')[1].split('"')[0]
    assert len(v) == 10
    for name in ("style.css", "util.js", "howto.js", "ui.js"):
        assert f"static/{name}?v={v}" in r.text
    assert client.get(f"/static/style.css?v={v}").status_code == 200
