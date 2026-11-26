#!/bin/sh
# Builds OpenClaw from its own source. Used by .github/workflows/build-images.yml (and works locally: sh prepare.sh /tmp/oc && docker build /tmp/oc).
#   1. checks out the upstream release in OPENCLAW_REF (a tag, never a moving branch) into the folder given as $1,
#   2. adds our startup files (joolz/) next to it,
#   3. appends our Dockerfile (a final stage that starts FROM upstream's own `openclaw-runtime` stage) to upstream's Dockerfile.
# Upstream's Dockerfile is used as it is, so the build is the one the OpenClaw project tests; only the last stage is ours.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out=${1:?usage: prepare.sh <output folder>}
ref=$(tr -d ' \r\n' < "$here/OPENCLAW_REF")
rm -rf "$out"
git clone --quiet --depth 1 --branch "$ref" https://github.com/openclaw/openclaw.git "$out"
rm -rf "$out/.git"
mkdir -p "$out/joolz"
cp "$here"/joolz/* "$out/joolz/"
{ printf '\n'; cat "$here/Dockerfile"; } >> "$out/Dockerfile"
echo "OpenClaw $ref prepared in $out"
