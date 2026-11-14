#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
site_url=https://threeohfivestudios.com/rrv/
verify_only=false
if [[ ${1:-} == --verify-only ]]; then
  verify_only=true
  shift
fi
if [[ $# -gt 1 || ${1:-} == -* ]]; then
  printf 'Usage: %s [--verify-only] [dist-directory]\n' "$0" >&2
  exit 2
fi
build_dir=${1:-"$repo_dir/dist"}

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

[[ -f "$build_dir/index.html" && -d "$build_dir/assets" ]] || fail 'Build dist/ with npm run build first.'
[[ -z $(find "$build_dir/index.html" "$build_dir/assets" ! -type f ! -type d -print) ]] ||
  fail 'The release must contain only regular files and directories.'

release=$(sed -nE 's/.*<meta name="rrv-release" content="([a-f0-9]{16})">.*/\1/p' "$build_dir/index.html")
[[ $release =~ ^[a-f0-9]{16}$ ]] || fail 'The index is missing a valid RRV release fingerprint.'
css=$(grep -Eo '\./assets/site\.[a-f0-9]{12}\.css' "$build_dir/index.html") || fail 'The index is missing the fingerprinted stylesheet.'
hero=$(grep -Eo '\./assets/construction-highlands\.[a-f0-9]{12}\.webp' "$build_dir/index.html") || fail 'The index is missing the fingerprinted hero image.'
[[ -f "$build_dir/$css" && -f "$build_dir/$hero" ]] || fail 'The stylesheet or hero image is missing from the build.'

if [[ $verify_only == false ]]; then
  ssh_host=${RRV_GODADDY_HOST:-rrv-godaddy}
  [[ $ssh_host =~ ^[a-zA-Z0-9][a-zA-Z0-9._@-]*$ ]] || fail 'Set RRV_GODADDY_HOST to an SSH alias or user@host.'
  ssh_options=(-T -o BatchMode=yes -o ConnectTimeout=10 -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes)
  if [[ -n ${RRV_GODADDY_KEY:-} ]]; then
    [[ -f "$RRV_GODADDY_KEY" ]] || fail 'RRV_GODADDY_KEY must point to the authorized GoDaddy SSH key.'
    ssh_options+=(-i "$RRV_GODADDY_KEY")
  fi
  if [[ -n ${RRV_GODADDY_HOST_KEY_ALIAS:-} ]]; then
    ssh_options+=(-o "HostKeyAlias=$RRV_GODADDY_HOST_KEY_ALIAS")
  fi

  # Stage in the account's private home. Update assets before replacing the
  # index so both the current page and the new page can load during publication.
  remote_script=$(cat <<'REMOTE'
set -eu
home="/home/$(id -un)"
domain="$home/public_html/threeohfivestudios.com"
target="$domain/rrv"
test "$HOME" = "$home"
test -d "$domain"
test ! -L "$home/public_html"
test ! -L "$domain"
test ! -L "$target"

exec 9>"$home/.rrv-deploy.lock"
flock -x -w 30 9
stage=$(mktemp -d "$home/.rrv-release.XXXXXXXX")
next_index=''
cleanup() {
  if [ -n "$next_index" ]; then rm -f -- "$next_index"; fi
  rm -rf -- "$stage"
}
trap cleanup EXIT
tar -xf - -C "$stage"

if [ ! -e "$target" ]; then mkdir -m 755 -- "$target"; fi
test -d "$target"
test ! -L "$target"
test ! -L "$target/assets"
test ! -L "$target/index.html"
if [ -d "$target/assets" ]; then
  test -z "$(find "$target/assets" -type l -print -quit)"
fi
rsync -rp --checksum --chmod=D755,F644 -- "$stage/assets/" "$target/assets/"
next_index=$(mktemp "$target/.rrv-index.XXXXXXXX")
install -m 644 -- "$stage/index.html" "$next_index"
mv -fT -- "$next_index" "$target/index.html"
next_index=''
REMOTE
)
  COPYFILE_DISABLE=1 tar -C "$build_dir" -cf - index.html assets |
    ssh "${ssh_options[@]}" "$ssh_host" "$remote_script"
fi

scratch=$(mktemp -d "${TMPDIR:-/tmp}/rrv-verify.XXXXXXXX")
trap 'rm -rf -- "$scratch"' EXIT

fetch() {
  curl --fail --silent --show-error --location --max-time 15 \
    --proto-redir '=https' --output "$2" --write-out '%{content_type}' "$1"
}

verify_live() {
  local html_type css_type hero_type
  html_type=$(fetch "$site_url" "$scratch/index.html") && [[ $html_type == text/html* ]] &&
    grep -Fq "<meta name=\"rrv-release\" content=\"$release\">" "$scratch/index.html" &&
    grep -Fq "$css" "$scratch/index.html" && grep -Fq "$hero" "$scratch/index.html" &&
    css_type=$(fetch "$site_url${css#./}" "$scratch/site.css") && [[ $css_type == text/css* ]] &&
    cmp -s "$build_dir/$css" "$scratch/site.css" &&
    hero_type=$(fetch "$site_url${hero#./}" "$scratch/hero.webp") && [[ $hero_type == image/webp* ]] &&
    cmp -s "$build_dir/$hero" "$scratch/hero.webp"
}

for attempt in 1 2 3 4 5; do
  if verify_live; then
    printf 'Verified %s (release %s), stylesheet and hero image.\n' "$site_url" "$release"
    exit 0
  fi
  if [[ $attempt -lt 5 ]]; then sleep 3; fi
done
fail "Could not verify release $release at $site_url. Check the origin and Cloudflare cache for this URL."
