# Runbook: Pilot registry & CI-runner infrastructure

Stands up (or rebuilds) the **edge in front of the on-prem Docker registry** plus the
**self-hosted GitHub Actions runner** on the pilot host — i.e. prerequisite **P1** of
`docs/superpowers/plans/2026-07-02-forge-production-deployment.md`.

This is the layer that is otherwise **only live config under `/etc`** and scripted nowhere:
nginx TLS + basic-auth in front of the `registry:2` container, the htpasswd accounts, and DNS
resolution. The registry *container* itself is in `docker-compose.yml`; everything wrapping it
is captured here.

> **Scope.** Registry front-end + auth + DNS + CI runner. The **dashboard** vhost and systemd
> unit are a separate concern — see [`docs/DEPLOY.md`](../DEPLOY.md). The two nginx vhosts share
> one nginx instance and one wildcard cert but are independent server blocks.

---

## Audience & execution model

**This runbook is executed by an agent** (Claude Code or equivalent) with a shell on the pilot
host and `sudo`. It is not a prose guide for a human to skim — each step is an
inspect → act → verify unit the agent runs in order. A human supplies the secrets (§ Inputs)
and approves the STOP points.

### Operating contract (the agent MUST follow)

1. **Idempotent, inspect-first.** Every step begins by inspecting current state. If the target
   already holds, log it and skip the action. Never blindly re-create.
2. **Verify after every action.** Do not advance to the next step until the current step's
   **Verify** command produces the stated result. On mismatch, STOP and report — do not paper over.
3. **Never fabricate secrets.** TLS private keys, and the `push`/`pull` passwords are
   operator-supplied (§ Inputs). If a required secret is absent, STOP and ask; do not invent one.
4. **STOP points are hard.** Where a step says **STOP**, halt and get explicit human confirmation
   before proceeding (irreversible or credential/DNS-affecting actions).
5. **Deletion needs approval.** Do not delete or overwrite existing config/secret files without
   asking; back up first (`cp <f> <f>.bak-<UTC-timestamp>`), per repo policy.
6. **Report at the end.** Summarize what was already-present vs. changed, and the final
   verification results.

---

## Target state (acceptance criteria)

The runbook is complete when all of these hold:

- [ ] `registry:2` container `crystal-forge-registry` is `Up`, storage on volume
      `crystal-forge_crystal-forge-registry-data` (→ `/var/lib/registry`), with
      `REGISTRY_STORAGE_DELETE_ENABLED=true` (DELETE manifest API on, for forge removal).
- [ ] nginx is active with a `registry.crystalfountains.com` vhost: 80→443 redirect, TLS via the
      `*.crystalfountains.com` wildcard cert, `/v2/` → `127.0.0.1:5000`.
- [ ] Two htpasswd files: `/etc/nginx/registry.htpasswd` (accounts `push`+`pull`, read) and
      `/etc/nginx/registry.push.htpasswd` (account `push`, write), owned `root:www-data`, mode `640`.
- [ ] `registry.crystalfountains.com` resolves on the box (real DNS, or `/etc/hosts` stopgap).
- [ ] `pull` can read but not write; `push` can read and write (verified end-to-end).
- [ ] Dashboard `.env.local` has `REGISTRY_HOST/USERNAME/PASSWORD` matching the `push` account.
- [ ] A self-hosted runner labelled `forge-pilot` shows **Idle** on the **`CrystalFountainsInc`**
      org (via `install-gh-runner.sh`). Forge repos, the template repo, and the `crystal-forge-api`
      GitHub App installation must all live in that org — org runners only serve org repos.

---

## Inputs the human must supply (secrets — not in the repo)

Collect these before starting; the agent must STOP and request any that are missing:

| Input | Used in | Notes |
|---|---|---|
| Wildcard TLS `fullchain.pem` + `privkey.key` | Step R1 | For `*.crystalfountains.com`. Private key is secret. |
| `push` account password | Steps R3, R6, verify | read+write account. |
| `pull` account password | Step R3, verify | read-only account. |
| Real DNS access **or** decision to use `/etc/hosts` | Step R5 | Pilot currently uses `/etc/hosts`. |
| `gh` CLI authed as **org admin** with the **`admin:org`** scope (`gh auth refresh -h github.com -s admin:org` — default scopes are NOT enough and fail as 404), or a runner registration token | Step R7 | See `install-gh-runner.sh`. |

---

## Step R0 — Prereqs

**Goal:** Docker, nginx, and an htpasswd-capable tool are available.

