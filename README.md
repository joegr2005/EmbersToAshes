# Embers to Ash — website

A self-contained static recreation of [emberstoash.com](https://emberstoash.com/).

The original is a GoDaddy Website Builder site. This copy reproduces every page
with the same markup and styling, but with all fonts and images localized and all
GoDaddy runtime/tracking scripts removed, so it renders identically and works
offline / on any static host.

## Pages

| Route                 | File                     |
| --------------------- | ------------------------ |
| `/` and `/welcome`    | `index.html` / `welcome.html` |
| `/get-to-know-us`     | `get-to-know-us.html`    |
| `/the-shocking-truth` | `the-shocking-truth.html`|
| `/facts`              | `facts.html`             |

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

## Local preview

Because routes are extension-less, preview through a static server rather than
opening the files directly:

```bash
npm run dev   # vercel dev
```

## Deploy

Hosted on Vercel. Pushes to `main` on GitHub trigger automatic deployments.
