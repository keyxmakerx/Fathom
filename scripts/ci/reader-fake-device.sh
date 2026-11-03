#!/bin/sh
# A network device's answers, for the reader's SSH test (scripts/ci/reader-sshd.sh). The platform
# is the first word of the login's ~/platform file (junos or eos), junos by default. Only the
# exact command the reader's list holds is answered; anything else is refused, as a device's CLI
# would refuse an unknown command, and the refusal is logged so the test can see what was sent.
echo "$SSH_ORIGINAL_COMMAND" >> /tmp/fathom-fake-device.log
platform=$(cat "$HOME/platform" 2>/dev/null || echo junos)
case "$platform:$SSH_ORIGINAL_COMMAND" in
"junos:show configuration | display set")
    cat <<'CFG'
set version 23.4R2-S4.11
set system host-name srx-lab
set system root-authentication encrypted-password "$6$6nBQ1Gtk$2VfGQyW0p7cJ8z.Zr5n4Qx2e1VhD8yJ6cR0kL3mT9sA4uB7dF1gH5jK2lM8nP0qS3tU6vW9xY1zA4bC7dE0fG."
set system login user ro-fathom class read-only
set system login user ro-fathom authentication encrypted-password "$6$Kx9pL2mQ$hR4tY7uI0oP3aS6dF9gH2jK5lZ8xC1vB4nM7qW0eR3tY6uI9oP2aS5dF8gH1jK4lZ7xC0vB3nM6qW9eR2tY5u."
set interfaces ge-0/0/0 unit 0 family inet address 10.20.0.1/24
set interfaces ge-0/0/1 unit 0 family inet address 192.0.2.1/30
CFG
    ;;
"eos:show running-config")
    cat <<'CFG'
! device: leaf1 (DCS-7050SX3-48YC8, EOS-4.32.2F)
hostname leaf1
username admin privilege 15 role network-admin secret sha512 $6$Qm3xR8vL$Jx1fZbC9d0aKq2hYwN0pT5sU8vW1xY4zA7bC0dE3fG6hJ9kL2mN5oP8qR1sT4uV7wX0yZ3aB6cD9eF2gH5iJ8k.
interface Ethernet1
   description uplink to spine1
   no switchport
   ip address 10.30.0.1/31
CFG
    ;;
*)
    echo "syntax error, expecting <command>." >&2
    exit 1
    ;;
esac
