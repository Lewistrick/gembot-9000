"""A real server on a fixed day, for the How to Play screenshots (scripts/howto_shots.cjs).

The terrain is a pure function of the date, so a fixed day keeps the screenshots
reproducible. Run with PORT and GEMBOT_DB set; stop it with Ctrl-C.
"""

import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import uvicorn

from app import server

DAY = "2026-10-22"  # one of the open days: plenty of floor and gems around the base


def make_hub() -> server.Hub:
    return real_hub(day_fn=lambda: DAY)


real_hub = server.Hub
server.Hub = make_hub  # ty: ignore[invalid-assignment]


async def main() -> None:
    config = uvicorn.Config(
        server.app, port=int(os.environ["PORT"]), log_level="warning"
    )
    await uvicorn.Server(config).serve()


asyncio.run(main())