**Inspect:**
```bash
command -v docker && docker compose version
systemctl is-active nginx || echo "nginx not active"
command -v htpasswd || echo "htpasswd absent — will use docker httpd image"
```

**Act (only what's missing):** install `nginx` if absent (`sudo apt-get install -y nginx`).
Do **not** install `apache2-utils` just for htpasswd — the box doesn't have it and Step R3 uses
the `httpd` Docker image instead (no host install, Docker is already present).

**Verify:** `nginx -v` prints a version and `systemctl is-active nginx` → `active`.

---

## Step R1 — TLS certificate in place

**Goal:** the wildcard cert is at `/etc/ssl/crystal-forge/{fullchain.pem,privkey.key}`.

**Inspect:**
```bash
sudo ls -l /etc/ssl/crystal-forge/fullchain.pem /etc/ssl/crystal-forge/privkey.key 2>/dev/null
# confirm the cert covers *.crystalfountains.com and is unexpired:
sudo openssl x509 -in /etc/ssl/crystal-forge/fullchain.pem -noout -enddate -ext subjectAltName 2>/dev/null
```

**Act:** if absent/expired — **STOP.** The private key is operator-supplied secret material; the
agent must not generate or guess it. Once provided, place with:
```bash
sudo install -d -m 0750 /etc/ssl/crystal-forge
sudo install -m 0644 <provided-fullchain.pem> /etc/ssl/crystal-forge/fullchain.pem
sudo install -m 0600 <provided-privkey.key>    /etc/ssl/crystal-forge/privkey.key
```

**Verify:** `openssl x509 … -enddate` shows a future date and the SAN includes
`*.crystalfountains.com`.

---

## Step R2 — Registry container

**Goal:** `crystal-forge-registry` running with persistent storage.

**Inspect:**
```bash
docker ps --filter name=crystal-forge-registry --format '{{.Names}} {{.Status}}'
docker volume ls | grep crystal-forge-registry-data
```

**Act (from the repo root, where `docker-compose.yml` lives):**
```bash
docker compose up -d registry     # image registry:2, loopback 127.0.0.1:5000, named volume
```
Storage is the `registry:2` default (`filesystem`, `rootdirectory: /var/lib/registry`). The one
piece of non-default config is in `docker-compose.yml`:

```yaml
environment:
  REGISTRY_STORAGE_DELETE_ENABLED: "true"   # enable the DELETE manifest API (forge removal)
```

Without it the registry rejects `DELETE /v2/<name>/manifests/<digest>` with `405 unsupported`,
so forges could never be removed. The env var is baked into the service definition, so it
survives container recreation. Auth is **not** set on the container; it's enforced by nginx
(Step R4), whose `limit_except GET HEAD` already gates DELETE behind the push account.

**Verify:**
```bash
docker exec crystal-forge-registry wget -qO- http://127.0.0.1:5000/v2/ && echo "  <- registry up"
docker inspect crystal-forge-registry \
  --format '{{range .Config.Env}}{{println .}}{{end}}' | grep REGISTRY_STORAGE_DELETE_ENABLED
```
(`{}` response = registry API alive; the grep must print `...=true`.) Images persist at
`/var/lib/docker/volumes/crystal-forge_crystal-forge-registry-data/_data`.

> **Reclaiming disk after deletes.** A `DELETE` only unlinks the manifest/tags; blobs linger
> until garbage collection. Reclaim with:
> ```bash
> docker exec crystal-forge-registry \
>   registry garbage-collect /etc/docker/registry/config.yml
> ```
> Run it when the registry is idle (GC assumes no concurrent pushes).
>
> ⚠️ **NEVER pass `--delete-untagged`.** Our images are pushed by buildx as an OCI *image
> index*; the platform (`linux/amd64`) and attestation child manifests it references carry
> **no tags of their own**. `--delete-untagged` prunes those child manifests → orphans their
> layer blobs → the sweep deletes them, silently corrupting the image (the index still 200s but
> its children 404). This happened to `crystal-lattice` on 2026-07-08 and it was only
> recoverable because the layers still existed in the pilot's local Docker engine. Plain GC (no
> flag) is safe: it only removes blobs unreferenced by any manifest. If you ever must reclaim
> tagless manifests, do it by explicit digest `DELETE`, never with `--delete-untagged`. And do
> not GC at all against images that cannot be re-pushed from a build.

---

## Step R3 — htpasswd auth files (push + pull)

**Goal:** the two-tier auth files exist with the right accounts and perms.

**Inspect:**
```bash
for f in /etc/nginx/registry.htpasswd /etc/nginx/registry.push.htpasswd; do
  sudo test -f "$f" && echo "$f: $(sudo cut -d: -f1 "$f" | paste -sd, -)" || echo "$f: MISSING"
done
```
Expected: read file → `push,pull`; write file → `push`.

