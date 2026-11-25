#!/usr/bin/env bash
set -euo pipefail
umask 077

if (( $# > 1 )); then
  printf 'Usage: %s [output.dump]\n' "$0" >&2
  exit 2
fi
repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd -- "$repo_root"
if [[ ! -f .env.prod || ! -f docker-compose.azure.yml ]]; then
  printf '%s\n' 'Requires repo-root .env.prod and docker-compose.azure.yml.' >&2
  exit 1
fi

# Default to a private directory outside the checkout. Explicit destinations
# must have an existing parent; never overwrite an existing backup.
if (( $# == 0 )); then
  backup_dir=${HOME:?HOME must be set}/hostelguard-backups
  case "$backup_dir/" in
    "$repo_root/"*) printf '%s\n' 'Default backup directory must be outside the repository; supply an output path.' >&2; exit 1 ;;
  esac
  mkdir -p -- "$backup_dir"
  backup_dir=$(cd -- "$backup_dir" && pwd -P)
  case "$backup_dir/" in
    "$repo_root/"*) printf '%s\n' 'Default backup directory resolves inside the repository; supply an output path.' >&2; exit 1 ;;
  esac
  output=$backup_dir/hostelguard-$(date -u +%Y%m%dT%H%M%SZ)-$$.dump
else
  output=$1
fi
# Use the database's own configured user and database without parsing or
# executing the host env file as shell code. stdout contains only the dump.
if ! (set -o noclobber; docker compose --env-file .env.prod -f docker-compose.azure.yml \
  exec -T postgres sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$output"); then
  printf 'Backup failed; an incomplete file may remain at %s\n' "$output" >&2
  exit 1
fi
printf 'Backup written to %s\n' "$output"
