# RRV

Standalone website for a construction contractor in Madagascar. French is the default, with Malagasy and English available in the language selector.

Serve the contents of `public/` on any static host. There are no runtime dependencies or server-side services. Relative asset paths let the same files work at a domain root or in a directory like `/rrv/`.

```sh
python3 -m http.server 8000 --directory public
```

Open `http://localhost:8000/` for a local preview. Published illustrations are labeled as such and do not depict verified RRV projects.

The project form creates a brief in the visitor’s browser. Set the real public inquiry email in `public/assets/config.js` to add a direct email link and let visitors open their brief in their own mail app. No information is transmitted from the form itself.
