#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd -- "$repo_root"

if [[ ! -f .env.prod || ! -f docker-compose.azure.yml ]]; then
  printf '%s\n' 'Requires repo-root .env.prod and docker-compose.azure.yml.' >&2
  exit 1
fi

# Refuse configurations that do not gate API and worker startup on migrations.
docker compose --env-file .env.prod -f docker-compose.azure.yml config --format json |
  python3 -c '
import json, re, sys
try:
    services = json.load(sys.stdin)["services"]
    domain = services["nginx"]["environment"]["DOMAIN"]
    if not re.fullmatch(r"(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}", domain):
        raise ValueError("DOMAIN must be a public DNS name")
    api_env = services["api"]["environment"]
    secrets = {
        "POSTGRES_PASSWORD": services["postgres"]["environment"]["POSTGRES_PASSWORD"],
        "REDIS_PASSWORD": services["redis"]["environment"]["REDIS_PASSWORD"],
        "JWT_SECRET": api_env["JWT_SECRET"],
        "METRICS_TOKEN": api_env["METRICS_TOKEN"],
    }
    for name, value in secrets.items():
        if not isinstance(value, str) or len(value) < 32 or "replace-with" in value.lower():
            raise ValueError(name + " must be a non-placeholder value of at least 32 characters")
    for name in ("POSTGRES_PASSWORD", "REDIS_PASSWORD"):
        if not re.fullmatch(r"[0-9a-fA-F]+", secrets[name]):
            raise ValueError(name + " must be hexadecimal for the connection URL")
    if len(set(secrets.values())) != len(secrets):
        raise ValueError("Use a different value for each password and token")
    if "migrate" not in services or services["migrate"].get("profiles"):
        raise ValueError("an unprofiled migrate service is required")
    for name in ("api", "worker", "leave-worker"):
        service = services[name]
        dependency = service.get("depends_on", {}).get("migrate", {})
        if service.get("profiles") or not isinstance(dependency, dict) or dependency.get("condition") != "service_completed_successfully" or dependency.get("required", True) is not True:
            raise ValueError(name + " must require successful migrate completion without profiles")
except (KeyError, TypeError, ValueError) as exc:
    sys.exit("Invalid Compose deployment configuration: " + str(exc))
'
# Obtain the first certificate before starting nginx, e.g. with certbot
# certonly --standalone, after DNS points here and port 80 is reachable.
docker compose --env-file .env.prod -f docker-compose.azure.yml build
docker compose --env-file .env.prod -f docker-compose.azure.yml up -d --wait postgres redis
docker compose --env-file .env.prod -f docker-compose.azure.yml run --rm migrate
docker compose --env-file .env.prod -f docker-compose.azure.yml up -d --wait
