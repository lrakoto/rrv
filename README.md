# RRV

Construction website and private project portal for RRV in Madagascar. The public site is available in French, Malagasy, and English. The portal is in French.

```sh
npm run check
npm run preview
```

The build uses Node.js built-ins. The portal needs PHP 8.1 or newer with PDO_SQLite and Fileinfo. Set `PHP_BIN` if your PHP executable is outside your PATH. The preview listens on `http://127.0.0.1:8000/` and keeps its database under the ignored `.rrv-local/` folder.

The [owner and client portal](https://threeohfivestudios.com/rrv/portal/) lets the owner manage client projects, progress updates, tasks, contracts, permits, attachments, and client invitations. See the [hosting guide](docs/hosting.md) for owner setup, deployment, and migration.

The public project form prepares a brief in the visitor’s browser. Visitors can copy it or open a draft in their email app. Edit [public/assets/config.js](public/assets/config.js) to change the public inbox, then rebuild and deploy.

For the public site alone, run `npm run build:static` and publish `dist/` to any static host. The [illustrative imagery](docs/imagery.md) does not depict verified RRV projects.
