#!/bin/sh
# Redis ACL files cannot read env vars, so render the file from env at container start.
# +info: ioredis runs INFO for its ready check, and -@dangerous would otherwise block it.
set -eu

: "${REDIS_RIDER_PASSWORD:?}" "${REDIS_DRIVER_PASSWORD:?}" "${REDIS_MATCHING_PASSWORD:?}" "${REDIS_ROUTING_PASSWORD:?}"

ACL=/tmp/users.acl
umask 077
cat > "$ACL" <<ACLEOF
user default off
user rider on >${REDIS_RIDER_PASSWORD} ~rider:* &none +@all -@dangerous +info
user driver on >${REDIS_DRIVER_PASSWORD} ~driver:* &none +@all -@dangerous +info
user matching on >${REDIS_MATCHING_PASSWORD} ~matching:* &none +@all -@dangerous +info
user routing on >${REDIS_ROUTING_PASSWORD} ~routing:* &none +@all -@dangerous +info
user healthcheck on nopass resetkeys resetchannels -@all +ping
ACLEOF

exec redis-server --aclfile "$ACL" --appendonly yes --appendfsync everysec --dir /data
