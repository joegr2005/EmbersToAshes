// scripts/scrape.mjs
//
// Mirrors https://emberstoash.com/ into a self-contained static site.
//
// What it does:
//   1. Fetches each page's server-rendered HTML.
//   2. Downloads every referenced font and image from the source CDN once.
//   3. Rewrites all CDN URLs to local /assets/... paths.
//   4. Strips the builder's runtime JS + the service-worker registration.
//   5. Optimizes builder cruft: consolidates inline CSS into one cached
//      stylesheet, makes the desktop nav work without JS, and cleans the head.
//   6. Emits <route>.html (+ index.html), assets/site.css, manifest + vercel.json.
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
// Canonical URL of the deployed copy (used for og:/twitter: tags). Update this
// if you map a custom domain.
const SITE_URL = 'https://emberstoashes.vercel.app';
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
// (removed) builder bundle used to provide.
const CUSTOM_JS = `
(function(){
  function q(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s));}
  // Open the navigation drawer. The hamburger shows only on narrow screens;
  // desktop links render with CSS (no JS needed).
  q('a[toggleId]').forEach(function(btn){
    btn.addEventListener('click', function(e){
      e.preventDefault();
      var d=document.getElementById(btn.getAttribute('toggleId'));
      if(d){ d.style.transform='translateX(0)'; d.style.visibility='visible'; }
    });
  });
  // Close the navigation drawer
  q('[data-close="true"]').forEach(function(el){
    el.addEventListener('click', function(){
      var d=el.closest('[data-ux="NavigationDrawer"]');
      if(d){ d.style.transform='translateX(-249vw)'; d.style.visibility='hidden'; }
    });
  });
  // Static mirror: prevent dead form submissions from reloading the page
  q('form').forEach(function(f){ f.addEventListener('submit', function(e){ e.preventDefault(); }); });
})();
`.trim();

// Quality gate: generated pages must not contain un-localized source CDN URLs.
const forbidden = /wsimg\.com/i;

// ---- Requested content corrections ------------------------------------------

// Footer: replace the builder's "Powered by" block with our own links.
// - Privacy Policy -> local /privacy-policy page
// - Built by Gravish Digital -> dofollow backlink to gravishdigital.com
const FOOTER_LINKS =
  '<p data-ux="FooterDetails" data-typography="BodyAlpha" class="x-el x-el-p c1-1 c1-2 c1-1f c1-1g c1-4k c1-ar c1-au c1-74 c1-b c1-ap c1-c c1-2e c1-d c1-as c1-at c1-e c1-f c1-g">' +
  '<a rel="noopener" role="link" data-ux="Link" href="/privacy-policy" data-typography="LinkAlpha" class="x-el x-el-a c1-1c c1-1d c1-1e c1-1f c1-1g c1-25 c1-1h c1-b c1-av c1-c c1-1o c1-52 c1-aw c1-d c1-e c1-f c1-g">Privacy Policy</a>' +
  '<span style="padding:0 8px;color:rgb(145,145,145)">\u00b7</span>' +
  '<a rel="noopener" role="link" target="_blank" data-ux="Link" title="Gravish Digital" href="https://www.gravishdigital.com" data-typography="LinkAlpha" class="x-el x-el-a c1-1c c1-1d c1-1e c1-1f c1-1g c1-25 c1-1h c1-b c1-av c1-c c1-1o c1-52 c1-aw c1-d c1-e c1-f c1-g">Built by Gravish Digital</a></p>';

function customizeFooter(html) {
  // (1b) bump the copyright year
  html = html.replace(/(Copyright\s*(?:&copy;|\u00a9)\s*)2025/g, '$1' + '2026');
  // (1a + 1c + 1d) swap the "Powered by" block for Privacy Policy + Built by Gravish Digital
  html = html.replace(
    /<p data-ux="FooterDetails"[^>]*>\s*<span>Powered by\s*<\/span>\s*<\/p>\s*<a\b[^>]*>[\s\S]*?<\/a>/,
    FOOTER_LINKS
  );
  return html;
}

function customizeContact(html) {
  // (2) remove the reCAPTCHA notice under the contact form
  html = html.replace(
    /<div data-ux="Block"[^>]*>\s*<p data-ux="DetailsMinor"[\s\S]*?apply\.<\/p>\s*<\/div>/g,
    ''
  );
  // (6) remove the email opt-in checkbox + its "Sign up for our email list..." label
  html = html.replace(
    /<div data-ux="Block"[^>]*>\s*<label data-ux="InputCheckbox" data-aid="CONTACT_FORM_EMAIL_OPT_IN"[\s\S]*?<\/label>\s*<\/div>/g,
    ''
  );
  return html;
}

