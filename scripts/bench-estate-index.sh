#!/usr/bin/env bash
# Benchmark for the estate index at estate size (ADR-0089 §8.4, docs/SCALE.md).
#
# Builds the estate index's two tables in a scratch database, exactly as the migrations leave
# them (0058, and 0068's index unless --without-0068), loads DESIGNS x DEVICES rows with TERMS
# search terms each, and times what main does with them: one design's rebuild (its rows deleted,
# cascading to its terms) and the search shapes `estate::search` sends. Prints each timing from
# PostgreSQL's own EXPLAIN ANALYZE, second run, so the data is in memory.
#
# The terms are synthetic: every row carries `kind:device` (as on main), one of 16 "vendor"
# words, one of 256 "model" words, and the rest are unique to the row. Real rows carry more
# terms (every prefix of name, model and serial, and one per port), so read sizes as a floor.
#
# Usage: scripts/bench-estate-index.sh [--designs 1000] [--devices 1000] [--terms 20] [--without-0068]
# Needs psql and a PostgreSQL superuser: BENCH_DATABASE_URL (default the CI superuser,
# postgres://postgres:postgres@127.0.0.1:5432/postgres). Creates and drops the database
# fathom_estate_bench there; nothing else is touched. 1000 x 1000 x 20 takes a few minutes and
# about 7 GB of disk.
set -euo pipefail

DESIGNS=1000 DEVICES=1000 TERMS=20 WITH_0068=1
while [ $# -gt 0 ]; do
  case "$1" in
    --designs) DESIGNS=$2; shift 2 ;;
    --devices) DEVICES=$2; shift 2 ;;
    --terms) TERMS=$2; shift 2 ;;
    --without-0068) WITH_0068=0; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
URL=${BENCH_DATABASE_URL:-postgres://postgres:postgres@127.0.0.1:5432/postgres}
BENCH_URL="${URL%/*}/fathom_estate_bench"

psql "$URL" -qX -v ON_ERROR_STOP=1 -c "SET client_min_messages = warning" \
  -c "DROP DATABASE IF EXISTS fathom_estate_bench" -c "CREATE DATABASE fathom_estate_bench"
trap 'psql "$URL" -qX -c "DROP DATABASE IF EXISTS fathom_estate_bench" >/dev/null' EXIT

run() { psql "$BENCH_URL" -qXA -v ON_ERROR_STOP=1 "$@"; }

echo "loading $DESIGNS designs x $DEVICES devices x $TERMS terms ..."
run <<SQL
CREATE TABLE estate_rows (
    organisation_id text NOT NULL, design_id text NOT NULL, element_id text NOT NULL,
    kind text NOT NULL, design_version bigint NOT NULL, sealed bytea NOT NULL, nonce bytea NOT NULL,
    PRIMARY KEY (organisation_id, design_id, element_id));
CREATE INDEX estate_rows_kind_idx ON estate_rows (organisation_id, kind, design_id, element_id);
CREATE TABLE estate_terms (
    organisation_id text NOT NULL, term bytea NOT NULL, design_id text NOT NULL, element_id text NOT NULL,
    PRIMARY KEY (organisation_id, term, design_id, element_id),
    FOREIGN KEY (organisation_id, design_id, element_id)
        REFERENCES estate_rows (organisation_id, design_id, element_id) ON DELETE CASCADE);
INSERT INTO estate_rows
SELECT 'ORG', 'D' || lpad(d::text, 25, '0'), 'E' || lpad(e::text, 25, '0'), 'device', 1,
       decode(repeat(md5(d || '-' || e), 10), 'hex'), decode(substr(md5(e::text), 1, 24), 'hex')
FROM generate_series(1, $DESIGNS) d, generate_series(1, $DEVICES) e;
SET session_replication_role = replica;
INSERT INTO estate_terms
SELECT r.organisation_id,
       sha256(convert_to(CASE WHEN t = 0 THEN 'kind:device'
                              WHEN t = 1 THEN 'vendor' || (hashtext(r.element_id) & 15)
                              WHEN t = 2 THEN 'model' || (hashtext(r.design_id || r.element_id) & 255)
                              ELSE r.design_id || r.element_id || '-' || t END, 'UTF8')),
       r.design_id, r.element_id
FROM estate_rows r, generate_series(0, $TERMS - 1) t;
SET session_replication_role = origin;
ANALYZE estate_rows; ANALYZE estate_terms;
SQL
if [ "$WITH_0068" = 1 ]; then
  run -c "CREATE INDEX estate_terms_element_idx ON estate_terms (organisation_id, design_id, element_id)"
fi
run -t -c "SELECT 'size: estate_terms ' || pg_size_pretty(pg_total_relation_size('estate_terms')) || ', estate_rows ' || pg_size_pretty(pg_total_relation_size('estate_rows'))"

time_of() { # label, then SQL on stdin; prints the second run's execution time
  local sql; sql=$(cat)
  run >/dev/null <<<"$sql" || true
  printf '%-58s %s\n' "$1" "$(run <<<"$sql" | grep -o 'Execution Time: .*' | tail -1)"
}
DL=$(run -c "SELECT string_agg('D' || lpad(d::text, 25, '0'), ',') FROM generate_series(1, $DESIGNS) d" -t)
H() { echo "sha256(convert_to('$1', 'UTF8'))"; }
RARE="D$(printf '%025d' 1)E$(printf '%025d' 1)-$((TERMS - 1))"

if [ "$WITH_0068" = 1 ]; then ROWS=$DEVICES; else ROWS=1; fi
time_of "rebuild: delete $ROWS row(s) of one design" <<SQL
BEGIN; EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF) DELETE FROM estate_rows
 WHERE organisation_id = 'ORG' AND design_id = 'D$(printf '%025d' 2)'
   AND element_id <= 'E$(printf '%025d' "$ROWS")'; ROLLBACK;
