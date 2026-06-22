# Embers to Ash — website

A self-contained static recreation of [emberstoash.com](https://emberstoash.com/).

This is a self-contained static copy that reproduces every page with the same
markup and styling, but with all fonts and images localized and the original
builder's runtime/tracking scripts removed, so it renders identically and works
offline / on any static host.

## Pages

| Route                 | File                     |
| --------------------- | ------------------------ |
| `/` and `/welcome`    | `index.html` / `welcome.html` |
| `/get-to-know-us`     | `get-to-know-us.html`    |
| `/the-shocking-truth` | `the-shocking-truth.html`|
| `/facts`              | `facts.html`             |
| `/privacy-policy`     | `privacy-policy.html`    |

`vercel.json` enables `cleanUrls`, so the original extension-less URLs
(`/welcome`, `/facts`, ...) work exactly as on the source site.

## Assets

- `assets/fonts/` — Dancing Script, Cantarell and Cinzel (woff2)
- `assets/img/` — hero/section photos, PWA icon, placeholder

## Regenerate

The site is produced by a dependency-free Node script that scrapes the live
source and localizes every asset:

```bash
node scripts/scrape.mjs
```

Requires Node 18+ (uses the global `fetch`).

## Deploy

Hosted on Vercel. Pushes to `main` on GitHub trigger automatic deployments.
