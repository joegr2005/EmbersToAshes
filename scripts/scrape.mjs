// scripts/scrape.mjs
//
// Mirrors https://emberstoash.com/ into a self-contained static site.
//
// What it does:
//   1. Fetches each page's server-rendered HTML.
//   2. Downloads every referenced font (Google fonts via GoDaddy CDN) and
//      every image (GoDaddy "isteam"/getty CDN) one time each.
//   3. Rewrites all CDN URLs to local /assets/... paths.
//   4. Strips GoDaddy runtime JS + the service-worker registration so the
//      copy renders identically offline with no external calls.
//   5. Injects a tiny script to keep the mobile nav drawer, "More" dropdown
//      and cookie banner interactive.
//   6. Emits <route>.html (+ index.html), manifest.webmanifest and vercel.json.
//
// Run from the project root:  node scripts/scrape.mjs
//
// No third-party dependencies (uses Node 18+ global fetch).

import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '..');
const ASSET_DIR = path.join(OUT, 'assets');
const FONT_DIR = path.join(ASSET_DIR, 'fonts');
const IMG_DIR = path.join(ASSET_DIR, 'img');

const ORIGIN = 'https://emberstoash.com';
const PAGES = [
  { route: 'welcome', home: true },
  { route: 'get-to-know-us' },
  { route: 'the-shocking-truth' },
  { route: 'facts' },
];

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return await res.text();
}

async function fetchBuf(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return {
    ct: res.headers.get('content-type') || '',
    buf: Buffer.from(await res.arrayBuffer()),
  };
}

function extOf(ct, fallback = 'jpg') {
  ct = ct.toLowerCase();
  if (ct.includes('png')) return 'png';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('gif')) return 'gif';
  if (ct.includes('svg')) return 'svg';
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  return fallback;
}

function reEsc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Small runtime injected into every page to preserve interactivity that the
// (removed) GoDaddy bundle used to provide.
const CUSTOM_JS = `
(function(){
  function q(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s));}
  // Open mobile navigation drawer
  q('a[toggleId]').forEach(function(btn){
    btn.addEventListener('click', function(e){
      e.preventDefault();
      var d=document.getElementById(btn.getAttribute('toggleId'));
      if(d){ d.style.transform='translateX(0)'; d.style.visibility='visible'; }
    });
  });
  // Close mobile navigation drawer
  q('[data-close="true"]').forEach(function(el){
    el.addEventListener('click', function(){
      var d=el.closest('[data-ux="NavigationDrawer"]');
      if(d){ d.style.transform='translateX(-249vw)'; d.style.visibility='hidden'; }
    });
  });
  // Toggle "More" dropdown menus
  q('a[data-ux="NavLinkDropdown"]').forEach(function(btn){
    btn.addEventListener('click', function(e){
      e.preventDefault();
      var menu=btn.parentNode.querySelector('ul[role="menu"]');
      if(menu){ menu.style.display=(menu.style.display==='block'?'none':'block'); }
    });
  });
  // Reveal + dismiss cookie banner
  var banner=document.querySelector('[id$="-banner"]');
  if(banner){
    setTimeout(function(){ banner.style.bottom='24px'; }, 500);
    var acc=document.querySelector('[id$="-accept"]');
    if(acc){ acc.addEventListener('click', function(e){ e.preventDefault(); banner.style.display='none'; }); }
  }
  // Static mirror: prevent dead form submissions from reloading the page
  q('form').forEach(function(f){ f.addEventListener('submit', function(e){ e.preventDefault(); }); });
})();
`.trim();

