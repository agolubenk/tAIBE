#!/usr/bin/env bash
# Packs the linux/amd64 image and the VPS files into one archive for a manual
# delivery (the fork is never pushed, so no CI deploys it).
# Usage: deploy/vps/bundle.sh <image-tag> <out-dir>
set -euo pipefail

# Since the split (02.11) this tree is tAIBE, also reached from the host as
# t-boards/app. Since 03.11 the d4dev stand runs images built from here
# (process/TRANSFER.md «Стенд d4dev»).

tag="${1:?image tag, e.g. 3eacffa-b1}"
out="${2:?output directory}"
app="$(cd "$(dirname "$0")/../.." && pwd)"
vps="$app/deploy/vps"

arch="$(docker image inspect -f '{{.Architecture}}' "t-boards:$tag")"
[ "$arch" = amd64 ] || {
  echo "t-boards:$tag is $arch, the VPS needs amd64" >&2
  exit 1
}

stage="$(mktemp -d "$out/.bundle-XXXXXX")"
trap 'rm -rf "$stage"' EXIT
name="t-boards-$tag"
mkdir "$stage/$name"

cp "$vps/compose.yml" "$vps/tls.conf.template" "$vps/backup.sh" \
  "$vps/install.sh" "$vps/render-tls.sh" "$vps/wg-setup.sh" "$vps/wg-issue.sh" "$vps/wg-psk.sh" "$vps/backup-key.sh" "$vps/mirror-setup.sh" "$vps/mem-stats.sh" \
  "$stage/$name/"
mkdir "$stage/$name/seed"
cp "$vps/seed/products.json" "$stage/$name/seed/"
commit="$(git -C "$app" rev-parse --short HEAD)"
git -C "$app" diff --quiet HEAD -- || commit="$commit+dirty"
migrations="$(node -e "process.stdout.write(String(require(process.argv[1]).entries.length))" \
  "$app/apps/api/drizzle/meta/_journal.json")"
printf 'TB_TAG=%s\nTB_COMMIT=%s\nTB_MIGRATIONS=%s\n' "$tag" "$commit" "$migrations" >"$stage/$name/VERSION"
docker save "t-boards:$tag" | gzip -1 >"$stage/$name/image.tar.gz"

# No macOS xattrs: GNU tar on the VPS warns on every LIBARCHIVE.xattr header.
COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata -C "$stage" -cf "$out/$name.tar" "$name"
(cd "$out" && shasum -a 256 "$name.tar" >"$name.tar.sha256")
ls -l "$out/$name.tar"
cat "$out/$name.tar.sha256"
