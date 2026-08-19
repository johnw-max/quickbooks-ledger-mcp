#!/usr/bin/env bash
# One-shot QuickBooks 0.6.0 redeploy, safe to paste into a console with no SSH.
#
# Brings up a candidate beside the container currently serving traffic, refuses
# to go further unless that candidate proves it is the fixed build, and only
# then moves nginx onto it. It never stops the live container: rollback is
# restoring one nginx file, which promotion has already backed up.
#
#   sudo bash deploy/redeploy-0.6.0.sh <commit-ish>
#
# Defaults to the commit that completes the write-outcome state machine: proven
# non-writes supersede, unknown outcomes have an operator-attested exit, and a
# replayed terminal success is confirmed against the Company before it is
# reported as done.
set -euo pipefail

COMMIT="${1:-8de5b8a}"
REQUIRED_MIGRATION="${QUICKBOOKS_REQUIRED_MIGRATION:-038_quickbooks_operator_unknown_write_resolution.sql}"
EXPECTED_TOOL_COUNT="${QUICKBOOKS_EXPECTED_TOOL_COUNT:-19}"
PROJECT="qbo-0-6-${COMMIT}"
IMAGE="quickbooks-ledger-mcp:0.6.0-${COMMIT}"
CANDIDATE_PORT="${QUICKBOOKS_CANDIDATE_PORT:-18004}"

step() { printf '\n=== %s ===\n' "$1"; }
die()  { printf '\nABORTED: %s\n' "$1" >&2; exit 1; }

[ -f deploy/compose.yaml ] || die "run this from the repository root"
[ -f deploy/.env.deploy ] || die "deploy/.env.deploy is missing (needs QUICKBOOKS_EGRESS_NETWORK and QUICKBOOKS_DATA_NETWORK)"

step "Fetching ${COMMIT}"
git fetch origin
git checkout codex/qbo-real-accountant-uat
git reset --hard "${COMMIT}"
git log --oneline -1
[ -f "migrations/${REQUIRED_MIGRATION}" ] || die "migration ${REQUIRED_MIGRATION} is not in this checkout"

step "Building ${IMAGE}"
docker build -f deploy/Dockerfile -t "${IMAGE}" .

step "Starting the candidate (the live container keeps serving)"
COMPOSE_PROJECT_NAME="${PROJECT}" \
QUICKBOOKS_APP_IMAGE="${IMAGE}" \
QUICKBOOKS_LOOPBACK_PORT="${CANDIDATE_PORT}" \
  docker compose -f deploy/compose.yaml --env-file deploy/.env.deploy up -d

# compose interpolates the network names for every subcommand, not just "up",
# so the env file is required here too or this resolves to nothing.
CANDIDATE="$(docker compose -p "${PROJECT}" -f deploy/compose.yaml --env-file deploy/.env.deploy ps -q quickbooks-mcp | head -1)"
[ -n "${CANDIDATE}" ] || die "the candidate container did not start"
CANDIDATE_NAME="$(docker inspect -f '{{.Name}}' "${CANDIDATE}" | sed 's|^/||')"
echo "candidate: ${CANDIDATE_NAME}"

step "Waiting for the candidate to become healthy"
# An unhealthy candidate here is usually the migration gate doing its job:
# readiness stays closed until the database has the expected head. Read the
# logs, do not reach for nginx. Note that applying a forward migration also
# flips the still-serving older container to NOT_READY, because readiness counts
# migrations outside its own expected set — that window is expected.
for _ in $(seq 1 40); do
  health="$(docker inspect -f '{{.State.Health.Status}}' "${CANDIDATE}" 2>/dev/null || echo starting)"
  [ "${health}" = "healthy" ] && break
  sleep 5
done
[ "${health:-}" = "healthy" ] || {
  echo "--- last 40 log lines ---"; docker logs --tail 40 "${CANDIDATE}" || true
  die "candidate never became healthy (health=${health:-unknown})"
}

step "Verifying the candidate is actually the fixed build"
docker exec "${CANDIDATE_NAME}" node -e "
fetch('http://127.0.0.1:3000/healthz').then(r=>r.json()).then(d=>{
  const head = d.readiness?.migrations?.latestExpected;
  const problems = [];
  if (d.version !== '0.6.0') problems.push('version ' + d.version);
  if (d.toolCount !== ${EXPECTED_TOOL_COUNT}) problems.push('toolCount ' + d.toolCount);
  if (head !== '${REQUIRED_MIGRATION}') problems.push('migration head ' + head);
  if (d.readiness?.ready !== true) problems.push('not ready');
  if (problems.length) { console.error('candidate rejected: ' + problems.join(', ')); process.exit(1); }
  console.log('candidate OK: 0.6.0, ${EXPECTED_TOOL_COUNT} tools, ' + head + ', ready');
}).catch(e=>{ console.error(String(e)); process.exit(1); });
" || die "the candidate is not the build we intend to promote — nothing was changed"

step "Promoting"
node deploy/promote-qbo-candidate.mjs "${CANDIDATE_NAME}"

step "Confirming from outside"
curl -s https://mcp.jiayuanwang.xyz/quickbooks/healthz \
  | python3 -c "
import json,sys
d = json.load(sys.stdin)
head = d['readiness']['migrations']['latestExpected']
print('live version    :', d['version'])
print('live tool count :', d['toolCount'])
print('live migration  :', head)
sys.exit(0 if head == '${REQUIRED_MIGRATION}' else 1)
" || die "nginx is not serving the new build yet — restore the backup printed above"

cat <<EOF

Done. The previous container is still running and untouched.

  Roll back : sudo cp <backup path printed above> /etc/nginx/sites-enabled/mcp.jiayuanwang.xyz \\
              && sudo nginx -t && sudo systemctl reload nginx
  Retire old: docker stop <previous container>   # only once you are satisfied

Online UAT resumes at T02. The Work agent must re-authorise OAuth first: its
installation was bound to the old build.
EOF
