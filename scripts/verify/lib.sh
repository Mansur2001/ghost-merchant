# Shared helpers for the live verification suites. Source this, don't execute it.
#
#   source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
#
# Exists because the Postgres credentials used to be copy-pasted into all nine suites. When the
# database was renamed, every one of them had to be found and edited by hand — so they now read
# the same .env the stack itself boots from, and a rename is a one-line change again.

# Resolve a var from the environment first, then .env, then a default. Environment wins so a
# suite can be pointed at a scratch database without editing anything.
#
# `printenv` rather than bash's ${!key} indirect expansion: the suites all run under bash, but
# this file is worth sourcing by hand while debugging, and zsh — the default shell on macOS —
# fails ${!key} with "bad substitution", which leaves the credentials empty and produces a
# confusing `role "root" does not exist` from psql rather than a clear error.
_env_or() {
  local key="$1" fallback="$2" from_env
  from_env=$(printenv "$key" 2>/dev/null)
  if [ -n "$from_env" ]; then echo "$from_env"; return; fi
  # Trailing CR is stripped so a .env saved on Windows doesn't produce a database name that
  # looks correct in the terminal and fails to connect.
  local from_file
  from_file=$(grep -E "^${key}=" .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r')
  echo "${from_file:-$fallback}"
}

PG_USER=$(_env_or POSTGRES_USER gurikaabe)
PG_DB=$(_env_or POSTGRES_DB gurikaabe)

# One-shot psql against the compose Postgres, unaligned and untuple-headed so the caller gets a
# bare value it can compare against.
psql() {
  docker compose exec -T postgres psql -U "$PG_USER" -d "$PG_DB" -tAc "$1" | tr -d ' '
}
