# Hosting RRV

RRV lives at [threeohfivestudios.com/rrv/](https://threeohfivestudios.com/rrv/). GoDaddy serves it from the cPanel account’s `public_html/threeohfivestudios.com/rrv/` folder. The client and owner portal runs under `/rrv/portal/`.

## Publish to GoDaddy

Configure an `rrv-godaddy` alias in `~/.ssh/config` with the GoDaddy origin hostname, cPanel user, and authorized key.

```sshconfig
Host rrv-godaddy
    HostName <GoDaddy-origin-hostname>
    User <cPanel-user>
    IdentityFile <path-to-authorized-SSH-key>
```

The script uses the server’s trusted SSH host key. If your verified host key is stored under a different name in `~/.ssh/known_hosts`, add `HostKeyAlias` to the alias. You can also set `RRV_GODADDY_HOST`, `RRV_GODADDY_KEY`, and `RRV_GODADDY_HOST_KEY_ALIAS` when invoking the script.

```sh
npm run check
bash scripts/deploy-godaddy.sh
```

The script copies assets and PHP helpers before updating the public pages, then verifies the public website and portal session. It leaves the private database in place. If Cloudflare serves an older page, purge the two exact page URLs and rerun `bash scripts/deploy-godaddy.sh --verify-only`. Keep the portal API out of any CDN cache rules.

## Set up the owner

On GoDaddy, portal data lives in `$HOME/.rrv-data/`. Run the CLI setup script on the same server as the portal and give it the owner’s sign-in email. Run it from a private path or feed it over SSH using `php /dev/stdin`. The script does not go in the release folder.

```sh
php scripts/setup-owner.php "$HOME/.rrv-data" owner@example.com https://threeohfivestudios.com/rrv/portal/
```

Open the private link the command prints and choose a password. The link expires after 24 hours and stops working after activation. Running the command again before activation replaces the previous link. The same command accepts a loopback HTTP portal URL and an absolute local data directory for testing.

In **Accès client**, create a link and share it privately with the client. An invitation works once and expires after seven days. The client chooses a password, then signs in using the address on their record. Revoking access ends existing client sessions. The owner can issue a new invite if a client loses access. Issuing a new invite for an active client replaces their current login.

Progress and progress notes are visible to the client. Tasks, contracts, and permits stay private until the owner selects **Visible par le client** for each item. Attachments use PDF and have an 8 MiB limit.

## Move to another host

The complete site needs HTTPS and PHP 8.1 or newer with PDO_SQLite and Fileinfo. Set `RRV_DATA_DIR` in the PHP service environment to an absolute, persistent directory outside all web roots. PHP needs to own the directory with mode `0700`. Configure the web server to serve `index.html` and normalize directory URLs to end in `/`. On servers that do not use Apache `.htaccess`, deny web access to the `portal/lib.*` directories, disable directory listings, and bypass caching for `portal/api.php`.

1. Build the site and upload the contents of `dist/`. Relative asset URLs work at the domain root or in a subdirectory.
2. Create a consistent SQLite backup of `portal.sqlite` while signed into the host shell. The database includes the client records, password hashes, and PDFs.
3. During cutover, stop writes on the old portal, take a final backup, then restore it as `portal.sqlite` in the new private directory. Use mode `0600`. Sessions are generated on the new host and users sign in again. Issue fresh invitation links using the new address.
4. Verify owner login, a client login, and a document download before retiring the old host.

For example, on GoDaddy with `sqlite3` installed, write a fresh snapshot in the private directory:

```sh
cd "$HOME/.rrv-data"
umask 077
sqlite3 portal.sqlite '.backup portal-backup.sqlite'
```

The marketing site can also run separately on a static host. Use `npm run build:static` to produce a public-only release.
