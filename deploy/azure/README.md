# Azure single-VM deployment

This is a cost-conscious **single-machine demo deployment**, not a highly available emergency service. It has not been tested on Azure. A VM, Docker, disk, Redis, network or provider failure can interrupt delivery. Keep an independent emergency contact procedure.

Ubuntu 22.04/24.04 runs nginx, the static warden dashboard, two Node API containers, **one** escalation worker, one leave-overdue worker, PostgreSQL 16 and Redis 7. The worker runs as a single process, not a cluster. Redis stores BullMQ timers with AOF enabled. Migrations gate API and worker startup. Only nginx publishes 80/443; PostgreSQL, Redis and worker ports remain on Docker's private network. No monitoring stack is included; the existing monitoring configuration requires separate adaptation before use.

The Flutter app is a client, not a server. The dashboard uses `https://<domain>/api` for REST and `/socket.io/` for WebSocket; the mobile app uses the same origin without `/api`. TLS terminates at nginx. The private API's HTTPS redirect is disabled so the worker's token-protected HTTP relay works; never publish the API port directly.

## 1. Create the VM

You need an Azure subscription, a public domain you control, an SSH public key, Azure CLI, and a checkout containing these deployment files. On the machine running Azure CLI, from the repository root:

```bash
az login
az account set --subscription '<subscription-id>'
RG=hostelguard-demo
REGION=eastus
VM=hostelguard-vm
MY_IP='<your-public-ip>/32'
az group create --name "$RG" --location "$REGION"
az network nsg create --resource-group "$RG" --name hostelguard-nsg
az network nsg rule create --resource-group "$RG" --nsg-name hostelguard-nsg \
  --name ssh --priority 100 --direction Inbound --access Allow --protocol Tcp \
  --source-address-prefixes "$MY_IP" --destination-port-ranges 22
az network nsg rule create --resource-group "$RG" --nsg-name hostelguard-nsg \
  --name web --priority 110 --direction Inbound --access Allow --protocol Tcp \
  --source-address-prefixes '*' --destination-port-ranges 80 443
az vm create --resource-group "$RG" --name "$VM" --location "$REGION" \
  --image Ubuntu2204 --size Standard_B2s --admin-username azureuser \
  --ssh-key-values "$HOME/.ssh/id_ed25519.pub" --nsg hostelguard-nsg --nsg-rule NONE \
  --public-ip-sku Standard --public-ip-address-allocation static \
  --storage-sku StandardSSD_LRS --os-disk-size-gb 64 \
  --custom-data deploy/azure/cloud-init.yaml
IP=$(az vm show --resource-group "$RG" --name "$VM" --show-details --query publicIps --output tsv)
printf 'Public IP: %s\n' "$IP"
```

Change region, names and SSH-key path as needed. B2s availability and price vary; check quota before creating it. Set an `A` record for your domain to this static IP. Do not allow inbound 5432, 6379, 3001, 4001, 4002, 9090 or 3000 in the NSG. NSGs are essential: Docker-published ports can bypass UFW rules.

**Portal equivalent:** Create a Linux Ubuntu 22.04/24.04 VM, Standard_B2s, SSH authentication, 64 GiB Standard SSD OS disk, static Standard public IP, and an NSG with only TCP 80/443 publicly and TCP 22 restricted to your own IP. Under Advanced, paste `cloud-init.yaml` as custom data before creation. Add the DNS A record after the VM is created.

## 2. Bootstrap and get the source

```bash
ssh azureuser@"$IP"
cloud-init status --wait
sudo docker compose version
sudo ufw status
```

Cloud-init installs Docker Engine, Compose v2, Certbot and UFW from Ubuntu packages and opens SSH, HTTP and HTTPS. Either prefix Docker commands with `sudo`, or allow your administrator user to use Docker:

```bash
sudo usermod -aG docker "$USER"
newgrp docker
```

Membership in the `docker` group is effectively root access; grant it only to trusted administrators. The commands below assume it is enabled. Clone this repository on the VM and check out a branch or commit that **actually contains** the Azure files; uncommitted local changes are not present in a fresh clone.

```bash
git clone https://github.com/saish-vc/digital-hostel-warden.git
cd digital-hostel-warden
read -r -p 'Branch containing the deployment files: ' DEPLOY_BRANCH
git switch "$DEPLOY_BRANCH"
test -f deploy/azure/deploy.sh
```

## 3. Configure secrets and the first TLS certificate

```bash
cp deploy/azure/.env.prod.example .env.prod
chmod 600 .env.prod
nano .env.prod
```