**Act (only if missing — STOP first to obtain the passwords; do not invent them):**
`htpasswd` isn't installed, so generate entries with the `httpd` image. Use `-B` (bcrypt).
```bash
# read file (any valid user): pull + push
docker run --rm httpd:2 htpasswd -nbB pull "<PULL_PW>"  | sudo tee    /etc/nginx/registry.htpasswd >/dev/null
docker run --rm httpd:2 htpasswd -nbB push "<PUSH_PW>"  | sudo tee -a /etc/nginx/registry.htpasswd >/dev/null
# write file (push only)
docker run --rm httpd:2 htpasswd -nbB push "<PUSH_PW>"  | sudo tee    /etc/nginx/registry.push.htpasswd >/dev/null
# lock down: root-owned, readable by nginx's group only
sudo chown root:www-data /etc/nginx/registry.htpasswd /etc/nginx/registry.push.htpasswd
sudo chmod 640           /etc/nginx/registry.htpasswd /etc/nginx/registry.push.htpasswd
```
> `htpasswd -nbB` prints `user:hash` to stdout (no host install, no tmp file). Never echo the
> passwords into logs. If a file exists but needs a new account, back it up first (contract §5).

**Verify:** re-run the Inspect block; accounts and (via `sudo stat -c '%A %U:%G'`) `-rw-r----- root:www-data`.

---

## Step R4 — nginx registry vhost

**Goal:** the `registry.crystalfountains.com` server block is installed and enabled.

**Inspect:**
```bash
ls -l /etc/nginx/sites-enabled/registry 2>/dev/null
sudo nginx -t
```

**Act:** if missing, write `/etc/nginx/sites-available/registry` with exactly this content
(back up any existing file first), then symlink and reload:

```nginx
# On-prem Docker registry — TLS termination + basic-auth in front of the
# loopback registry:2 container. Reuses the *.crystalfountains.com wildcard.
server {
    listen 80;
    listen [::]:80;
    server_name registry.crystalfountains.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name registry.crystalfountains.com;

    ssl_certificate     /etc/ssl/crystal-forge/fullchain.pem;
    ssl_certificate_key /etc/ssl/crystal-forge/privkey.key;
    ssl_protocols       TLSv1.2 TLSv1.3;

    # Image layers can be large; don't cap the upload body.
    client_max_body_size 0;

    location /v2/ {
        # Writes (push/delete) require the push-only htpasswd -> read+write.
        limit_except GET HEAD {
            auth_basic "registry-push";
            auth_basic_user_file /etc/nginx/registry.push.htpasswd;
        }
        # Reads require any valid user (push or pull) -> pull is read-only.
        auth_basic "registry";
        auth_basic_user_file /etc/nginx/registry.htpasswd;

        proxy_pass http://127.0.0.1:5000;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 900s;
    }
}
```
```bash
sudo ln -sf /etc/nginx/sites-available/registry /etc/nginx/sites-enabled/registry
sudo nginx -t && sudo systemctl reload nginx
```

**Verify:** `sudo nginx -t` → `syntax is ok` / `test is successful`, and the symlink exists.

---

## Step R5 — Name resolution

**Goal:** `registry.crystalfountains.com` resolves to the pilot on the box (and anywhere else that
must reach it).

**Inspect:** `getent hosts registry.crystalfountains.com`

**Act:**
- **Preferred:** a real DNS `A` record → pilot IP. **STOP** — this is an external change; confirm
  with the operator.
- **Pilot stopgap (current):** add to `/etc/hosts`:
  ```bash
  grep -q registry.crystalfountains.com /etc/hosts || \
    echo "127.0.0.1  registry.crystalfountains.com" | sudo tee -a /etc/hosts
  ```
  > `/etc/hosts` is **local to this box only** — other hosts (and future prod) can't resolve the
  > registry until real DNS exists. Log this limitation.

**Verify:** `getent hosts registry.crystalfountains.com` returns an address.

---

## Step R6 — Wire the dashboard to the push account

**Goal:** the dashboard's registry client (`lib/registry/client.ts`) can authenticate for the
retag-on-accept.

**Inspect:** `grep -E '^REGISTRY_' <repo>/.env.local || echo "REGISTRY_* not set"`

