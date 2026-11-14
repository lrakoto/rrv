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

[[ -f "$build_dir/index.html" && -d "$build_dir/assets" && -f "$build_dir/portal/index.html" && -f "$build_dir/portal/api.php" ]] ||
  fail 'Build the website and portal with npm run build first.'
[[ -z $(find "$build_dir/index.html" "$build_dir/assets" "$build_dir/portal" ! -type f ! -type d -print) ]] ||
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
account_dir="/home/$(id -un)"
domain="$account_dir/public_html/threeohfivestudios.com"
target="$domain/rrv"
test "$HOME" = "$account_dir"
test -d "$domain"
test ! -L "$account_dir/public_html"
test ! -L "$domain"
test ! -L "$target"

exec 9>"$account_dir/.rrv-deploy.lock"
flock -x -w 30 9
stage=$(mktemp -d "$account_dir/.rrv-release.XXXXXXXX")
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
test ! -L "$target/index.html"
for subtree in assets portal; do
  test ! -L "$target/$subtree"
  if [ -d "$target/$subtree" ]; then
    test -z "$(find "$target/$subtree" -type l -print -quit)"
  fi
done
php -r 'exit(PHP_VERSION_ID < 80100 || !extension_loaded("pdo_sqlite") || !extension_loaded("fileinfo"));'
for source in "$stage/portal/api.php" "$stage"/portal/lib.*/*.php; do
  php -l "$source"
done
rsync -rp --checksum --chmod=D755,F644 -- "$stage/assets/" "$target/assets/"
mkdir -p -- "$target/portal"
# Install versioned helpers before the API, then update the portal shell.
rsync -rp --checksum --chmod=D755,F644 --exclude=/api.php --exclude=/index.html -- "$stage/portal/" "$target/portal/"
rsync -p --checksum --chmod=F644 -- "$stage/portal/api.php" "$target/portal/api.php"
rsync -p --checksum --chmod=F644 -- "$stage/portal/index.html" "$target/portal/index.html"
next_index=$(mktemp "$target/.rrv-index.XXXXXXXX")
install -m 644 -- "$stage/index.html" "$next_index"
mv -fT -- "$next_index" "$target/index.html"
next_index=''
REMOTE
)
  COPYFILE_DISABLE=1 tar -C "$build_dir" -cf - index.html assets portal |
    ssh "${ssh_options[@]}" "$ssh_host" "$remote_script"
fi

scratch=$(mktemp -d "${TMPDIR:-/tmp}/rrv-verify.XXXXXXXX")
trap 'rm -rf -- "$scratch"' EXIT

fetch() {
  curl --fail --silent --show-error --location --max-time 15 \
    --proto-redir '=https' --output "$2" --write-out '%{content_type}' "$1"
}

verify_live() {
  local html_type css_type hero_type portal_type session_type
  html_type=$(fetch "$site_url" "$scratch/index.html") && [[ $html_type == text/html* ]] &&
    grep -Fq "<meta name=\"rrv-release\" content=\"$release\">" "$scratch/index.html" &&
    grep -Fq "$css" "$scratch/index.html" && grep -Fq "$hero" "$scratch/index.html" &&
    css_type=$(fetch "$site_url${css#./}" "$scratch/site.css") && [[ $css_type == text/css* ]] &&
    cmp -s "$build_dir/$css" "$scratch/site.css" &&
    hero_type=$(fetch "$site_url${hero#./}" "$scratch/hero.webp") && [[ $hero_type == image/webp* ]] &&
    cmp -s "$build_dir/$hero" "$scratch/hero.webp" &&
    portal_type=$(fetch "${site_url}portal/" "$scratch/portal.html") && [[ $portal_type == text/html* ]] &&
    grep -Fq "<meta name=\"rrv-release\" content=\"$release\">" "$scratch/portal.html" &&
    session_type=$(fetch "${site_url}portal/api.php?action=session" "$scratch/session.json") && [[ $session_type == application/json* ]] &&
    grep -Eq '"user":null.*"csrf":"[a-f0-9]+' "$scratch/session.json"
}

for attempt in 1 2 3 4 5; do
  if verify_live; then
    printf 'Verified %s (release %s), stylesheet, hero image and portal session.\n' "$site_url" "$release"
    exit 0
  fi
  if [[ $attempt -lt 5 ]]; then sleep 3; fi
done
fail "Could not verify release $release at $site_url. Check the origin and Cloudflare cache for this URL."
