# RRV

Standalone website for a construction contractor in Madagascar. French is the default, with Malagasy and English available in the language selector.

```sh
npm run check   # Check the scripts and build dist/
npm run preview # Serve dist/ at http://localhost:8000/
```

The build uses Node.js built-ins; no package installation is required. The preview command uses Python 3. To preview without a build, run `python3 -m http.server 8000 --directory public`.

The project form prepares a brief in the visitor’s browser. The visitor can copy it or open a draft in their email app. To update the public inbox, edit [public/assets/config.js](public/assets/config.js), rebuild, and deploy. Leaving the address blank keeps the copy option and hides the email links.

The site lives at [threeohfivestudios.com/rrv/](https://threeohfivestudios.com/rrv/). Upload the contents of `dist/` to any static host to move it. Relative URLs work at a domain root or under a folder such as `/rrv/`. There is no runtime or database to migrate. See the [hosting guide](docs/hosting.md) for the exact release and migration steps.

The [illustrative imagery](docs/imagery.md) does not depict verified RRV projects.
