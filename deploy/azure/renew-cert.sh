#!/usr/bin/env bash
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
domain=${1:?Pass the certificate domain}
if [[ ! "$domain" =~ ^[A-Za-z0-9.-]+$ ]]; then
  printf 'Invalid domain.\n' >&2
  exit 1
fi

certbot renew --cert-name "$domain" --webroot --webroot-path /var/lib/hostelguard/acme --quiet
docker compose --env-file "$root/.env.prod" -f "$root/docker-compose.azure.yml" exec -T nginx nginx -s reload
