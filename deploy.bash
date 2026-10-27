#!/usr/bin/env bash
# Deploy the Milunzo RTC Lab backend (VoltKit).
# Same shape as the main server's deploy.bash (lock, health check, rollback),
# Its own container on port 7000 never replaces milunzo-api on port 6000.
#
#   sudo bash node/deploy.bash
#
# Reads node/.env and passes only LAB_KEY and the two providers' credentials.
# Requires Docker and flock (util-linux).
set -Eeuo pipefail
umask 077

SERVER_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$SERVER_DIR/.env}"
CONTAINER_NAME="${CONTAINER_NAME:-milunzo-rtc-lab}"
IMAGE_NAME="${IMAGE_NAME:-milunzo-rtc-lab-server}"
BIND_ADDRESS="${BIND_ADDRESS:-127.0.0.1}"
HOST_PORT="${HOST_PORT:-7000}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-60}"

fail() { printf 'Deployment failed: %s\n' "$*" >&2; exit 1; }
command -v docker >/dev/null || fail 'Install Docker on the EC2 host first.'
command -v flock >/dev/null || fail 'Install util-linux (flock) first.'
[[ "$CONTAINER_NAME" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || fail 'Invalid CONTAINER_NAME.'
[[ "$CONTAINER_NAME" != milunzo-api ]] || fail 'CONTAINER_NAME milunzo-api is the production API; choose another.'
[[ "$HOST_PORT" =~ ^[0-9]+$ && "$HOST_PORT" -ge 1 && "$HOST_PORT" -le 65535 ]] || fail 'Invalid HOST_PORT.'
[[ "$HOST_PORT" != 6000 ]] || fail 'Port 6000 belongs to the production API; choose another HOST_PORT.'
[[ "$HEALTH_TIMEOUT" =~ ^[0-9]+$ && "$HEALTH_TIMEOUT" -ge 10 ]] || fail 'HEALTH_TIMEOUT must be at least 10 seconds.'
[[ -r "$ENV_FILE" ]] || fail "Create $ENV_FILE from node/.env.example first."
docker info >/dev/null 2>&1 || fail 'Docker is unavailable; start Docker and grant this user access.'
exec 9>"$SERVER_DIR/.deploy-${CONTAINER_NAME}.lock"
flock -n 9 || fail 'Another deployment is running.'

tag="${IMAGE_NAME}:$(date -u +%Y%m%dT%H%M%SZ)-$$"
backup="${CONTAINER_NAME}-previous-$$"
prior_name="$CONTAINER_NAME"
had_previous=false
replacement_started=false
docker_env_file=''
rollback() {
  status=$?
  trap - EXIT INT TERM
  if [[ -n "$docker_env_file" ]]; then rm -f -- "$docker_env_file"; fi
  if (( status != 0 )); then
    if [[ "$replacement_started" == true ]]; then
      docker logs "$CONTAINER_NAME" >"$SERVER_DIR/.deploy-${CONTAINER_NAME}-failed.log" 2>&1 || true
      printf 'Failed-container logs: %s/.deploy-%s-failed.log\n' "$SERVER_DIR" "$CONTAINER_NAME" >&2
      docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
    fi
    if [[ "$had_previous" == true ]]; then
      if docker rename "$backup" "$prior_name" && docker start "$prior_name" >/dev/null; then
        printf 'Previous container restored.\n' >&2
      else
        printf 'Could not restore the previous container; inspect Docker on this host.\n' >&2
      fi
    fi
  fi
  exit "$status"
}
trap rollback EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf 'Building and testing %s...\n' "$tag"
docker build --tag "$tag" "$SERVER_DIR"
# The image's tests run without network (fake VoltKit) before anything is replaced.
docker run --rm --network none "$tag" node --test || fail 'Tests failed in the image.'

# Parse .env with Node (quoted values work, no shell sourcing) and keep only
# what the lab needs: MONGODB_URI and the other main-server secrets stay out.
docker_env_file="$(mktemp)"
docker run --rm --user 0:0 --network none \
  --mount "type=bind,source=$ENV_FILE,target=/run/lab.env,readonly" \
  "$tag" node --input-type=module -e '
    import { parseEnv } from "node:util";
    import { readFileSync } from "node:fs";
    import { readConfig } from "./src/config.mjs";
    const env = parseEnv(readFileSync("/run/lab.env", "utf8"));
    readConfig({ ...env, PORT: "7000" });
    const keys = ["LAB_KEY", "VOLTKIT_RTC_URL", "VOLTKIT_RTC_SECRET"];
    for (const key of keys) process.stdout.write(`${key}=${env[key]}\n`);
  ' >"$docker_env_file"

# Migrate the earlier VoltKit-only lab on port 7000, retaining rollback.
if [[ "$CONTAINER_NAME" == milunzo-rtc-lab && "$HOST_PORT" == 7000 ]] &&
   ! docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1 &&
   docker container inspect voltkit-lab >/dev/null 2>&1; then
  prior_name=voltkit-lab
fi
if docker container inspect "$prior_name" >/dev/null 2>&1; then
  docker rename "$prior_name" "$backup"
  had_previous=true
  docker stop --time 15 "$backup" >/dev/null
fi
replacement_started=true
docker run --detach --name "$CONTAINER_NAME" \
  --restart unless-stopped --init --stop-timeout 15 \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \
  --env-file "$docker_env_file" \
  --env HOST=0.0.0.0 --env PORT=7000 \
  --publish "$BIND_ADDRESS:$HOST_PORT:7000" "$tag" >/dev/null

deadline=$((SECONDS + HEALTH_TIMEOUT))
while (( SECONDS < deadline )); do
  state="$(docker inspect --format '{{.State.Status}}' "$CONTAINER_NAME")"
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$CONTAINER_NAME")"
  if [[ "$state" == running && "$health" == healthy ]]; then
    if [[ "$had_previous" == true ]]; then docker rm "$backup" >/dev/null; fi
    had_previous=false
    printf 'Deployed %s at %s:%s; health check passed.\n' "$tag" "$BIND_ADDRESS" "$HOST_PORT"
    printf 'Expose the token server over HTTPS at http://%s:%s.\n' "$BIND_ADDRESS" "$HOST_PORT"
    exit 0
  fi
  [[ "$state" != exited && "$state" != dead ]] || fail 'New container exited; rollback will run.'
  sleep 2
done
fail 'New container did not become healthy before HEALTH_TIMEOUT; rollback will run.'
