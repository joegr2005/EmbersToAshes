// scripts/scrape.mjs
//
// Mirrors https://emberstoash.com/ into a self-contained static site.
//
// What it does:
//   1. Fetches each page's server-rendered HTML.
//   2. Downloads every referenced font and image (host-agnostic) once.
//   3. Rewrites those asset URLs to local /assets/... paths.
//   4. Strips the builder's runtime JS + the service-worker registration.
//   5. Reproduces the original split header without JS, de-lazifies images, and
//      cleans the head; each page keeps its own inline CSS for exact fidelity.
//   6. Emits <route>.html (+ index.html), manifest.webmanifest and vercel.json.
//
// Run from the project root:  node scripts/scrape.mjs
//
// No third-party dependencies (uses Node 18+ global fetch).

import { mkdir, rm, writeFile } from 'node:fs/promises';
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

// ---- Asset helpers (provider-agnostic) --------------------------------------
// Cap (px) for the responsive variant we download when a source image is
// offered at several sizes.
const MAX_IMG_WIDTH = 1600;

// Largest width hint found in a URL (supports w:NNN, w=NNN, width=NNN).
function widthHint(url) {
  const nums = [...url.matchAll(/\bw(?:idth)?[:=](\d+)/gi)].map((m) => +m[1]);
  return nums.length ? Math.max(...nums) : 0;
}

// Identity of a source image: drop a CDN transform suffix (the "/:/..."
// convention) and any query string so responsive variants collapse to one file.
function assetBase(url) {
  return url.split('/:/')[0].split('?')[0];
}

// Readable local filename derived from the URL itself (no provider keywords).
function assetName(base, ext) {
  const seg = (base.split('/').filter(Boolean).pop() || '').replace(/[^a-zA-Z0-9._-]/g, '');
  if (/\.[a-z0-9]+$/i.test(seg)) return seg; // already a filename.ext
  const stem = /[a-zA-Z0-9]/.test(seg) ? seg : 'img';
  return stem + '-' + createHash('sha1').update(base).digest('hex').slice(0, 8) + '.' + ext;
}

// ---- Minimal element helpers ------------------------------------------------
// Replace hand-rolled string-index math: given a stable `anchor` (a unique
// substring of an element's opening tag) these remove or replace that whole
// element, correctly handling nesting of same-name tags.

// Byte range [start, end) of the element whose opening tag starts at `open`.
function elementRange(html, open) {
  if (open === -1) return null;
  const name = (html.slice(open + 1).match(/^[a-zA-Z0-9]+/) || [])[0];
  if (!name) return null;
  const token = new RegExp('<' + name + '\\b|</' + name + '>', 'g');
  token.lastIndex = html.indexOf('>', open) + 1;
  let depth = 1;
  let m;
  while ((m = token.exec(html))) {
    if (m[0][1] === '/') {
      if (--depth === 0) return [open, m.index + m[0].length];
    } else depth++;
  }
  return null;
}

// Index of the '<' that opens the element whose tag contains `anchor`.
function tagStart(html, anchor, from = 0) {
  const at = html.indexOf(anchor, from);
  return at === -1 ? -1 : html.lastIndexOf('<', at);
}

function removeElementAt(html, open) {
  const range = elementRange(html, open);
  return range ? html.slice(0, range[0]) + html.slice(range[1]) : html;
}

function removeElement(html, anchor, from = 0) {
  return removeElementAt(html, tagStart(html, anchor, from));
}

function replaceElement(html, anchor, replacement, from = 0) {
  const open = tagStart(html, anchor, from);
  const range = elementRange(html, open);
  return range ? html.slice(0, range[0]) + replacement + html.slice(range[1]) : html;
}