async function main() {
  await mkdir(FONT_DIR, { recursive: true });
  await mkdir(IMG_DIR, { recursive: true });

  // 1) Fetch all pages.
  const pages = [];
  for (const p of PAGES) {
    const url = `${ORIGIN}/${p.route}`;
    console.log('page  ', url);
    pages.push({ ...p, html: await fetchText(url) });
  }
  const allHtml = pages.map((p) => p.html).join('\n');

  // 2) Fonts (one file per unique URL).
  const fontUrls = new Set(
    allHtml.match(/https:\/\/img1\.wsimg\.com\/gfonts\/[^\s"')]+\.woff2/g) || []
  );
  const fontMap = new Map();
  for (const u of fontUrls) {
    const name = u.split('/').pop().split('?')[0];
    const { buf } = await fetchBuf(u);
    await writeFile(path.join(FONT_DIR, name), buf);
    fontMap.set(u, `/assets/fonts/${name}`);
    console.log('font  ', name, buf.length + 'b');
  }

  // 3) Images (collapse every transform variant of a base path to one file).
  const imgUrls = new Set(
    allHtml.match(/(?:https:)?\/\/(?:img1|isteam)\.wsimg\.com\/isteam\/[^\s"')]+/g) || []
  );
  const baseSet = new Set();
  for (const u of imgUrls) baseSet.add(u.split('/:/')[0]);

  const imgMap = new Map(); // protocol-relative base -> local public path
  for (const baseRaw of baseSet) {
    const base = baseRaw.startsWith('http') ? baseRaw : 'https:' + baseRaw;
    let got;
    try {
      got = await fetchBuf(base + '/:/rs=w:1600'); // request a high-res render
    } catch {
      got = await fetchBuf(base);
    }
    const ext = extOf(got.ct);
    let name;
    const m = base.match(/getty\/(\d+)/);
    if (m) name = `getty-${m[1]}.${ext}`;
    else if (base.includes('logo-default')) name = `icon.${ext}`;
    else if (base.includes('transparent_placeholder')) name = `placeholder.${ext}`;
    else name = `img-${createHash('sha1').update(base).digest('hex').slice(0, 10)}.${ext}`;
    await writeFile(path.join(IMG_DIR, name), got.buf);
    imgMap.set(baseRaw.replace(/^https:/, ''), `/assets/img/${name}`);
    console.log('image ', name, got.buf.length + 'b');
  }

  // 4) Rewrite + write each page.
  for (const p of pages) {
    let html = p.html;

    // Localize fonts.
    for (const [u, local] of fontMap) html = html.split(u).join(local);

    // Localize images: base + optional /:/transform, with or without https:
    for (const [baseRel, local] of imgMap) {
      const re = new RegExp('(?:https:)?' + reEsc(baseRel) + "(?:/:/[^\\s\"')]*)?", 'g');
      html = html.replace(re, local);
    }

    // Remove GoDaddy runtime scripts + service-worker registration.
    html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    html = html.replace(/<script\b[^>]*\/>/gi, '');

    // Inject our small interactivity shim.
    html = html.replace('</body>', `<script>${CUSTOM_JS}</script></body>`);

    await writeFile(path.join(OUT, `${p.route}.html`), html, 'utf8');
    if (p.home) await writeFile(path.join(OUT, 'index.html'), html, 'utf8');
    console.log('wrote ', p.route + '.html' + (p.home ? ' (+ index.html)' : ''));
  }

  // 5) Aux files.
  const iconPath =
    [...imgMap.values()].find((v) => v.includes('/icon.')) || '/assets/img/icon.png';

  const manifest = {
    scope: '/',
    start_url: '/',
    display: 'standalone',
    icons: [
      { sizes: '192x192', type: 'image/png', src: iconPath },
      { sizes: '512x512', type: 'image/png', src: iconPath },
    ],
    name: 'Embers to Ash',
    short_name: 'Embers to Ash',
    theme_color: '#d1bebe',
    background_color: '#d1bebe',
  };
  await writeFile(
    path.join(OUT, 'manifest.webmanifest'),
    JSON.stringify(manifest, null, 2)
  );

  // framework:null + cleanUrls so /welcome serves welcome.html (matches the
  // original site URLs) and Vercel performs no build step.
  await writeFile(
    path.join(OUT, 'vercel.json'),
    JSON.stringify({ framework: null, cleanUrls: true, trailingSlash: false }, null, 2)
  );

  console.log('\nDone: ' + pages.length + ' pages, ' + fontMap.size + ' fonts, ' + imgMap.size + ' images.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
