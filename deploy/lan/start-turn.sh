#!/bin/sh
set -eu

# Pass the REST secret in a private tmpfs config instead of a process argument.
umask 077
secret=${BS_LAN_TURN_SECRET:-}
case "$secret" in
  *[!a-zA-Z0-9_-]*)
    echo "Invalid TURN REST secret format" >&2
    exit 1
    ;;
esac
if [ "${#secret}" -lt 32 ] || [ "${#secret}" -gt 512 ]; then
  echo "TURN REST secret must have 32–512 characters" >&2
  exit 1
fi
unset BS_LAN_TURN_SECRET

for file in /etc/bottleship/tls/fullchain.pem /etc/bottleship/tls/privkey.pem; do
  if [ ! -r "$file" ] || [ ! -s "$file" ]; then
    echo "TURN TLS certificate or key is unavailable" >&2
    exit 1
  fi
done

config=$(mktemp /tmp/bottleship-turn.XXXXXX)
{
  cat /etc/bottleship/turnserver.conf /etc/bottleship/turnserver.network.conf
  printf '\nstatic-auth-secret=%s\n' "$secret"
} > "$config"
exec turnserver -c "$config"
