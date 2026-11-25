#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
root=$(cd -- "$script_dir/../.." && pwd)

if [[ ! -t 0 ]]; then
  printf 'Run this script in an interactive terminal.\n' >&2
  exit 1
fi

read -r -p 'Role (WARDEN or STUDENT): ' role
if [[ "$role" != WARDEN && "$role" != STUDENT ]]; then
  printf 'Role must be WARDEN or STUDENT.\n' >&2
  exit 1
fi
read -r -p 'Name: ' name
read -r -p 'Email: ' email
block='' room='' contact=''
if [[ "$role" == WARDEN ]]; then
  read -r -p 'Hostel block: ' block
else
  read -r -p 'Room number: ' room
  read -r -p 'Emergency contact: ' contact
fi
if [[ -z "$name" || -z "$email" || ( "$role" == WARDEN && -z "$block" ) || ( "$role" == STUDENT && ( -z "$room" || -z "$contact" ) ) ]]; then
  printf 'All fields are required.\n' >&2
  exit 1
fi
read -r -s -p 'Password (14–72 bytes): ' password
printf '\n'
read -r -s -p 'Confirm password: ' confirmation
printf '\n'
bytes=$(LC_ALL=C printf '%s' "$password" | wc -c)
if [[ "$password" != "$confirmation" || "$bytes" -lt 14 || "$bytes" -gt 72 ]]; then
  printf 'Passwords must match and contain 14–72 bytes.\n' >&2
  exit 1
fi
unset confirmation

printf '%s' "$password" | docker compose --env-file "$root/.env.prod" -f "$root/docker-compose.azure.yml" exec -T \
  -e "BOOTSTRAP_ROLE=$role" -e "BOOTSTRAP_NAME=$name" -e "BOOTSTRAP_EMAIL=$email" \
  -e "BOOTSTRAP_BLOCK=$block" -e "BOOTSTRAP_ROOM=$room" -e "BOOTSTRAP_CONTACT=$contact" \
  api node -e "$(<"$script_dir/provision-user.cjs")"
unset password
