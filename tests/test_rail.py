"""The rail network: placement rules, loop-free linking, routes and tolls."""

import itertools

import pytest

from app.grid import World
from app.rail import (
    HUB_COST,
    MAX_TRACK,
    OPTION_LIMIT,
    Hub,
    Network,
    advance,
    line_cells,
    track_cost,
)


class Open(World):
    """A world that is floor everywhere (so rules, not terrain, decide)."""

    def is_floor(self, x: int, y: int) -> bool:
        return True


class Walled(Open):
    """Floor everywhere except a rock wall at x == 20."""

    def is_floor(self, x: int, y: int) -> bool:
        return x != 20


@pytest.fixture
def world() -> Open:
    return Open("t")


def build(net: Network, world: World, src: int, x: int, y: int, who: str = "a") -> int:
    q = net.quote_track(world, src, x, y, 10_000)
    assert q.ok, q.why
    created = net.apply(q, who)
    return created.id if created else (q.out_hub or -1)


def loose(net: Network, x: int, y: int) -> Hub:
    """A hub without a track, as an old save can still contain (none can be built now)."""
    hid = net.next_id
    net.restore([(hid, x, y, "a", None)])
    return net.hubs[hid]


def test_line_cells_include_both_ends_and_stay_connected() -> None:
    assert line_cells(0, 0, 4, 0) == [(0, 0), (1, 0), (2, 0), (3, 0), (4, 0)]
    diag = line_cells(2, 2, -2, -2)
    assert diag[0] == (2, 2) and diag[-1] == (-2, -2) and len(diag) == 5
    shallow = line_cells(0, 0, 7, 3)
    assert shallow[0] == (0, 0) and shallow[-1] == (7, 3)
    for (x1, y1), (x2, y2) in itertools.pairwise(shallow):
        assert max(abs(x2 - x1), abs(y2 - y1)) == 1
    assert line_cells(3, 3, 3, 3) == [(3, 3)]


def test_track_cost_rounds_to_whole_tiles() -> None:
    assert track_cost(0.2) == 1
    assert track_cost(4.4) == 4 and track_cost(4.5) == 5
    assert track_cost(7.07) == 7  # a 5x5 diagonal


def test_hub_options_propose_the_nearest_reachable_hubs_with_their_cost(
    world: Open,
) -> None:
    net = Network()
    near = build(net, world, 0, 14, 0)
    far = build(net, world, near, 14, 30)
    build(net, world, far, 14, 60)
    build(net, world, far, 40, 30)
    quotes, why = net.hub_options(world, 20, 6, 10_000)
    assert why == "" and len(quotes) == OPTION_LIMIT
    assert quotes[0].src == near and quotes[0].cost == HUB_COST + 8
    dists = [q.length for q in quotes]
    assert dists == sorted(dists)
    assert all(q.ok and q.kind == "track" and (q.x, q.y) == (20, 6) for q in quotes)


def test_hub_options_only_offer_what_the_player_can_pay_for(world: Open) -> None:
    net = Network()
    near = build(net, world, 0, 14, 0)
    quotes, _ = net.hub_options(world, 20, 6, HUB_COST + 8)
    assert [q.src for q in quotes] == [near]  # the base is further and too dear
    quotes, why = net.hub_options(world, 20, 6, HUB_COST + 7)
    assert not quotes and "Needs" in why


def test_hub_options_explain_a_refusal(world: Open) -> None:
    net = Network()
    assert "Too close to the base" in net.hub_options(world, 4, 4, 100)[1]
    assert "No hub within" in net.hub_options(world, 150, 0, 100)[1]
    build(net, world, 0, 14, 0)
    assert "Too close to another hub" in net.hub_options(world, 15, 1, 100)[1]
    assert "floor" in net.hub_options(Walled("t"), 20, 15, 100)[1]
    behind_wall = net.hub_options(Walled("t"), 30, 0, 100)
    assert not behind_wall[0] and "Rock" in behind_wall[1]


def test_new_hub_costs_hub_plus_track_and_leads_back(world: Open) -> None:
    net = Network()
    q = net.quote_track(world, 0, 14, 0, 100)
    assert q.ok and q.cost == HUB_COST + 14 and q.kind == "track"
    hub = net.apply(q, "a")
    assert hub is not None and hub.out == 0 and hub.builder == "a"
    assert net.route(hub.id, 0) == [hub.id, 0]


def test_too_long_or_unaffordable_or_through_rock_is_refused() -> None:
    open_world, net = Open("t"), Network()
    assert "Too far" in net.quote_track(open_world, 0, MAX_TRACK + 5, 0, 10_000).why
    assert "Needs 39" in net.quote_track(open_world, 0, 14, 0, 38).why
    rocky = net.quote_track(Walled("t"), 0, 30, 0, 10_000)
    assert not rocky.ok and "Rock" in rocky.why


