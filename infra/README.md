# Infra

Deployment scripts for OpenEMR.

## Current target: DigitalOcean

The active deploy is a single DigitalOcean Droplet hosting the production environment at `emr.biograph.dev`.

### How it works

A single Ubuntu 24.04 Droplet runs three containers via docker-compose:

- **mysql** — MariaDB. Internal network only.
- **openemr** — Upstream `openemr/openemr:flex` image, with this repo bind-mounted into the container at `/var/www/localhost/htdocs/openemr/`. Runs the application code from this repo, not whatever was baked into the upstream image. Internal network only — Caddy fronts it.
- **caddy** — Reverse proxy on the public 80/443. Auto-fetches and renews a Let's Encrypt cert for `${OE_DOMAIN}`. Forwards to OpenEMR's internal port 443 over Docker's private network.

The compose stack lives at `docker/digitalocean/`.

### Layout

- `bootstrap-do.sh` — idempotent script that creates the Droplet (if missing), registers your SSH key with DO, generates random secrets, and uploads a rendered cloud-init script as the Droplet's user-data.
- `cloud-init.sh.template` — the script that runs on the Droplet's first boot. Installs Docker, clones this repo to `/opt/openemr`, writes `.env`, and brings up the compose stack. The `bootstrap-do.sh` script renders this template (substituting `__VAR__` placeholders) before uploading.
- `../docker/digitalocean/docker-compose.yml` — the compose stack.
- `../docker/digitalocean/Caddyfile` — Caddy reverse-proxy config.

### Prerequisites

- DigitalOcean CLI (`doctl`) installed and authenticated (`doctl auth init`).
- `jq` available on the host (`brew install jq` on macOS).
- A GitLab deploy token with `read_repository` scope on the OpenEMR repo. Generate at: GitLab project → Settings → Repository → Deploy tokens.
- An SSH keypair at `~/.ssh/id_ed25519_gauntlet` (override with `SSH_KEY_PATH`).
- DNS control over `biograph.dev` (or whatever apex you set via `OE_DOMAIN`).

### Bootstrapping

```bash
export GITLAB_DEPLOY_TOKEN_NAME='gitlab+deploy-token-N'
export GITLAB_DEPLOY_TOKEN_VALUE='gldt-...'

infra/bootstrap-do.sh
```

The script:

1. Verifies `doctl` is authenticated.
2. Registers your SSH public key with DO if it isn't already.
3. Generates random `OE_PASS` and `MYSQL_ROOT_PASSWORD` (prints once — save them).
4. Renders `cloud-init.sh.template` into a temp file with secrets substituted.
5. Creates the Droplet (idempotent: skipped if `openemr` already exists).
6. Prints the public IPv4 for DNS pointing.

If the Droplet already exists, the script prints its IP and exits — it does not modify, redeploy, or re-trigger cloud-init. To re-bootstrap from scratch, destroy the Droplet first:

```bash
doctl compute droplet delete openemr
```

### After bootstrap

Three things to do once the script returns the Droplet's IP:

1. **Point DNS at the Droplet:**
   ```
   A   emr.biograph.dev   <droplet-ip>
   ```
   Caddy will fetch a Let's Encrypt cert on first request once the A record resolves.

2. **Watch cloud-init progress** (first boot takes ~5–10 minutes for Docker install + repo clone + image pull + container start + OpenEMR auto-setup):
   ```bash
   ssh -i ~/.ssh/id_ed25519_gauntlet root@<droplet-ip> \
     tail -f /var/log/openemr-bootstrap.log
   ```

3. **Visit the site** once the bootstrap log shows `[bootstrap] complete` and DNS has resolved:
   ```
   https://emr.biograph.dev/
   ```
   Log in with `admin` and the `OE_PASS` printed by the bootstrap script.

### Deploying code changes

Push to the tracked branch (`master` by default), then SSH into the Droplet and:

```bash
cd /opt/openemr && git pull
cd docker/digitalocean && docker compose up -d
```

A pull-based auto-deploy poller is a planned follow-up. For now, deploys are manual.

### Environment overrides

| Variable                  | Default                       |
| ------------------------- | ----------------------------- |
| `DROPLET_NAME`            | `openemr`                     |
| `DROPLET_REGION`          | `nyc3`                        |
| `DROPLET_SIZE`            | `s-2vcpu-2gb`                 |
| `DROPLET_IMAGE`           | `ubuntu-24-04-x64`            |
| `SSH_KEY_PATH`            | `~/.ssh/id_ed25519_gauntlet.pub` |
| `GITLAB_HOST`             | `labs.gauntletai.com`         |
| `GITLAB_REPO_PATH`        | `keithmazanec/openemr`        |
| `GITLAB_BRANCH`           | `master`                      |
| `OE_DOMAIN`               | `emr.biograph.dev`            |
| `OE_PASS`                 | randomly generated if unset   |
| `MYSQL_ROOT_PASSWORD`     | randomly generated if unset   |