SQL

NEW="SELECT t.design_id, t.element_id FROM estate_terms t
 WHERE t.organisation_id = 'ORG' AND t.term = \$1 AND t.design_id = ANY(string_to_array('$DL', ','))
   AND (\$2::text IS NULL OR EXISTS (SELECT 1 FROM estate_rows r WHERE r.organisation_id = t.organisation_id
        AND r.design_id = t.design_id AND r.element_id = t.element_id AND r.kind = \$2))
   AND NOT EXISTS (SELECT 1 FROM unnest(\$3::bytea[]) AS o(term) WHERE NOT EXISTS (
        SELECT 1 FROM estate_terms u WHERE u.organisation_id = t.organisation_id AND u.term = o.term
          AND u.design_id = t.design_id AND u.element_id = t.element_id))
 ORDER BY t.design_id, t.element_id LIMIT 100"
OLD() { # terms as SQL array elements
  echo "SELECT design_id, element_id FROM estate_terms
 WHERE organisation_id = 'ORG' AND term = ANY(ARRAY[$1]) AND design_id = ANY(string_to_array('$DL', ','))
 GROUP BY design_id, element_id HAVING count(*) = $2 ORDER BY design_id, element_id LIMIT 100"
}
ex() { echo "EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF) $1"; }

time_of "before: one common word" <<<"$(ex "$(OLD "$(H vendor3)" 1)")"
time_of "before: a rare word with the device filter" <<<"$(ex "$(OLD "$(H "$RARE"), $(H kind:device)" 2)")"
time_of "before: two common words" <<<"$(ex "$(OLD "$(H vendor3), $(H model17)" 2)")"
time_of "now: one common word" <<<"PREPARE s(bytea, text, bytea[]) AS $NEW; $(ex "EXECUTE s($(H vendor3), NULL, ARRAY[]::bytea[])")"
time_of "now: a rare word with the device filter" <<<"PREPARE s(bytea, text, bytea[]) AS $NEW; $(ex "EXECUTE s($(H "$RARE"), 'device', ARRAY[]::bytea[])")"
time_of "now: two common words, the rarer driving" <<<"PREPARE s(bytea, text, bytea[]) AS $NEW; $(ex "EXECUTE s($(H model17), 'device', ARRAY[$(H vendor3)])")"
