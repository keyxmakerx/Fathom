#!/bin/sh
# An SSH server that answers like a network device, for the reader's SSH test
# (helpers/reader/tests/ssh.rs; CLAUDE.md rule 2: test against what a real server accepts).
#
# OpenSSH's sshd on port 2222, run as root the way a device's is, with one account, `fathomro`,
# whose every command goes to `reader-fake-device.sh`: that prints a Junos set-form or an EOS
# config, each with a password hash of a real length, for exactly the commands a device would
# answer, and refuses anything else. Password and Ed25519 key logins both work; nothing else does.
# A second account, `fathomcut`, is a device whose connection dies part way through its answer.
#
# Usage (as root): scripts/ci/reader-sshd.sh DIR   # writes DIR/host_ed25519.pub, DIR/client_ed25519
set -eu
DIR=$1
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$DIR"
id fathomro >/dev/null 2>&1 || useradd -m -s /bin/sh fathomro
echo 'fathomro:read-only-pw-7Qx' | chpasswd
id fathomcut >/dev/null 2>&1 || useradd -m -s /bin/sh fathomcut
echo 'fathomcut:read-only-pw-7Qx' | chpasswd
install -m 0755 "$HERE/reader-fake-device.sh" /usr/local/bin/fathom-fake-device
# Two lines, then the connection dies: it kills the sshd process that carries its own session.
cat > /usr/local/bin/fathom-cut-device <<'CUT'
#!/bin/sh
echo "set system host-name srx-lab"
echo "set system services ssh"
sleep 1
ps -u "$(id -u)" -o pid= -o comm= | awk '$2 ~ /^sshd/ {print $1}' | xargs -r kill -9
CUT
chmod 0755 /usr/local/bin/fathom-cut-device
# What the fake device was asked: written by `fathomro`, read and emptied by the test's user.
install -m 0666 /dev/null /tmp/fathom-fake-device.log
rm -f "$DIR/host_ed25519" "$DIR/client_ed25519"
ssh-keygen -q -t ed25519 -N '' -f "$DIR/host_ed25519"
ssh-keygen -q -t ed25519 -N '' -f "$DIR/client_ed25519"
install -d -m 0700 -o fathomro /home/fathomro/.ssh
install -m 0600 -o fathomro "$DIR/client_ed25519.pub" /home/fathomro/.ssh/authorized_keys
chmod 0644 "$DIR/client_ed25519"
mkdir -p /run/sshd
cat > "$DIR/sshd_config" <<CONF
Port 2222
HostKey $DIR/host_ed25519
PasswordAuthentication yes
KbdInteractiveAuthentication no
PubkeyAuthentication yes
UsePAM yes
AllowUsers fathomro fathomcut
PermitTTY no
AllowTcpForwarding no
AllowAgentForwarding no
X11Forwarding no
ForceCommand /usr/local/bin/fathom-fake-device
PidFile $DIR/sshd.pid
Match User fathomcut
    ForceCommand /usr/local/bin/fathom-cut-device
CONF
/usr/sbin/sshd -f "$DIR/sshd_config" -E "$DIR/sshd.log"