def test_the_base_never_gets_an_outgoing_track(world: Open) -> None:
    net = Network()
    a = build(net, world, 0, 14, 0)
    assert net.hubs[0].out is None and net.hubs[a].out == 0
    free = loose(net, 0, 20)
    # linking the loose hub to the base makes the loose hub lead to the base
    q = net.quote_track(world, free.id, 0, 0, 100)
    assert q.ok and q.out_hub == free.id and q.out_to == 0
    net.apply(q, "a")
    assert net.hubs[free.id].out == 0 and net.hubs[0].out is None


def test_links_choose_the_free_end_and_refuse_loops(world: Open) -> None:
    net = Network()
    a = build(net, world, 0, 14, 0)  # a -> base
    b = loose(net, 14, 14)
    c = loose(net, 28, 14)
    link = net.quote_track(world, a, 14, 14, 100)  # from a (has out) to loose b
    assert link.ok and link.out_hub == b.id and link.out_to == a
    net.apply(link, "a")
    assert net.route(b.id, 0) == [b.id, a, 0]
    # b and a are connected already: linking them again would be a loop
    again = net.quote_track(world, b.id, 14, 0, 100)
    assert not again.ok and "no loops" in again.why
    # c can hang under b
    assert net.quote_track(world, c.id, 14, 14, 100).out_hub == c.id
    # two hubs that both already lead onward cannot be linked
    d = build(net, world, 0, -14, 0)
    two = net.quote_track(world, d, 14, 0, 100)
    assert not two.ok and "already" in two.why


def test_a_hub_cannot_link_to_its_own_subtree(world: Open) -> None:
    net = Network()
    root = loose(net, 15, 0)
    child = build(net, world, root.id, 30, 0)  # child -> root (root has no out)
    q = net.quote_track(world, root.id, 30, 0, 100)
    assert not q.ok  # root -> child would close a loop
    assert child in net.component(root.id)


def test_routes_run_both_ways_through_the_common_parent(world: Open) -> None:
    net = Network()
    a = build(net, world, 0, 14, 0)
    b = build(net, world, a, 28, 0)
    c = build(net, world, a, 28, 12)
    assert net.route(b, c) == [b, a, c]
    assert net.route(c, b) == [c, a, b]
    assert net.route(b, 0) == [b, a, 0]
    assert net.route(0, b) == [0, a, b]
    stray = loose(net, -20, -20)
    assert net.route(stray.id, b) is None
    assert set(net.component(b)) == {0, a, b, c}


def test_tolls_count_other_players_hubs_only(world: Open) -> None:
    net = Network()
    a = build(net, world, 0, 14, 0, "ann")
    b = build(net, world, a, 28, 0, "bob")
    c = build(net, world, b, 42, 0, "ann")
    route = net.route(c, 0)
    assert route is not None and route == [c, b, a, 0]
    assert net.toll_builders(route, "ann") == ["bob"]  # the base never charges
    assert sorted(net.toll_builders(route, "zed")) == ["ann", "ann", "bob"]
    assert net.toll_builders(route, "bob") == ["ann", "ann"]


def test_nearest_hub_and_base_depot(world: Open) -> None:
    net = Network()
    a = build(net, world, 0, 14, 0)
    on_hub, in_depot = net.nearest(14.3, 0.2), net.nearest(1.5, 1.0)
    assert on_hub is not None and on_hub.id == a
    assert net.nearest(15.5, 0) is None
    assert in_depot is not None and in_depot.id == 0  # anywhere in the depot
    assert net.nearest(5, 5) is None


def test_advance_follows_a_polyline() -> None:
    pts = [(10.0, 0.0), (10.0, 10.0)]
    x, y, i = advance(0.0, 0.0, pts, 0, 4.0)
    assert (round(x, 6), round(y, 6), i) == (4.0, 0.0, 0)
    x, y, i = advance(x, y, pts, i, 9.0)  # 6 to the corner, 3 up the next leg
    assert (round(x, 6), round(y, 6), i) == (10.0, 3.0, 1)
    x, y, i = advance(x, y, pts, i, 50.0)
    assert (x, y, i) == (10.0, 10.0, 2)


def test_restore_rebuilds_hubs_and_ids() -> None:
    net = Network()
    net.restore([(1, 14, 0, "a", 0), (3, 28, 0, "b", 1)])
    assert net.route(3, 0) == [3, 1, 0]
    assert net.next_id == 4