// Replace just the children of the element whose opening tag contains `anchor`.
function replaceInner(html, anchor, inner, from = 0) {
  const open = tagStart(html, anchor, from);
  const range = elementRange(html, open);
  if (open === -1 || !range) return html;
  const name = (html.slice(open + 1).match(/^[a-zA-Z0-9]+/) || [])[0];
  const innerStart = html.indexOf('>', open) + 1;
  const innerEnd = range[1] - ('</' + name + '>').length;
  return html.slice(0, innerStart) + inner + html.slice(innerEnd);
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

// Quality gate (provider-agnostic): no remote asset URL should survive
// localization inside CSS url(), <img>/<source> src, or srcset.
const remoteAsset = /(?:url\(\s*["']?|\bsrc="\s*|\bsrcset="\s*)(?:https?:)?\/\//i;

// ---- Requested content corrections ------------------------------------------

// Footer: replace the builder's "Powered by" block with our own links
// (Privacy Policy + dofollow Built by Gravish Digital backlink). Styled with
// page-independent classes + a small injected stylesheet, because the builder's
// atomic class numbers differ per page; this keeps the footer identical on
// every page.
const FOOTER_STYLE =
  '.widget-footer [data-aid="FOOTER_COPYRIGHT_RENDERED"]{color:rgb(145,145,145)}' +
  '.eta-fnav{margin:24px 0 0;font-size:14px;line-height:1.5}' +
  '.eta-fnav a{color:rgb(209,190,190);text-decoration:none}' +
  '.eta-fnav a:hover{color:rgb(212,194,194)}' +
  '.eta-fsep{padding:0 8px;color:rgb(145,145,145)}' +
  '@media (min-width:1024px){.eta-fnav{margin-top:0;text-align:right}}';

const FOOTER_LINKS =
  '<p class="eta-fnav">' +
  '<a rel="noopener" role="link" data-ux="Link" href="/privacy-policy">Privacy Policy</a>' +
  '<span class="eta-fsep">\u00b7</span>' +
  '<a rel="noopener" role="link" target="_blank" data-ux="Link" title="Gravish Digital" href="https://www.gravishdigital.com">Built by Gravish Digital</a></p>';

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

// Promote JS-lazy images to static <img>: the real source lives in
// data-srclazy / data-srcsetlazy (already localized) while src is a base64
// placeholder. Move the real source into src/srcSet and clear the off-screen
// transform the builder used to hide it, so the photo renders without script.
function delazify(html) {
  html = html.replace(/<(?:img|source)\b[^>]*>/gi, (tag) => {
    const real = tag.match(/\sdata-srclazy="([^"]*)"/i);
    const realSet = tag.match(/\sdata-srcsetlazy="([^"]*)"/i);
    if (!real && !realSet) return tag;
    let out = tag;
    if (real) {
      out = /\ssrc="/i.test(out)
        ? out.replace(/\ssrc="[^"]*"/i, ' src="' + real[1] + '"')
        : out.replace(/<(img|source)\b/i, '<$1 src="' + real[1] + '"');
    }
    if (realSet) {
      out = /\ssrcset="/i.test(out)
        ? out.replace(/\ssrcset="[^"]*"/i, ' srcset="' + realSet[1] + '"')
        : out.replace(/<(img|source)\b/i, '<$1 srcset="' + realSet[1] + '"');
    } else if (real) {
      // no real srcset: drop the placeholder srcset/sizes so the real src wins
      out = out.replace(/\ssrcset="[^"]*"/i, '').replace(/\ssizes="[^"]*"/i, '');
    }
    if (/<img\b/i.test(out) && !/\sstyle="/i.test(out)) {
      out = out.replace(/<img\b/i, '<img style="transform:none"'); // override off-screen transform
    }
    return out;
  });
  // lazy <picture> wrappers are parked off-screen via a transform until the
  // builder's JS reveals them; neutralize that so the static image shows.
  html = html.replace(/<picture\b[^>]*>/gi, (tag) =>
    /\sstyle="/i.test(tag) ? tag : tag.replace(/<picture\b/i, '<picture style="transform:none"')
  );
  // strip any residual lazy hooks (e.g., on the <picture> wrapper)
  return html.replace(/\sdata-(?:srclazy|srcsetlazy|lazyimg)="[^"]*"/gi, '');
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
  // Remove the cookie pop-up and the empty messaging/popup widgets, each found
  // by its stable widget class (no hardcoded ids or index math).
  for (const widget of ['widget-messaging', 'widget-cookie-banner', 'widget-popup']) {
    html = removeElement(html, 'class="widget ' + widget);
  }
  return html;
}

// (5) Reproduce the original split header without the builder's JS: the first
// two links sit left of the centered logo, the last two to the right. The
// builder ships two desktop nav groups; the first lists all four links in
// order. Reveal the items (drop visibility:hidden) and place the first two in
// the left group and the last two in the right group; the mobile drawer keeps
// all four.
function customizeNav(html) {
  const navOpen = tagStart(html, 'data-aid="HEADER_NAV_RENDERED"');
  if (navOpen === -1) return html;
  const navRange = elementRange(html, navOpen);
  if (!navRange) return html;
  const items = [
    ...html.slice(navRange[0], navRange[1]).matchAll(
      /<div data-ux="Block" class="[^"]*\bnav-item\b[^"]*"[\s\S]*?<\/a><\/div>/g
    ),
  ].map((m) => m[0].replace(/\s*\bc1-2m\b/, ''));
  if (items.length < 4) return html;
  html = replaceInner(html, 'navId-1"', items[0] + items[1]);
  html = replaceInner(html, 'navId-2"', items[2] + items[3]);
  return html;
}

// (3) Head cleanup: collapse duplicate touch icons, drop the obsolete IE meta,
// trim trailing newlines in social titles, and make canonical/social URLs
// absolute to the live site.
function cleanHead(html) {
  // dedupe touch icons: keep the first (with its localized href), drop the rest
  let keptIcon = false;
  html = html.replace(/<link rel="apple-touch-icon"[^>]*>/g, (m) => {
    if (keptIcon) return '';
    keptIcon = true;
    return m;
  });
  html = html.replace(/<meta http-equiv="X-UA-Compatible"[^>]*>/g, '');
  html = html.replace(/content="Embers to Ash\s+"/g, 'content="Embers to Ash"');
  // point the source site's canonical/social URL at the deployed copy
  html = html.replace(new RegExp('content="' + reEsc(ORIGIN), 'g'), 'content="' + SITE_URL);
  // make localized social images absolute
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
<p>At Embers to Ash ("we," "us," or "our"), your privacy matters to us. This Privacy Policy explains what information we collect, how we use it, and the choices you have when you visit emberstoash.com (the "Site") or contact us.</p>
<h2>Information We Collect</h2>
<p>We collect only the information you provide directly to us, such as your name, email address, and any message you submit through our contact form.</p>
<h2>How We Use Your Information</h2>
<ul>
<li>To respond to your inquiries and provide customer support.</li>
<li>To send updates, promotions, or news when you have asked to hear from us.</li>
<li>To operate, maintain, and improve the Site and our products.</li>
<li>To protect against fraud and keep the Site secure.</li>
</ul>
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
  await rm(ASSET_DIR, { recursive: true, force: true }); // start clean (no orphan assets)
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

  // 2) Fonts: any absolute web-font URL, regardless of host.
  const fontUrls = new Set(
    allHtml.match(/(?:https?:)?\/\/[^\s"')]+\.(?:woff2?|ttf|otf|eot)\b/gi) || []
  );
  const fontMap = new Map();
  for (const u of fontUrls) {
    const name = u.split('/').pop().split('?')[0];
    const { buf } = await fetchBuf(u.startsWith('http') ? u : 'https:' + u);
    await writeFile(path.join(FONT_DIR, name), buf);
    fontMap.set(u, `/assets/fonts/${name}`);
    console.log('font  ', name, buf.length + 'b');
  }

  // 3) Images: collect every remote image URL from the contexts where assets
  // appear (CSS url(), <img>/<source>, icon links, social meta), group the
  // responsive variants of each source image, and download one local copy.
  const imgUrls = new Set();
  for (const m of allHtml.matchAll(/url\(\s*["']?((?:https?:)?\/\/[^"')\s]+)["']?\s*\)/gi)) imgUrls.add(m[1]);
  // Any remote URL token inside an <img>/<source> tag - covers src, srcset and
  // the builder's lazy-load attributes (data-srclazy / data-srcsetlazy).
  for (const tag of allHtml.matchAll(/<(?:img|source)\b[^>]*>/gi)) {
    for (const u of tag[0].matchAll(/(?:https?:)?\/\/[^\s"]+/g)) imgUrls.add(u[0]);
  }
  for (const m of allHtml.matchAll(/<link\b[^>]*\bhref="((?:https?:)?\/\/[^"]+)"[^>]*>/gi)) {
    if (/rel="[^"]*icon[^"]*"/i.test(m[0]) || /\bas="image"/i.test(m[0])) imgUrls.add(m[1]);
  }
  for (const m of allHtml.matchAll(/<meta\b[^>]*(?:property|name)="(?:og:image|twitter:image)"[^>]*\bcontent="((?:https?:)?\/\/[^"]+)"/gi)) imgUrls.add(m[1]);
  for (const u of [...imgUrls]) if (/\.(?:woff2?|ttf|otf|eot)\b/i.test(u)) imgUrls.delete(u);

  // group variants by source-image base
  const variantsByBase = new Map();
  for (const u of imgUrls) {
    const base = assetBase(u);
    if (!variantsByBase.has(base)) variantsByBase.set(base, []);
    variantsByBase.get(base).push(u);
  }

  const imgMap = new Map(); // protocol-relative base -> local public path
  for (const [base, variants] of variantsByBase) {
    // prefer the largest offered variant within MAX_IMG_WIDTH; else the base
    let rep = base;
    let best = -1;
    for (const v of variants) {
      const w = widthHint(v);
      if (w > best && w <= MAX_IMG_WIDTH) { best = w; rep = v; }
    }
    const toAbs = (u) => (u.startsWith('http') ? u : 'https:' + u);
    let got;
    try { got = await fetchBuf(toAbs(rep)); }
    catch { got = await fetchBuf(toAbs(base)); }
    const name = assetName(base, extOf(got.ct));
    await writeFile(path.join(IMG_DIR, name), got.buf);
    imgMap.set(base.replace(/^https?:/, ''), `/assets/img/${name}`);
    console.log('image ', name, got.buf.length + 'b');
  }

  // 4) Transform each page (each keeps its own inline CSS).
  const built = [];
  let welcomeProcessed = null;
  for (const p of pages) {
    let html = p.html;

    // Localize fonts.
    for (const [u, local] of fontMap) html = html.split(u).join(local);

    // Localize images: a source base plus any transform/query variant.
    for (const [baseRel, local] of imgMap) {
      const re = new RegExp('(?:https?:)?' + reEsc(baseRel) + "(?:/:/[^\\s\"')]*)?(?:\\?[^\\s\"')]*)?", 'g');
      html = html.replace(re, local);
    }
    // Promote JS-lazy images to static <img> so photos render without script.
    html = delazify(html);

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

    // Inject the consistent footer styling (page-independent of the builder's
    // per-page atomic class numbering).
    html = html.replace('</head>', '<style>' + FOOTER_STYLE + '</style></head>');

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
    // Build the privacy page by swapping the contact widget for the privacy
    // content; the header and footer are reused unchanged.
    const pp = replaceElement(welcomeProcessed, 'class="widget widget-contact', PRIVACY_CONTENT)
      .replace('<title>Welcome</title>', '<title>Privacy Policy | Embers to Ash</title>');
    if (pp !== welcomeProcessed) {
      built.push({ route: 'privacy-policy', home: false, html: pp });
    } else {
      console.warn('WARN: could not locate the contact widget for the privacy page');
    }
  }

  // 4c) Write each page, keeping its own inline CSS so the cascade matches the
  // original exactly (fidelity over the shared-stylesheet optimization).
  for (const b of built) {
    if (remoteAsset.test(b.html)) console.warn('WARN: un-localized remote asset in', b.route + '.html');
    await writeFile(path.join(OUT, `${b.route}.html`), b.html, 'utf8');
    if (b.home) await writeFile(path.join(OUT, 'index.html'), b.html, 'utf8');
    console.log('wrote ', b.route + '.html' + (b.home ? ' (+ index.html)' : ''));
  }

  // 5) Aux files. Derive the PWA icon from the (localized) touch-icon link.
  const iconMatch = (welcomeProcessed || '').match(/<link rel="apple-touch-icon"[^>]*href="([^"]+)"/);
  const iconPath = iconMatch ? iconMatch[1] : ([...imgMap.values()][0] || '/assets/img/icon.png');
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
