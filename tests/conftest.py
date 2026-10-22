"""Test configuration: keep the server's database in memory, never on disk."""

import os

os.environ["GEMBOT_DB"] = ":memory:"
