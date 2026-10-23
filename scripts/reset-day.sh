#!/usr/bin/env bash
# Reset one day's board: deletes that day's players (scores, cargo), mined gems,
# drilled tiles and hubs, so everyone starts again on a fresh map. Past winners
# are kept. The database is backed up first.
#
#   scripts/reset-day.sh              reset today (asks first)
#   scripts/reset-day.sh -y           ...without asking
#   scripts/reset-day.sh -n           only show what would be deleted
#   scripts/reset-day.sh -d 2026-10-23
#
# The game keeps its state in memory and snapshots it to the database, so the
# container is stopped while the database is edited, then started again (also if
# something fails). Connected players drop for a few seconds and reconnect.
# Backups go to $GEMBOT_BACKUP_DIR (default ~/gembot-backups).
set -euo pipefail
cd "$(dirname "$0")/.."

SERVICE=gembot
DB=data/gembot.db
BACKUP_ROOT=${GEMBOT_BACKUP_DIR:-$HOME/gembot-backups}
TABLES="players mined drilled hubs"
DAY="" YES=0 DRY=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        -y | --yes) YES=1 ;;
        -n | --dry-run) DRY=1 ;;
        -d | --day) DAY="${2:?--day needs a date like 2026-10-23}"; shift ;;
        -h | --help) sed -n '2,/^set /p' "$0" | sed '$d;s/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
    esac
    shift
done

if [[ -z $DAY ]]; then  # the game's own idea of today (honours GEMBOT_TZ)
    DAY=$(docker compose run --rm --no-deps -T "$SERVICE" \
        uv run --no-dev python -c 'from app.game import today; print(today())' | tail -n 1 | tr -d '\r')
fi
[[ $DAY =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "bad day: '$DAY'" >&2; exit 2; }
[[ -f $DB ]] || { echo "no database at $DB" >&2; exit 1; }

echo "Day $DAY currently holds:"
python3 - "$DB" "$DAY" $TABLES <<'EOF'
import sqlite3, sys
db, day, *tables = sys.argv[1:]
c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
for t in tables:
    print(f"  {t:8} {c.execute(f'select count(*) from {t} where day=?', (day,)).fetchone()[0]}")
for name, score in c.execute(
    "select name, delivered + toll_income - spent from players where day=? order by 2 desc", (day,)
):
    print(f"  player {name}: {score}")
EOF

(( DRY )) && { echo "Dry run: nothing changed."; exit 0; }
if (( ! YES )); then
    read -r -p "Delete all of that and restart the game? [y/N] " answer
    [[ $answer == [yY]* ]] || { echo "Cancelled."; exit 1; }
fi

docker compose stop "$SERVICE"
trap 'docker compose up -d "$SERVICE"' EXIT  # always bring the game back

BACKUP="$BACKUP_ROOT/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP"
cp -a "$DB"* "$BACKUP"/
echo "Backup: $BACKUP"

docker compose run --rm --no-deps -T -e DAY="$DAY" -e TABLES="$TABLES" "$SERVICE" python -c '
import os, sqlite3
c = sqlite3.connect("data/gembot.db")
for t in os.environ["TABLES"].split():
    n = c.execute(f"delete from {t} where day=?", (os.environ["DAY"],)).rowcount
    print(f"  {t}: deleted {n}")
c.commit()
'
echo "Reset $DAY. Starting the game again."