Set `DOMAIN` to your domain, `CORS_ORIGIN` to its `https://` origin, and replace each required password/token with a **different** random value. `openssl rand -hex 32` generates a suitable URL-safe value; do not paste real secrets into Git, logs, screenshots or tickets. Keep `.env.prod` private. PostgreSQL uses the password only when its volume is first initialized; changing the file alone does not rotate an existing database password.

| Variable | Purpose |
| --- | --- |
| `DOMAIN` | Public DNS name, certificate name, dashboard and API origin. |
| `POSTGRES_PASSWORD`, `REDIS_PASSWORD` | Separate long random hex values; no database port is published. |
| `DATABASE_URL`, `DIRECT_DATABASE_URL` | Derived inside Compose from the database service and password; direct URL is used for migrations. |
| `REDIS_URL` | Derived inside Compose from the Redis service and password. |
| `JWT_SECRET` | Long random signing secret. |
| `METRICS_TOKEN` | Required even with monitoring off: API and worker share it for the private escalation-result relay. |
| `CORS_ORIGIN` | Comma-separated allowed browser origins; include `https://<domain>` and any separately hosted Flutter web origin. |
| `SMS_PROVIDER`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `WARDEN_ONCALL_PHONE` | For actual SMS use `twilio`, real credentials and E.164 phone numbers. Without these, escalation cannot send SMS; mock SMS is refused in production. |
| `FIREBASE_SERVICE_ACCOUNT_B64` | Optional private Firebase service-account JSON, base64 on one line. Empty disables server push. |
| `VITE_FIREBASE_*` | Optional public Firebase web identifiers and public VAPID key, baked into the dashboard at build time. Rebuild after changes. |
| `VITE_API_URL` | Derived from `DOMAIN` at build time as `https://<domain>/api`; it is not a secret. |
| `API_BASE_URL` | Flutter build-time define, `https://<domain>`. |

Before the first Compose start, ensure the DNS A record resolves to the VM and inbound TCP 80 works. Certbot needs port 80 free for the standalone initial challenge:

```bash
read -r -p 'Public domain: ' DOMAIN
read -r -p 'Certificate contact email: ' CERT_EMAIL
getent ahostsv4 "$DOMAIN"
sudo certbot certonly --standalone --non-interactive --agree-tos \
  --email "$CERT_EMAIL" -d "$DOMAIN"
sudo install -d -m 0755 /var/lib/hostelguard/acme
```

The domain must match `.env.prod`. Nginx reads `/etc/letsencrypt/live/<domain>/` read-only, including Certbot's archive symlinks.

## 4. Deploy and verify

```bash
bash deploy/azure/deploy.sh
docker compose --env-file .env.prod -f docker-compose.azure.yml ps
bash deploy/azure/smoke-test.sh "$DOMAIN"
```

The script validates the public domain and distinct secrets (at least 32 characters; database passwords must be hex), builds the images, starts the private data services, runs the pinned Prisma migration, and starts the stack. The normal command below also gates startup on successful migrations, but does not perform the script's secret validation:

```bash
docker compose -f docker-compose.azure.yml --env-file .env.prod up -d --build
```

`migrate` should exit 0; long-running services should be healthy. The smoke test checks ready dependencies, dashboard HTML and the TLS WebSocket upgrade, not an authenticated Socket.IO session. Open `https://<domain>` in a browser and verify login, the Live socket indicator, `/leaves` refresh and an SOS from an authorized test account. No default accounts are created. To create first accounts without the known-password demo seed:

```bash
bash deploy/azure/provision-user.sh  # select WARDEN; enter a unique password
bash deploy/azure/provision-user.sh  # select STUDENT; enter a unique password
```

Passwords are read without echo and passed over container stdin, not command-line arguments. This creates accounts without a tenant block relation; the repository's tenant isolation is incomplete, so do not use this for multiple institutions or real student data without further hardening. Do **not** run the demo seed on a public deployment: it creates known credentials.

For an approved live SMS test, configure Twilio, obtain the recipient's consent, create one test SOS, and leave it unacknowledged for 60 seconds. Confirm one provider receipt and the worker log; then test a second alert acknowledged before 60 seconds. Do not claim real provider delivery until checked. The worker's guard and single instance reduce duplication, but provider retries after ambiguous network failures do not prove exactly-once SMS delivery.

## 5. Automatic certificate renewal

With nginx running, Certbot can use its HTTP-01 webroot. Set a root cron job for this checkout and domain, and disable the stock timer that would attempt the initial standalone method while nginx owns port 80:

```bash
sudo systemctl disable --now certbot.timer
printf '17 3 * * * root /bin/bash %s/deploy/azure/renew-cert.sh %s\n' "$(pwd)" "$DOMAIN" | sudo tee /etc/cron.d/hostelguard-certbot >/dev/null
sudo chmod 644 /etc/cron.d/hostelguard-certbot
```

The checkout path and domain must contain no whitespace. The script runs `certbot renew` with the webroot and reloads nginx. Test without issuing a production certificate:

```bash
sudo certbot renew --cert-name "$DOMAIN" --webroot --webroot-path /var/lib/hostelguard/acme --dry-run
sudo bash deploy/azure/renew-cert.sh "$DOMAIN"
```

Watch Certbot logs and certificate expiry; the VM must be running and reachable on port 80 to renew. Ensure no other standalone Certbot scheduler runs concurrently.

## 6. Flutter

Build on a machine with Flutter and Android tooling:

```bash
cd student_app
read -r -p 'Public domain: ' DOMAIN
flutter build apk --release "--dart-define=API_BASE_URL=https://$DOMAIN"
# Optional static web build, served separately over HTTPS:
flutter build web --release "--dart-define=API_BASE_URL=https://$DOMAIN"
```

Add a separately hosted web origin to `CORS_ORIGIN`. Android release signing is currently configured with a debug key; configure a real release key before distribution.

## 7. Back up and restore PostgreSQL

```bash
bash deploy/azure/backup-postgres.sh
# Or provide a new, non-existing output path outside the checkout:
bash deploy/azure/backup-postgres.sh "$HOME/hostelguard-backups/manual.dump"
```

The custom-format dump contains sensitive data. Encrypt it, store an off-VM copy with restricted access, set a retention policy, and test restoration. A backup on the same VM alone does not protect against VM/disk loss.

**Restore is destructive:** it replaces the current database. Obtain an explicit go-ahead, take a fresh backup, and schedule downtime. Stop the application first and supply the intended backup path:

```bash
BACKUP="$HOME/hostelguard-backups/<backup-file>.dump"
docker compose --env-file .env.prod -f docker-compose.azure.yml stop nginx worker leave-worker api
docker compose --env-file .env.prod -f docker-compose.azure.yml exec -T postgres sh -c \
  'dropdb --if-exists --force -U "$POSTGRES_USER" "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
docker compose --env-file .env.prod -f docker-compose.azure.yml exec -T postgres sh -c \
  'pg_restore --exit-on-error --no-owner --no-acl -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < "$BACKUP"
```

PostgreSQL dumps do not restore Redis jobs. A restored database and the existing Redis queue can disagree, producing missed or repeated escalations. Keep workers stopped and reconcile pending alerts/jobs and provider receipts before resuming; no automatic cross-store recovery is provided. After that review, run `bash deploy/azure/deploy.sh` to apply migrations and restart. Do not remove volumes or flush Redis as a shortcut.

## 8. Cost and stopping

Indicative East US Linux pay-as-you-go estimate, 730 hours/month: B2s compute ~$30.37, 64 GiB Standard SSD ~$4.80 plus transactions, and one Standard public IPv4 approximately $3–4. **Budget roughly $38–40/month** before taxes, outbound traffic, DNS, backups, SMS/phone number and any monitoring. Prices, quota, credit eligibility and egress vary by subscription and region; verify the Azure pricing calculator and set a cost budget/alerts. B2s uses burst CPU credits and a 4 GiB RAM ceiling; build and monitor memory accordingly.

When the service is not needed, deallocate the VM from Azure (a guest shutdown alone is not sufficient):

```bash
az vm deallocate --resource-group "$RG" --name "$VM"
# Later:
az vm start --resource-group "$RG" --name "$VM"
```

Compute stops billing when deallocated; the managed disk, reserved static IP, backups and other resources can still incur charges. While stopped, there is **no SOS service or escalation**. Never deallocate during active use. Check certificate renewal and services after starting.

## 9. Limitations

No Azure deployment, real Twilio delivery, FCM delivery, certificate renewal, or external firewall test is claimed until actually performed. This is a single point of failure, with no automatic PostgreSQL/Redis failover, off-site backup, disaster recovery, or tenant isolation. Redis outages pause escalation and cross-instance delivery; AOF `everysec` can lose recent writes after a crash. Treat this as a college demo, not a safety-certified emergency response system.

Pricing references: [Azure Linux VM pricing](https://azure.microsoft.com/en-us/pricing/details/virtual-machines/linux/), [Azure managed disks pricing](https://azure.microsoft.com/en-us/pricing/details/managed-disks/), and [Azure public IP pricing](https://azure.microsoft.com/en-us/pricing/details/ip-addresses/).