function customizeHero(html) {
  // (3) homepage hero: show "~ Purely Intentional Products ~" centered over the
  // main image, reusing the original Tagline <h1> (and its scaler spans).
  html = html.replace(/>Launching Soon/g, '>~ Purely Intentional Products ~');
  // remove the now-duplicate sub-tagline line
  html = html.replace(/<div data-ux="SubTagline"[\s\S]*?<\/div>/, '');
  return html;
}

// (1, 4, 5) Strip builder-specific artifacts and dead markup: the cookie
// pop-up + empty messaging/popup widgets, the generator meta, the free-tier
// ad placeholder, and dead click-tracking (data-tccl) attributes.
function removeBuilderArtifacts(html) {
  html = html.replace(/<meta name="generator"[^>]*>/g, '');
  html = html.replace(/<div id="freemium-ad-[^"]*"><\/div>/g, '');
  html = html.replace(/\s*data-tccl="[^"]*"/g, '');
  // remove inert hidden "scaler" spans (the builder's font-sizing runtime is
  // gone) and dead editor hooks
  html = html.replace(/<span[^>]*data-ux="scaler"[^>]*>[\s\S]*?<\/span>/g, '');
  html = html.replace(/\s*data-edit-interactive="[^"]*"/g, '');
  // normalize the stale pre-launch social-card description site-wide
  html = html.replace(
    /(<meta name="twitter:description" content=")Launching Soon\s*(")/g,
    '$1~Purely Intentional Products~$2'
  );
  // The messaging, cookie-banner and popup widgets sit contiguously at the end
  // of the page body; remove the whole block in one cut.
  const s = html.indexOf('<div id="0880055d-06ce-48b3-835c-40ea8d0dbfe5"');
  const e = html.indexOf('<div id="dd84bc14-4e97-416d-b985-9a98a3ab69a1"');
  if (s !== -1 && e !== -1) {
    const popupEnd = html.indexOf('</div>', e) + '</div>'.length;
    html = html.slice(0, s) + html.slice(popupEnd);
  } else {
    html = html.replace(
      /<div id="[0-9a-f-]+" class="widget widget-cookie-banner[\s\S]*?<\/div><\/div>/,
      ''
    );
  }
  return html;
}

// ---- Item 1 helper: split CSS into top-level rules (brace-aware) ----
function splitCssRules(css) {
  const rules = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        rules.push(css.slice(start, i + 1).trim());
        start = i + 1;
      }
    }
  }
  return rules.filter(Boolean);
}

// (2) Make the desktop nav work without JS: drop visibility:hidden (c1-2m) from
// the nav items, and delete the duplicate second nav group (the one with the
// "More" overflow). The hamburger drawer still drives narrow screens.
function customizeNav(html) {
  html = html.replace(/class="([^"]*\bnav-item\b[^"]*)"/g, function (_, cls) {
    return 'class="' + cls.replace(/\s*\bc1-2m\b/, '') + '"';
  });
  const tag = 'data-aid="HEADER_NAV_RENDERED"';
  const first = html.indexOf(tag);
  if (first !== -1) {
    const second = html.indexOf(tag, first + tag.length);
    if (second !== -1) {
      const navStart = html.lastIndexOf('<nav', second);
      const cellStart = html.lastIndexOf('<div data-ux="GridCell"', navStart);
      const navEnd = html.indexOf('</nav>', navStart);
      if (cellStart !== -1 && navEnd !== -1) {
        const cellEnd = html.indexOf('</div>', navEnd) + '</div>'.length;
        html = html.slice(0, cellStart) + html.slice(cellEnd);
      }
    }
  }
  return html;
}

