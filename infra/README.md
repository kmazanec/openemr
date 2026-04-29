# Infra

Deployment scripts for the Railway-hosted OpenEMR project.

## How deploys work

The OpenEMR service runs `kmazanec/openemr-railway:flex` — a thin overlay built from `docker/railway/Dockerfile` that adds Railway-specific Apache configuration on top of the upstream `openemr/openemr:flex` image. The flex base clones the OpenEMR source from our GitLab server at container startup using `FLEX_REPOSITORY` env vars. There is no Railway-side build and no repository upload — Railway pulls the published image from Docker Hub and the image clones our code at boot.

To deploy a new version of OpenEMR: push to the tracked branch (`master` by default), then restart the Railway service. The container reclones, runs composer/npm install, and serves the new code.

## Building the deploy image

The deploy image is built locally and pushed to Docker Hub. It only needs to be rebuilt when `docker/railway/Dockerfile` or `docker/railway/zz-railway.conf` changes.

```bash
docker login -u kmazanec
docker buildx build --platform linux/amd64 -t kmazanec/openemr-railway:flex --push docker/railway/
```

Note `--platform linux/amd64`: Railway runs amd64. If you build natively on Apple Silicon without specifying the platform, the resulting image will be arm64 and Railway will refuse to run it.

After pushing, restart the Railway services to pick up the new image:

```bash
railway service redeploy --service openemr-dev --environment dev -y
railway service redeploy --service openemr-production --environment production -y
```

## Layout

- `bootstrap-env.sh` — idempotent script that creates a Railway environment and provisions everything that can't be expressed in `railway.toml` (the MySQL plugin, the persistent volume, environment variables including the FLEX_REPOSITORY clone URL, the public domain).
- The companion `railway.toml` lives at the repo root and configures the openemr service's deploy contract (healthcheck, restart policy, required volume mount path).

## Prerequisites

- Railway CLI installed and authenticated (`railway login`).
- The repo is linked to a Railway project (`railway link` from the repo root).
- `jq` available on the host (`brew install jq` on macOS).
- A GitLab deploy token with `read_repository` scope on the OpenEMR repo. Generate one at: GitLab project → Settings → Repository → Deploy tokens. Save the username and the token; you'll pass them to the script as env vars (see below).

## Bootstrapping an environment

```bash
export GITLAB_DEPLOY_TOKEN_NAME='gitlab+deploy-token-N'
export GITLAB_DEPLOY_TOKEN_VALUE='gldt-...'

infra/bootstrap-env.sh dev
infra/bootstrap-env.sh production
```

Optional env vars (defaults shown):

```bash
GITLAB_HOST=labs.gauntletai.com
GITLAB_REPO_PATH=keithmazanec/openemr
GITLAB_BRANCH=master              # branch the openemr service tracks
```

To track different branches per environment, set `GITLAB_BRANCH` differently for each invocation:

```bash
GITLAB_BRANCH=dev    infra/bootstrap-env.sh dev
GITLAB_BRANCH=master infra/bootstrap-env.sh production
```

The script is idempotent: re-running it against an existing environment converges it to the desired state. If you change the desired state (e.g., add an env var to the script), re-run it — only the diff is applied.

**Caveat — changing the service's source image requires recreation.** Railway's CLI cannot change a service's source image after creation. If you need to switch the OpenEMR service from one image to another, delete the service first (`railway service delete --service openemr-<env> --environment <env>`), then re-run this script.

### Service naming

Railway requires service names to be unique within a project, even across environments. The script handles this by:

- Suffixing the OpenEMR service with the environment name: `openemr-dev`, `openemr-production`.
- Letting Railway's managed-MySQL plugin pick its own name (typically `MySQL` for the first environment, `MySQL-XXXX` for subsequent ones). The script discovers the actual name and uses it for variable references.

You'll see different service names in each environment — that's by design. Variable references inside the OpenEMR service use the discovered MySQL name automatically.

### Volume cap

Railway's free/hobby plans cap volumes at 3 per project. With two environments (each using one volume for MySQL plus one for OpenEMR's `sites/`), we are at 4 volumes total — above the free cap. If you hit `Failed to add MySQL: You can only have N volumes per project`, either upgrade the plan or check for orphan volumes left from deleted services:

```bash
railway volume list --json | jq -r '.volumes[] | select(.serviceName == null)'
railway volume delete --volume <id> --yes
```

### Admin password

The OpenEMR `admin` user's password is set via the `OE_PASS` environment variable. If unset when you run the script, a random 32-character password is generated and printed once. **Save it immediately to your password manager** — Railway stores it in the env var pool but you should not rely on that as primary password storage.

To set the password explicitly:

```bash
OE_PASS='<your-strong-password>' infra/bootstrap-env.sh dev
```

## What the script does (and doesn't)

| Concern                                | Source of truth         |
| -------------------------------------- | ----------------------- |
| Build (Dockerfile path, watch globs)   | `../railway.toml`       |
| Deploy (healthcheck, restart policy)   | `../railway.toml`       |
| Volume mount path requirement          | `../railway.toml`       |
| Environment exists                     | `bootstrap-env.sh`      |
| MySQL plugin provisioned               | `bootstrap-env.sh`      |
| Volume allocated and attached          | `bootstrap-env.sh`      |
| Environment variables set on services  | `bootstrap-env.sh`      |
| Public domain generated                | `bootstrap-env.sh`      |

The split exists because Railway's per-service `railway.toml` cannot create environments, provision plugins, allocate volumes, or set variables — those operations live at the project level and are only available via the CLI/API.

## Deploy

After bootstrap, deploy with the suffixed service name:

```bash
railway up --service openemr-dev --environment dev
railway up --service openemr-production --environment production
```

First deploy takes 10–20 minutes because the Docker build runs `composer install`, `npm ci`, and `npm run build`.

## Adding the agent service (future)

When the agent service is built, it will live under `/agent/` with its own `railway.toml`. `bootstrap-env.sh` will be extended to create the agent service, provision a Postgres database for conversation state, set agent env vars, and wire the agent into the OpenEMR proxy. Until then, this script handles only the OpenEMR + MySQL pair.
