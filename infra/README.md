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
- `cloud-init.sh.template` — the script that runs on the Droplet's first boot. Installs Docker and gitlab-runner, sets up the `/srv/openemr/` release-dirs layout and `/etc/openemr/` config dir, writes `.env`, and brings up the compose stack. The `bootstrap-do.sh` script renders this template (substituting `__VAR__` placeholders) before uploading.
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

Pushes to `master` trigger `.gitlab-ci.yml`'s `deploy` job, which runs
on a project-specific GitLab runner installed on the Droplet itself.

#### Layout

```
/srv/openemr/
├── repo.git/              bare mirror; runner fetches into it
├── releases/<sha>/        immutable per-release checkout
├── releases/<sha>/        kept for rollback (only N most recent kept)
└── current → releases/<sha>/   atomic symlink, what compose mounts

/etc/openemr/
├── docker-compose.yml     copied from current release on each deploy
├── Caddyfile              same
└── .env                   never overwritten; runner-readable; outside
                           any bind-mount so the container can't chown it
```

The container bind-mounts `/srv/openemr/current` **read-only** at
`/openemr`. The flex entrypoint populates the container's writable
runtime path from that read-only source on every boot. There is no
read-write bind-mount of code anywhere — that's what avoids the
chown war between the apache-uid-1000 process inside the container
and the gitlab-runner-uid-997 process outside.

#### Flow

`runner-bootstrap.sh`:

1. `git fetch` into the bare mirror at `/srv/openemr/repo.git`.
2. If the new SHA already has a release dir, reuse it; otherwise
   `git clone --shared` into `/srv/openemr/releases/<new-sha>/`.
3. Atomically swap `/srv/openemr/current` → new release.
4. `exec` into the new release's `infra/deploy.sh`.

`deploy.sh`:

1. Copy the new release's `docker-compose.yml` and `Caddyfile` to
   `/etc/openemr/`.
2. `docker compose up` (no service arg) to ensure mysql/caddy are
   running, then `docker compose up --force-recreate openemr` to swap
   the openemr container.
3. Run `composer install --no-dev`, `npm install`, `npm run build`,
   and `composer dump-autoload --optimize` inside the container. Each
   step is wrapped in a 5-min retry loop because the flex entrypoint
   copies the source tree into the runtime path concurrently with
   Apache startup; an `exec` arriving mid-copy can see partial state.
4. Poll `/meta/health/readyz` for up to 10 minutes.
5. **If healthy:** prune `/srv/openemr/releases/` to the 2 most recent.
6. **If unhealthy:** roll back the symlink to the previous release,
   recreate the container from that, exit non-zero.

Total deploy time runs ~10–15 minutes — the bulk is `npm install` +
`npm run build` (the gulp/sass pipeline). Both are unconditional on
every deploy, even when the lockfiles haven't changed. The flex image
*also* runs them in its entrypoint, but only when `vendor/` and
`node_modules/` look empty — and on this 2GB Droplet the entrypoint
has been OOM-killed mid-install before, leaving partial state that the
"is it empty?" check then skips on the next boot, freezing the bug.
Running them explicitly from `deploy.sh` makes the deploy
deterministic instead of racing the entrypoint.

Caddy holds in-flight connections to the old container until it exits,
so the switchover window is the few seconds between the new container
becoming healthy and the old one being torn down. Not true blue/green
(a single MariaDB is shared and only one openemr container runs at a
time), but no scheduled downtime and a real rollback path.

#### Rollback

If the deploy job exits non-zero, the symlink has already been rolled
back and the previous release is what's running. To roll back further
(or to roll back a deploy that *did* go healthy but is misbehaving):

```bash
# What's running now?
readlink /srv/openemr/current

# What's available to roll back to?
ls -1t /srv/openemr/releases/

# Roll back.
sudo -u gitlab-runner ln -sfn /srv/openemr/releases/<sha> /srv/openemr/current.new
sudo -u gitlab-runner mv -T /srv/openemr/current.new /srv/openemr/current
sudo -u gitlab-runner bash /srv/openemr/current/infra/deploy.sh
```

#### Why the two-script split