// (3) Head cleanup: collapse duplicate touch icons, drop the obsolete IE meta,
// trim trailing newlines in social titles, and make canonical/social URLs
// absolute to the live site.
function cleanHead(html) {
  html = html.replace(/<link rel="apple-touch-icon"[^>]*>/g, '');
  html = html.replace('</head>', '<link rel="apple-touch-icon" href="/assets/img/icon.jpg"/></head>');
  html = html.replace(/<meta http-equiv="X-UA-Compatible"[^>]*>/g, '');
  html = html.replace(/content="Embers to Ash\s+"/g, 'content="Embers to Ash"');
  html = html.replace(/content="https:\/\/emberstoash\.com/g, 'content="' + SITE_URL);
  html = html.replace(
    /(<meta (?:property|name)="(?:og:image|twitter:image)" content=")\/assets\//g,
    '$1' + SITE_URL + '/assets/'
  );
  return html;
}

// (4) Strip inert builder attributes that no longer do anything.
function stripInertAttrs(html) {
  html = html.replace(/\s+rel=""/g, '');
  html = html.replace(/\s+target=""/g, '');
  for (const a of [
    'treatmentName', 'maxLines', 'headerTreatment', 'containerId',
    'defaultFontSize', 'data-ht', 'data-toggle-ignore', 'data-stickynav',
    'data-stickynav-wrapper', 'data-page',
  ]) {
    html = html.replace(new RegExp('\\s+' + a + '="[^"]*"', 'g'), '');
  }
  return html;
}

// Privacy Policy page content, styled to match the site (Cinzel headings,
// Cantarell body, mauve section). Conventional privacy-policy format.
const PRIVACY_STYLE = `<style>
.pp{font-family:'Cantarell',Arial,sans-serif;color:rgb(22,22,22);line-height:1.65;max-width:900px;margin:0 auto}
.pp h1{font-family:'Cinzel',Georgia,serif;font-weight:400;font-size:40px;text-align:center;margin:0 0 8px;letter-spacing:2px;text-transform:uppercase}
.pp .updated{text-align:center;margin:0 0 32px;color:rgb(70,58,58);font-size:14px}
.pp h2{font-family:'Cinzel',Georgia,serif;font-weight:400;font-size:22px;margin:28px 0 10px}
.pp p{margin:0 0 14px}
.pp ul{margin:0 0 14px;padding-left:22px}
.pp li{margin:0 0 6px}
.pp a{color:rgb(121,80,80);text-decoration:underline}
</style>`;

const PRIVACY_BODY = `
<h1>Privacy Policy</h1>
<p class="updated">Last updated: June 22, 2026</p>
<p>At Embers to Ash ("we," "us," or "our"), your privacy matters to us. This Privacy Policy explains what information we collect, how we use it, and the choices you have when you visit emberstoash.com (the "Site") or contact us.</p>
<h2>Information We Collect</h2>
<p>We collect information you provide directly to us, such as your name, email address, and any message you submit through our contact form. We also automatically collect limited technical information\u2014such as your browser type, device, and pages visited\u2014through cookies and similar technologies.</p>
<h2>How We Use Your Information</h2>
<ul>
<li>To respond to your inquiries and provide customer support.</li>
<li>To send updates, promotions, or news when you have asked to hear from us.</li>
<li>To operate, maintain, and improve the Site and our products.</li>
<li>To protect against fraud and keep the Site secure.</li>
</ul>
<h2>Cookies and Tracking Technologies</h2>
<p>We use cookies to analyze website traffic and optimize your experience. You can control cookies through your browser settings. Disabling cookies may affect how parts of the Site function.</p>
<h2>How We Share Your Information</h2>
<p>We do not sell your personal information. We may share information with trusted service providers who help us operate the Site (for example, hosting and analytics providers), and where required by law or to protect our rights.</p>
<h2>Data Security</h2>
<p>We use reasonable administrative, technical, and physical safeguards designed to protect your information. No method of transmission over the Internet is completely secure, so we cannot guarantee absolute security.</p>
<h2>Your Rights and Choices</h2>
<p>Depending on where you live, you may have the right to access, correct, or delete the personal information we hold about you, or to opt out of certain processing. To make a request, please contact us using the details below.</p>
<h2>Third-Party Links</h2>
<p>The Site may contain links to third-party websites. We are not responsible for the privacy practices or content of those sites and encourage you to review their policies.</p>
<h2>Children's Privacy</h2>
<p>The Site is not directed to children under 13, and we do not knowingly collect personal information from them. If you believe a child has provided us information, please contact us so we can remove it.</p>
<h2>Changes to This Privacy Policy</h2>
<p>We may update this Privacy Policy from time to time. Changes will be posted on this page with an updated "Last updated" date.</p>
<h2>Contact Us</h2>
<p>If you have questions about this Privacy Policy or our data practices, please reach out through the contact form on our <a href="/welcome">website</a>.</p>
`;

const PRIVACY_CONTENT =
  PRIVACY_STYLE +
  '<div class="widget widget-content"><div data-ux="Widget" role="region" class="x-el x-el-div c1-1 c1-2 c1-h c1-b c1-c c1-d c1-e c1-f c1-g"><div><section data-ux="Section" class="x-el x-el-section c1-1 c1-2 c1-h c1-i c1-j c1-q c1-b c1-c c1-l c1-m c1-d c1-e c1-f c1-g"><div data-ux="Container" class="x-el x-el-div c1-1 c1-2 c1-32 c1-33 c1-t c1-u c1-26 c1-b c1-c c1-55 c1-d c1-56 c1-e c1-57 c1-f c1-58 c1-g"><div class="pp">' +
  PRIVACY_BODY +
  '</div></div></section></div></div></div>';

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

  // 4) Transform each page (styles stay inline here; consolidated in 4c).
  const built = [];
  let welcomeProcessed = null;
  for (const p of pages) {
    let html = p.html;

    // Localize fonts.
    for (const [u, local] of fontMap) html = html.split(u).join(local);

    // Localize images: base + optional /:/transform, with or without https:
    for (const [baseRel, local] of imgMap) {
      const re = new RegExp('(?:https:)?' + reEsc(baseRel) + "(?:/:/[^\\s\"')]*)?", 'g');
      html = html.replace(re, local);
    }

    // Content corrections (footer everywhere; contact-form + hero are home-only).
    html = customizeFooter(html);
    html = customizeContact(html);
    if (p.home) html = customizeHero(html);

    // Strip builder artifacts, then optimize: no-JS desktop nav, head cleanup,
    // and removal of inert builder attributes.
    html = removeBuilderArtifacts(html);
    html = customizeNav(html);
    html = cleanHead(html);
    html = stripInertAttrs(html);

    // Remove the builder's runtime scripts + service-worker registration.
    html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    html = html.replace(/<script\b[^>]*\/>/gi, '');

    // Inject our interactivity shim.
    html = html.replace('</body>', `<script>${CUSTOM_JS}</script></body>`);

    built.push({ route: p.route, home: !!p.home, html });
    if (p.home) welcomeProcessed = html;
  }

  // 4b) Privacy Policy page: reuse the welcome page's header + corrected footer,
  // swapping the contact widget for the privacy content.
  if (welcomeProcessed) {
    const cStart = welcomeProcessed.indexOf('<div id="9348b19c-e100-4b57-87f3-917139bec823"');
    const fStart = welcomeProcessed.indexOf('<div id="73419053-1186-44c0-948d-11d982a8b886"');
    if (cStart !== -1 && fStart !== -1) {
      let pp =
        welcomeProcessed.slice(0, cStart) + PRIVACY_CONTENT + welcomeProcessed.slice(fStart);
      pp = pp.replace('<title>Welcome</title>', '<title>Privacy Policy | Embers to Ash</title>');
      built.push({ route: 'privacy-policy', home: false, html: pp });
    } else {
      console.warn('WARN: could not locate content/footer anchors for privacy page');
    }
  }

  // 4c) Item 1: consolidate every page's inline <style> into one cached
  // /assets/site.css. Class names + fonts are identical across pages, so the
  // union is safe; rules are de-duplicated and grouped by their original sheet.
  const sheetOrder = [];
  const sheets = new Map();
  for (const b of built) {
    const re = /<style([^>]*)>([\s\S]*?)<\/style>/g;
    let m;
    while ((m = re.exec(b.html))) {
      const key = (m[1] || '').trim();
      const css = (m[2] || '').replace(/\/\*[\s\S]*?\*\//g, '');
      if (!sheets.has(key)) {
        sheets.set(key, { seen: new Set(), rules: [] });
        sheetOrder.push(key);
      }
      const g = sheets.get(key);
      for (const r of splitCssRules(css)) {
        if (!g.seen.has(r)) {
          g.seen.add(r);
          g.rules.push(r);
        }
      }
    }
  }
  let siteCss =
    '/* Embers to Ash - consolidated styles. Fonts: Dancing Script, Cantarell, Cinzel (SIL OFL). */\n';
  for (const key of sheetOrder) siteCss += sheets.get(key).rules.join('') + '\n';
  await writeFile(path.join(ASSET_DIR, 'site.css'), siteCss, 'utf8');
  console.log('wrote  assets/site.css ' + Math.round(Buffer.byteLength(siteCss) / 1024) + 'KB');

  // 4d) Replace each page's inline styles with a single cached stylesheet link.
  for (const b of built) {
    let html = b.html.replace(/<style[^>]*>[\s\S]*?<\/style>/g, '');
    html = html.replace('</head>', '<link rel="stylesheet" href="/assets/site.css"/></head>');
    if (forbidden.test(html)) console.warn('WARN: residual builder reference in', b.route + '.html');
    await writeFile(path.join(OUT, `${b.route}.html`), html, 'utf8');
    if (b.home) await writeFile(path.join(OUT, 'index.html'), html, 'utf8');
    console.log('wrote ', b.route + '.html' + (b.home ? ' (+ index.html)' : ''));
  }

  // 5) Aux files.
  const iconPath =
    [...imgMap.values()].find((v) => v.includes('/icon.')) || '/assets/img/icon.png';
  const iconType = iconPath.endsWith('.png')
    ? 'image/png'
    : iconPath.endsWith('.webp')
    ? 'image/webp'
    : 'image/jpeg';

  const manifest = {
    scope: '/',
    start_url: '/',
    display: 'standalone',
    icons: [
      { sizes: '192x192', type: iconType, src: iconPath },
      { sizes: '512x512', type: iconType, src: iconPath },
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
