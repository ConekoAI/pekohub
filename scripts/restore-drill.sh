#!/usr/bin/env bash
# Restore a production backup into an empty database and print what's in it.
# DEPLOYMENT.md § "Backups and the restore drill".
#
# Usage:
#   scripts/restore-drill.sh <backup.dump.age | backup.dump> <target database URL> [age identity file]
#
# The target must be an empty scratch database (a fresh Neon branch, or
# `docker run -e POSTGRES_PASSWORD=x -p 5440:5432 postgres:18-alpine`); the
# script refuses one that already has tables. An `.age` backup needs the
# identity (private key) file. Needs Docker; PG_MAJOR (default 18) picks
# the pg_restore version, which must be at least the dump's (PG_IMAGE
# overrides the whole image name).
#
# Prints the time the restore took and every table's row count; compare
# them with production (DEPLOYMENT.md lists the query).

set -euo pipefail

backup=${1:?usage: restore-drill.sh <backup> <target database URL> [age identity file]}
target=${2:?usage: restore-drill.sh <backup> <target database URL> [age identity file]}
identity=${3:-}
image=${PG_IMAGE:-postgres:${PG_MAJOR:-18}-alpine}

# Inside the container `localhost` is the container; reach the host instead.
target_in_docker=$(printf '%s' "$target" | sed -E 's#@(localhost|127\.0\.0\.1)([:/])#@host.docker.internal\2#')

psql_target() {
  docker run --rm -i --add-host=host.docker.internal:host-gateway -e TARGET="$target_in_docker" "$image" \
    sh -c 'psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 --dbname="$TARGET" "$@"' psql "$@"
}

tables=$(psql_target -tAc "select count(*) from information_schema.tables where table_schema = 'public'")
if [ "$tables" != "0" ]; then
  echo "The target already has $tables tables; restore into an empty database." >&2
  exit 1
fi

decrypt() {
  case "$backup" in
    *.age)
      [ -n "$identity" ] || { echo "An .age backup needs the identity file (third argument)." >&2; exit 1; }
      age --decrypt --identity "$identity" "$backup"
      ;;
    *) cat "$backup" ;;
  esac
}

start=$(date +%s)
decrypt | docker run --rm -i --add-host=host.docker.internal:host-gateway -e TARGET="$target_in_docker" "$image" \
  sh -c 'pg_restore --no-owner --no-privileges --exit-on-error --dbname="$TARGET"'
echo "Restored in $(( $(date +%s) - start )) s."

echo "Row counts:"
psql_target <<'SQL'
\pset tuples_only on
\pset format unaligned
\pset fieldsep '  '
select format('select %L, count(*) from %I', table_name, table_name)
from information_schema.tables
where table_schema = 'public'
order by table_name
\gexec
SQL
psql_target -tAc "select 'migrations applied: ' || count(*) from drizzle.__drizzle_migrations"
