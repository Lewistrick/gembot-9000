"""End to end over real websockets (FastAPI TestClient): join, play, chat, limits."""

import json
import time
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app.game import MAX_PLAYERS
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