Bash reads a script into memory at invocation. If a single script both
swapped releases *and* ran the deploy, every fix to the deploy logic
would only take effect on the deploy *after* the one that landed it —
because the runner re-invokes the on-disk copy from the *previous*
deploy. The split (`runner-bootstrap.sh` for the symlink swap,
`deploy.sh` for everything else) lets us `exec` into the new release's
`deploy.sh` after the swap, so changes apply immediately.

Consequence: `runner-bootstrap.sh` is effectively immutable — any
change to it only takes effect on the deploy after the one that lands
the change. Keep it small. Put evolving logic in `deploy.sh`.

If you really do need a `runner-bootstrap.sh` change to take effect on
the *current* deploy (e.g., the previous one was buggy and CI is
broken), `scp` the new version onto the Droplet directly so the runner
picks it up before the next pipeline:

```bash
scp infra/runner-bootstrap.sh \
    root@emr.biograph.dev:/srv/openemr/current/infra/runner-bootstrap.sh
ssh root@emr.biograph.dev '
  chown gitlab-runner:gitlab-runner /srv/openemr/current/infra/runner-bootstrap.sh
  chmod +x /srv/openemr/current/infra/runner-bootstrap.sh
'
```

Then push the same change as a normal commit so the next release dir
also has the fixed version.

#### Runner setup

A project-specific GitLab runner lives on the Droplet itself with the
shell executor and tag `openemr-droplet`. The CI job has the matching
`tags:` clause, so jobs on `master` schedule onto this runner and run
`infra/runner-bootstrap.sh` natively — no SSH, no secrets, no nested
Docker.

To install (one-time, on the Droplet, as root). **Order matters: install
the package *before* you `chown` anything to `gitlab-runner`.** The
package install creates the system user, and on a Droplet where the
user doesn't yet exist, `chown gitlab-runner` resolves to the next
free uid (often 1000) — which then gets reassigned when the package
install creates the user properly (often uid 997). Files chown'd in
between are orphaned to a numeric uid with no user, and stay
permission-denied to the runner forever.

```bash
# 1. Install the runner package from GitLab's apt repo. This creates
#    the gitlab-runner system user with its final uid.
curl -L "https://packages.gitlab.com/install/repositories/runner/gitlab-runner/script.deb.sh" | bash
apt-get install -y gitlab-runner

# 2. Let the runner drive docker compose. (Layout under /srv/openemr/
#    and /etc/openemr/ is set up by infra/cloud-init.sh.template.)
usermod -aG docker gitlab-runner

# 3. Register. Get <TOKEN> from GitLab → Settings → CI/CD → Runners →
#    "New project runner" (the glrt-... value is shown once).
gitlab-runner register \
    --non-interactive \
    --url 'https://labs.gauntletai.com/' \
    --token '<TOKEN>' \
    --executor shell \
    --description 'openemr-droplet'

# 4. Pick up the new docker group membership.
systemctl restart gitlab-runner
```

When creating the runner in the UI, set tag `openemr-droplet`, leave
"Lock to current projects" enabled, and leave "Run untagged jobs"
**unchecked** so unrelated jobs can never accidentally run on the
production Droplet.

Verify:

```bash
gitlab-runner verify
sudo -u gitlab-runner docker ps                                 # no permission error
sudo -u gitlab-runner cat /etc/openemr/.env > /dev/null          # readable
sudo -u gitlab-runner git -C /srv/openemr/repo.git rev-parse HEAD
```

#### Manual deploy (fallback)

If the CI job is broken or you need to push a hotfix without going
through GitLab, SSH in and run either script directly:

```bash
# Same as what CI runs — fetch, swap release, recreate container.
ssh root@emr.biograph.dev sudo -u gitlab-runner bash /srv/openemr/current/infra/runner-bootstrap.sh

# Just redeploy the currently-symlinked release without fetching new
# code (useful after `mv`-ing the symlink for a manual rollback).
ssh root@emr.biograph.dev sudo -u gitlab-runner bash /srv/openemr/current/infra/deploy.sh
```

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
| `AGENT_PG_PASSWORD`       | randomly generated if unset   |
