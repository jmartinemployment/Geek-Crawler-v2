#!/bin/sh
set -e

MODE="${EGRESS_MODE:-off}"

if [ "$MODE" = "mesh" ]; then
  if [ -z "${TS_AUTHKEY:-}" ] || [ -z "${TS_EXIT_NODE:-}" ]; then
    echo "EGRESS_MODE=mesh requires TS_AUTHKEY and TS_EXIT_NODE" >&2
    exit 1
  fi

  # Userspace networking works on hosts without /dev/net/tun (common on PaaS).
  tailscaled --state=mem: --tun=userspace-networking &
  sleep 1
  tailscale up \
    --authkey="${TS_AUTHKEY}" \
    --exit-node="${TS_EXIT_NODE}" \
    --exit-node-allow-lan-access=false

  # Fail closed: require exit node path (operator should verify Fiber IP in ops).
  echo "Tailscale exit node requested: ${TS_EXIT_NODE}"
fi

exec node dist/cli.js serve
