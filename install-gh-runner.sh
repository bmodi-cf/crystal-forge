#!/usr/bin/env bash
#
# install-gh-runner.sh — install/register the self-hosted GitHub Actions runner
# that runs the Forge promotion gates (prereq P1 of the forge-production
# deployment plan) on a server (PILOT / PROD style host).
#
# ─────────────────────────────────────────────────────────────────────────────
# WHAT THIS SETS UP
# ─────────────────────────────────────────────────────────────────────────────
# An **org-level** self-hosted runner registered to the GitHub org, installed as
# a systemd service, that executes the template repo's promote-gates workflow
# (P2: .github/workflows/promote-gates.yml). Org-level (not per-repo) because
# every Forge is its own repo created from the template — one org runner serves
# all current and future forges.
#
# The runner advertises label **forge-pilot** (RUNNER_LABELS). P2's workflow
# targets it via `runs-on: [self-hosted, forge-pilot]`. These two MUST match;
# unlike the required-check names (pinned in lib/github/branches.ts), the label
# lives only in the template repo's workflow, so keep them in sync by hand. See
# docs/superpowers/plans/2026-07-02-forge-production-deployment.md (P1/P2).
#
# The workflow's `build` job runs `docker build` + `docker push` to the on-prem
# registry, so this box needs Docker, the runner's user in the `docker` group,
# and a persistent `docker login registry.crystalfountains.com` with the PUSH
# account. This script wires that login when REGISTRY_USERNAME is provided.
#
# ─────────────────────────────────────────────────────────────────────────────
# USAGE
# ─────────────────────────────────────────────────────────────────────────────
#   ./install-gh-runner.sh                 # resolve latest runner, register, install service
#   ./install-gh-runner.sh --print         # show resolved config + planned steps, change nothing
#   ./install-gh-runner.sh --reconfigure   # uninstall the service + drop existing registration, then redo
#
# Registration token (short-lived, ~1h) is obtained in this order:
#   1. $REG_TOKEN if set.
#   2. `gh api` if the gh CLI is installed and authed as an org admin.
#   3. Otherwise the script tells you where to mint one and exits.
#
# Overridable env vars (defaults in parens):
#   GH_ORG (CrystalFountainsInc)     RUNNER_LABELS (forge-pilot)
#   RUNNER_NAME (<host>-forge-runner)  RUNNER_DIR (~/actions-runner)
#   RUNNER_VERSION (latest release)  RUNNER_GROUP (Default)
#   REGISTRY_HOST (registry.crystalfountains.com)
#   REGISTRY_USERNAME / REGISTRY_PASSWORD (enables the docker login step)
#
# Run as the user that should OWN and RUN the runner, NOT via sudo. The runner
# refuses to run as root; this script elevates only the `svc.sh` steps with sudo.
# Re-running is safe: without --reconfigure it skips already-done steps.
#
set -euo pipefail

if [[ "${EUID}" -eq 0 ]]; then
  echo "error: do not run this with sudo / as root." >&2
  echo "       Run it as the user that should own and run the runner, e.g.:" >&2
  echo "           ./install-gh-runner.sh" >&2
  echo "       It will call sudo itself for the privileged svc.sh steps." >&2
  exit 1
fi

# ── Config (env-overridable) ────────────────────────────────────────────────
GH_ORG="${GH_ORG:-CrystalFountainsInc}"
RUNNER_LABELS="${RUNNER_LABELS:-forge-pilot}"
RUNNER_NAME="${RUNNER_NAME:-$(hostname -s)-forge-runner}"
RUNNER_DIR="${RUNNER_DIR:-${HOME}/actions-runner}"
RUNNER_GROUP="${RUNNER_GROUP:-Default}"
REGISTRY_HOST="${REGISTRY_HOST:-registry.crystalfountains.com}"
ORG_URL="https://github.com/${GH_ORG}"
RUN_USER="$(id -un)"

MODE="install"
case "${1:-}" in
  --print)       MODE="print" ;;
  --reconfigure) MODE="reconfigure" ;;
  "")            ;;
  *) echo "error: unknown argument '${1}' (expected --print or --reconfigure)" >&2; exit 1 ;;
