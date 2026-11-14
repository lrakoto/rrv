# Hosting RRV

RRV publishes at [threeohfivestudios.com/rrv/](https://threeohfivestudios.com/rrv/). Monolith's `DEPLOY.md` documents the GoDaddy cPanel account, its WordPress document root and Cloudflare in front of the domain. An existing directory is served directly. RRV's directory is `public_html/threeohfivestudios.com/rrv/` under the cPanel account's home.

## Publish to GoDaddy

Configure an `rrv-godaddy` alias in `~/.ssh/config` with the GoDaddy account's origin hostname, cPanel user and authorized key:

```sshconfig
Host rrv-godaddy
    HostName <GoDaddy-origin-hostname>
    User <cPanel-user>
    IdentityFile <path-to-authorized-SSH-key>
```

The script requires a trusted host key. If your verified GoDaddy host key is stored under a different name in `~/.ssh/known_hosts`, add `HostKeyAlias` to the alias. The three settings can also be passed with the `RRV_GODADDY_HOST`, `RRV_GODADDY_KEY` and `RRV_GODADDY_HOST_KEY_ALIAS` environment variables. Obtain the server's trusted host key through the hosting account when setting up a new machine.

From the RRV checkout, build and publish the release:

```sh
npm run build
bash scripts/deploy-godaddy.sh
```

The upload stays in the RRV directory. The script stages the release in the account's private home, copies assets first and replaces the index atomically. Earlier asset files are retained so someone with an older copy of the page can still load its resources. The script checks the public page for the release fingerprint and compares its stylesheet and hero image to the build.

If verification sees an older page, purge the RRV page URL with Cloudflare and rerun verification:

```sh
bash scripts/deploy-godaddy.sh --verify-only
```

cPanel File Manager or explicit FTPS also work. Upload `dist/assets/` and `dist/index.html` into the RRV directory, in that order. The FTPS account used by Monolith lands inside `public_html`, so its remote path is `/threeohfivestudios.com/rrv/`. Use the GoDaddy origin hostname from Monolith's deployment notes for FTPS because Cloudflare only fronts the public web traffic here.

## Move to another host

Run `npm run build` and upload the contents of `dist/` to the new host's document root or chosen subdirectory. Configure it to serve `index.html` as the directory index and to redirect directory URLs to a trailing slash. Asset links are relative, so the same build serves at a domain root or under a path. The runtime consists of static files. The new host does not need Node.js, WordPress or access to the GoDaddy account.