**Act:** ensure `.env.local` contains (values = the `push` account from § Inputs):
```
REGISTRY_HOST=registry.crystalfountains.com
REGISTRY_USERNAME=push
REGISTRY_PASSWORD=<PUSH_PW>
```
Then restart the dashboard so it picks them up: `sudo systemctl restart crystal-forge.service`
(see [`docs/DEPLOY.md`](../DEPLOY.md)). For tests/offline, `REGISTRY_CLIENT_MODE=fake` instead.

**Verify:** `grep REGISTRY_HOST <repo>/.env.local` shows the host; the service is `active` after restart.

---

## Step R7 — Self-hosted CI runner

**Goal:** an org runner labelled `forge-pilot` online (so P2's `promote-gates.yml` can run).

**Act:** run the dedicated script (do **not** re-implement it here):
```bash
./install-gh-runner.sh            # resolves latest runner, registers org runner, installs service
# optionally wire the push login in the same pass:
REGISTRY_USERNAME=push REGISTRY_PASSWORD=<PUSH_PW> ./install-gh-runner.sh
```
See the script header for token acquisition (`gh api` vs `REG_TOKEN`) and the label-sync note.

**Verify:** the runner shows **Idle** under `https://github.com/CrystalFountainsInc` → Settings →
Actions → Runners; and `sudo <runner-dir>/svc.sh status` is running.

> **Why the org, not `bmodi-cf`:** GitHub has no account-level runners for personal user
> accounts, and org runners only serve repos inside that org — so forge repos are created
> under the `CrystalFountainsInc` org (see `GITHUB_REPO_OWNER`) and the runner registers there.

---

## End-to-end verification

Run all of these; every one must pass before declaring P1 complete:

```bash
# 1. Reads require auth; pull can read.
curl -fsS -u pull:<PULL_PW> https://registry.crystalfountains.com/v2/_catalog        # -> {"repositories":[...]}
curl -fsS -o /dev/null -w '%{http_code}\n' https://registry.crystalfountains.com/v2/_catalog  # -> 401 (no creds)

# 2. pull CANNOT write (expect denial), push CAN.
docker login registry.crystalfountains.com -u pull   # then a push should 401/403
docker login registry.crystalfountains.com -u push   # push account

# 3. Full round-trip with the push account.
docker pull hello-world
docker tag hello-world registry.crystalfountains.com/smoketest:p1
docker push registry.crystalfountains.com/smoketest:p1
docker rmi   registry.crystalfountains.com/smoketest:p1 && docker pull registry.crystalfountains.com/smoketest:p1

# 4. It persisted to the volume (survives container recreate).
sudo ls /var/lib/docker/volumes/crystal-forge_crystal-forge-registry-data/_data/docker/registry/v2/repositories

# 5. DELETE works (needs REGISTRY_STORAGE_DELETE_ENABLED=true). Resolve the digest, then delete it.
ACCEPT='application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'
DIG=$(curl -fsS -I -u push:<PUSH_PW> -H "Accept: $ACCEPT" \
        https://registry.crystalfountains.com/v2/smoketest/manifests/p1 \
        | tr -d '\r' | awk -F': ' 'tolower($1)=="docker-content-digest"{print $2}')
curl -fsS -o /dev/null -w '%{http_code}\n' -X DELETE -u push:<PUSH_PW> \
     https://registry.crystalfountains.com/v2/smoketest/manifests/$DIG   # -> 202 Accepted
curl -fsS -o /dev/null -w '%{http_code}\n' -X DELETE -u pull:<PULL_PW> \
     https://registry.crystalfountains.com/v2/smoketest/manifests/$DIG   # -> 401 (pull can't delete)
```

---

## Rollback

- **nginx vhost:** `sudo rm /etc/nginx/sites-enabled/registry && sudo systemctl reload nginx`
  (or restore the `.bak-<ts>` copy). The dashboard vhost is unaffected — separate server block.
- **Registry container:** `docker compose stop registry` (the **volume persists** — images are not
  lost; `docker compose down -v` WOULD delete them, so don't, without explicit approval).
- **Auth files / cert:** restore from the `.bak-<ts>` copies taken before overwrite.
- **Runner:** `sudo <runner-dir>/svc.sh stop && sudo <runner-dir>/svc.sh uninstall`, then
  `./config.sh remove` (needs a removal token) — or `./install-gh-runner.sh --reconfigure`.

---

## Related

- Plan / prereqs: `docs/superpowers/plans/2026-07-02-forge-production-deployment.md` (P1, P2).
- Dashboard deploy (separate concern): `docs/DEPLOY.md`.
- Runner installer: `install-gh-runner.sh`. Registry container: `docker-compose.yml`.
- Dashboard/registry client that consumes the push creds: `lib/registry/client.ts`.
