#!/usr/bin/env bash
# Print compose.yaml with Fathom's own images pinned by digest.
#
#   pin-compose.sh <release tag> <40-hex commit> <compose.yaml>  > compose.pinned.yaml
#
# Written 2026-11-02 for release.yml's `pinned-compose` job. compose.yaml
# already pins every image somebody else builds by digest; Fathom's three are
# named by `${FATHOM_TAG:-latest}` so a host follows `main`. This rewrites
# those three lines to `name:<tag>@sha256:<digest>`, so every image in the
# printed file is a hash.
#
# Each digest is read from the registry twice, under the release tag and under
# `sha-<commit>` (the tag publish.yml pushed after the gate floor), and the two
# must match: the release tag has to name the image main tested and attested.
# Any image that is missing, or any line left unpinned, is an error and nothing
# is printed.
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <release tag> <40-hex commit> <compose.yaml>" >&2
  exit 2
fi
tag=$1 commit=$2 compose=$3

printf '%s' "$tag" | grep -Eq '^v[A-Za-z0-9_.-]{1,127}$' \
  || { echo "'$tag' is not a usable image tag" >&2; exit 1; }
printf '%s' "$commit" | grep -Eq '^[0-9a-f]{40}$' \
  || { echo "'$commit' is not a 40-hex commit" >&2; exit 1; }

registry=ghcr.io/keyxmakerx
images=(fathom-server fathom-backup fathom-passbolt-helper)

digest_of() {
  local out d
  out=$(docker buildx imagetools inspect "$1" 2>&1) \
    || { echo "cannot read $1: $out" >&2; return 1; }
  d=$(printf '%s\n' "$out" | awk '$1 == "Digest:" { print $2; exit }')
  printf '%s' "$d" | grep -Eq '^sha256:[0-9a-f]{64}$' \
    || { echo "no digest for $1" >&2; return 1; }
  printf '%s' "$d"
}

text=$(cat "$compose")
for name in "${images[@]}"; do
  at_tag=$(digest_of "$registry/$name:$tag")
  at_commit=$(digest_of "$registry/$name:sha-$commit")
  if [ "$at_tag" != "$at_commit" ]; then
    echo "$name:$tag is $at_tag but sha-$commit is $at_commit" >&2
    exit 1
  fi
  # The line is `image: <registry>/<name>:${FATHOM_TAG:-latest}${<VAR>:+@${<VAR>}}`.
  # Only that exact shape is rewritten; anything else is left and caught below.
  pattern="^([[:space:]]*image:[[:space:]]*)${registry//./\\.}/${name}:\\$\\{FATHOM_TAG:-latest\\}\\$\\{[A-Z_]+:\\+@\\$\\{[A-Z_]+\\}\\}[[:space:]]*$"
  text=$(printf '%s\n' "$text" | sed -E "s|${pattern}|\\1${registry}/${name}:${tag}@${at_commit}|")
  printf '%s\n' "$text" | grep -Eq "^[[:space:]]*image:[[:space:]]*${registry//./\\.}/${name}:${tag}@${at_commit}$" \
    || { echo "compose.yaml has no image line for $name in the expected shape" >&2; exit 1; }
done

# Every `image:` line that is not a comment must now carry a digest.
if printf '%s\n' "$text" | grep -E '^[[:space:]]*image:' | grep -vq '@sha256:[0-9a-f]\{64\}'; then
  echo "an image line is still unpinned:" >&2
  printf '%s\n' "$text" | grep -E '^[[:space:]]*image:' | grep -v '@sha256:' >&2
  exit 1
fi

cat <<HEAD
# compose.pinned.yaml -- Fathom $tag, commit $commit.
# Written by .github/workflows/release.yml from that commit's compose.yaml.
# Every image below is pinned by digest, Fathom's own three included, so this
# stack runs exactly these bytes until you replace the file. FATHOM_TAG and the
# FATHOM_*_DIGEST lines in .env no longer apply to it.
#
HEAD
printf '%s\n' "$text"
