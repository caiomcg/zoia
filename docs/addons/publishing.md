# Publishing an addon

Zoia installs from **your GitHub repository's latest release**. A release needs two things:

1. **An image on ghcr.io**, under the repository's own owner
   (`ghcr.io/<owner>/<anything>`), **public**: the addon host pulls without credentials.
2. **`zoia-addon.json`** attached to the release, naming that image **by digest**.

## Step by step

Start from [example/](example/), Echo:

```
your-addon/
  Dockerfile
  zoia-addon.json        # image left as a placeholder; the workflow fills it in
  src/...
  .github/workflows/release.yml   # example/release.yml
```

1. Write your addon. Run it locally against a Zoia server with an addon installed by hand,
   setting `ZOIA_URL` and `ZOIA_ADDON_TOKEN` yourself.
2. Copy `example/release.yml` to `.github/workflows/release.yml`. On a `v*` tag it builds
   the image, pushes it, writes the digest and the version into `zoia-addon.json`, and
   publishes the release with it attached.
3. Tag a version: `git tag v1.0.0 && git push --tags`.
4. **The first time only:** ghcr.io makes a new package private. Open it on GitHub
   (your profile › Packages › the package › Package settings) and change its visibility to
   public. Later versions keep it.
5. Tell the super admin your repository. They install it from Settings › Addons.

## The rules a release is held to

The server refuses a release, and says why, when:

- it has no `zoia-addon.json` asset, or the file is over 64 KB or not JSON;
- anything in it breaks [manifest.md](manifest.md), such as an image by tag;
- the image's owner is not the repository's owner (case aside);
- it is an update whose `id` differs from the installed addon's.

Between the super admin's preview and their yes, the server reads the release again; if a
newer one appeared meanwhile, it asks them to look again.

## Image tips

- Write only to `/tmp`: the root filesystem is read-only. Point caches there
  (`XDG_CACHE_HOME=/tmp/cache`, `HOME=/tmp`).
- Run as a non-root user (`USER node`); you have no capabilities anyway.
- Build for `linux/amd64`.
- Log to standard output: the super admin reads it under the addon's logs.
- Exit on a fatal error; the host starts you again.