esac

# ── Preflight: required tooling ─────────────────────────────────────────────
for bin in curl tar; do
  command -v "${bin}" >/dev/null || { echo "error: '${bin}' not found on PATH." >&2; exit 1; }
done

if ! command -v docker >/dev/null; then
  echo "error: 'docker' not found. The promote-gates 'build' job needs it to build/push images." >&2
  exit 1
fi

# The runner service runs as RUN_USER; that user must be able to talk to the
# Docker daemon for `docker build`/`docker push` in jobs.
if ! id -nG "${RUN_USER}" | tr ' ' '\n' | grep -qx docker; then
  echo "error: user '${RUN_USER}' is not in the 'docker' group." >&2
  echo "       Fix, then re-run:" >&2
  echo "           sudo usermod -aG docker ${RUN_USER}    # then log out/in (or reboot)" >&2
  exit 1
fi

# ── Resolve arch + runner version ───────────────────────────────────────────
case "$(uname -m)" in
  x86_64|amd64)  RUNNER_ARCH=x64 ;;
  aarch64|arm64) RUNNER_ARCH=arm64 ;;
  *) echo "error: unsupported architecture '$(uname -m)'." >&2; exit 1 ;;
esac

RUNNER_VERSION="${RUNNER_VERSION:-}"
if [[ -z "${RUNNER_VERSION}" ]]; then
  echo ">> Resolving latest actions/runner release…"
  api_json="$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest)" || {
    echo "error: could not query GitHub for the latest runner version (rate limited?)." >&2
    echo "       Pin it explicitly, e.g.:  RUNNER_VERSION=2.321.0 ./install-gh-runner.sh" >&2
    exit 1
  }
  # tag_name looks like "v2.321.0" — strip the leading v.
  RUNNER_VERSION="$(printf '%s' "${api_json}" | grep -m1 '"tag_name"' | sed -E 's/.*"v?([0-9.]+)".*/\1/')"
  [[ -n "${RUNNER_VERSION}" ]] || { echo "error: failed to parse the latest runner version." >&2; exit 1; }
fi

TARBALL="actions-runner-linux-${RUNNER_ARCH}-${RUNNER_VERSION}.tar.gz"
DOWNLOAD_URL="https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${TARBALL}"

# ── Summary ─────────────────────────────────────────────────────────────────
echo
echo ">> GitHub Actions runner install"
echo "   org url:   ${ORG_URL}"
echo "   name:      ${RUNNER_NAME}"
echo "   labels:    ${RUNNER_LABELS}"
echo "   group:     ${RUNNER_GROUP}"
echo "   version:   ${RUNNER_VERSION} (${RUNNER_ARCH})"
echo "   dir:       ${RUNNER_DIR}"
echo "   run as:    ${RUN_USER}"
echo "   registry:  ${REGISTRY_HOST}${REGISTRY_USERNAME:+  (docker login as ${REGISTRY_USERNAME})}"
echo "   download:  ${DOWNLOAD_URL}"
echo

if [[ "${MODE}" == "print" ]]; then
  echo "# --print: no changes made. Would download+extract, register the runner,"
  echo "#          install the systemd service via svc.sh, and (if REGISTRY_USERNAME"
  echo "#          set) docker login to ${REGISTRY_HOST}."
  exit 0
fi

# ── Reconfigure: tear down an existing registration/service first ───────────
if [[ "${MODE}" == "reconfigure" && -d "${RUNNER_DIR}" ]]; then
  echo ">> --reconfigure: removing existing service + registration in ${RUNNER_DIR}"
  if [[ -f "${RUNNER_DIR}/svc.sh" ]]; then
    ( cd "${RUNNER_DIR}" && sudo ./svc.sh stop || true; sudo ./svc.sh uninstall || true )
  fi
  # Drop local registration state so config.sh can re-run cleanly.
  rm -f "${RUNNER_DIR}/.runner" "${RUNNER_DIR}/.credentials" "${RUNNER_DIR}/.credentials_rsaparams" || true
fi

