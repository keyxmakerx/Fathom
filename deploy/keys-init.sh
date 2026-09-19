#!/bin/sh
# Run once per start by `compose.yaml`'s `keys-init` service, as root, with
# the `keys` volume at /keys. Generates whatever secret is missing and sets
# every owner and mode; never regenerates a file that exists. See the
# service's own comment in `compose.yaml` for why this is a container of its
# own and what it replaced.
#
# The two root keys: 32 raw bytes from the kernel CSPRNG, owned by the
# server's uid (65532, distroless nonroot), mode 0400 -- the server refuses
# anything looser (`docs/OPERATING.md`, "Permissions"). The three database
# passwords: 64 hex characters, mode 0444, because the postgres image and the
# server run as different uids and share no group; the fence is the volume
# (`deploy/init-db/10-app-role.sh`'s header). `tr -dc` over /dev/urandom is
# used rather than `od` because it is what BusyBox certainly has.
set -eu

d=/keys

key() {
    if [ ! -s "$d/$1" ]; then
        head -c 32 /dev/urandom > "$d/$1.new"
        mv "$d/$1.new" "$d/$1"
        echo "keys-init: generated $1"
    fi
    chown 65532:65532 "$d/$1"
    chmod 0400 "$d/$1"
}

password() {
    if [ ! -s "$d/$1" ]; then
        tr -dc 'a-f0-9' < /dev/urandom | head -c 64 > "$d/$1.new"
        printf '\n' >> "$d/$1.new"
        mv "$d/$1.new" "$d/$1"
        echo "keys-init: generated $1"
    fi
    chown 0:0 "$d/$1"
    chmod 0444 "$d/$1"
}

chmod 0755 "$d"
key master.key
key chain.key
password db_bootstrap.pw
password db_migrate.pw
password db_app.pw
echo "keys-init: done; back up this volume somewhere your database backups are not"