# ── Download + extract (skip if binaries already present) ───────────────────
mkdir -p "${RUNNER_DIR}"
if [[ -x "${RUNNER_DIR}/config.sh" ]]; then
  echo ">> Runner binaries already present in ${RUNNER_DIR} — skipping download."
else
  echo ">> Downloading ${TARBALL}…"
  curl -fSL -o "${RUNNER_DIR}/${TARBALL}" "${DOWNLOAD_URL}"
  echo ">> Verifying archive integrity…"
  tar tzf "${RUNNER_DIR}/${TARBALL}" >/dev/null || { echo "error: downloaded archive is not a valid tar.gz." >&2; exit 1; }
  echo ">> Extracting into ${RUNNER_DIR}…"
  tar xzf "${RUNNER_DIR}/${TARBALL}" -C "${RUNNER_DIR}"
  rm -f "${RUNNER_DIR}/${TARBALL}"
fi

# ── Obtain a registration token ─────────────────────────────────────────────
if [[ -f "${RUNNER_DIR}/.runner" ]]; then
  echo ">> Runner already registered (.runner present) — skipping config."
  echo "   Use --reconfigure to re-register."
else
  REG_TOKEN="${REG_TOKEN:-}"
  if [[ -z "${REG_TOKEN}" ]]; then
    if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
      echo ">> Minting a registration token via gh api (org: ${GH_ORG})…"
      REG_TOKEN="$(gh api -X POST "/orgs/${GH_ORG}/actions/runners/registration-token" -q .token)" || {
        echo "error: gh api failed. Your gh account may lack org-admin rights on ${GH_ORG}." >&2
        exit 1
      }
    else
      echo "error: no registration token available." >&2
      echo "       Provide one of:" >&2
      echo "         • REG_TOKEN=<token> ./install-gh-runner.sh" >&2
      echo "           (mint at: ${ORG_URL} → Settings → Actions → Runners → New runner)" >&2
      echo "         • or authenticate the gh CLI as an org admin: gh auth login" >&2
      exit 1
    fi
  fi

  echo ">> Registering runner with the org…"
  ( cd "${RUNNER_DIR}" && ./config.sh \
      --url "${ORG_URL}" \
      --token "${REG_TOKEN}" \
      --name "${RUNNER_NAME}" \
      --labels "${RUNNER_LABELS}" \
      --runnergroup "${RUNNER_GROUP}" \
      --unattended --replace )
fi

# ── Install + start as a systemd service ────────────────────────────────────
echo ">> Installing runner as a systemd service (runs as ${RUN_USER})…"
( cd "${RUNNER_DIR}" && sudo ./svc.sh install "${RUN_USER}" && sudo ./svc.sh start )
echo
( cd "${RUNNER_DIR}" && sudo ./svc.sh status || true )

# ── Optional: docker login for the registry PUSH account ────────────────────
if [[ -n "${REGISTRY_USERNAME:-}" ]]; then
  echo
  echo ">> Logging Docker into ${REGISTRY_HOST} as ${REGISTRY_USERNAME} (push account)…"
  if [[ -n "${REGISTRY_PASSWORD:-}" ]]; then
    printf '%s' "${REGISTRY_PASSWORD}" | docker login "${REGISTRY_HOST}" -u "${REGISTRY_USERNAME}" --password-stdin
  else
    docker login "${REGISTRY_HOST}" -u "${REGISTRY_USERNAME}"   # prompts for password
  fi
  echo "   Stored in ${HOME}/.docker/config.json — the runner's jobs push without secrets in the workflow YAML."
else
  echo
  echo ">> Skipped registry login (REGISTRY_USERNAME not set)."
  echo "   Before the promote-gates 'build' job can push, run once:"
  echo "       docker login ${REGISTRY_HOST} -u <push-user>"
fi

echo
echo ">> Done. The runner should show 'Idle' under ${ORG_URL} → Settings → Actions → Runners."
echo ">> REMINDER: P2's .github/workflows/promote-gates.yml must target this label:"
echo ">>           runs-on: [self-hosted, ${RUNNER_LABELS}]"
echo ">>           (kept in sync by hand — see the P1/P2 note in the deployment plan.)"
