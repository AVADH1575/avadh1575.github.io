#!/usr/bin/env node
// Portfolio build: optimises project screenshots/videos and regenerates the
// projects section of index.html (between the PROJECTS:START/END markers).
//
// Source media (private, never published): ~/Documents/Portfolio Media/<project folder>/
// Optimised media (published):              media/<slug>/
// Project text + media options:             tools/projects.json
//
// projects.json, per project:
//   "files":  { "<image file>": { caption, order, skip } }      images (and videos when "videos" is absent)
//   "videos": [ { name, caption, order, poster: <sec>,           curated videos, e.g. a highlight reel
//                 segments: [ { file, start, end }, ... ] } ]   joined from one or more source files
// Without "videos", every video file in the folder is published in full.
//
// Usage: node tools/build.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const INBOX = process.env.PORTFOLIO_MEDIA || path.join(os.homedir(), 'Documents', 'Portfolio Media');
const OUT = path.join(ROOT, 'media');
const INDEX = path.join(ROOT, 'index.html');
const PROJECTS = JSON.parse(fs.readFileSync(path.join(__dirname, 'projects.json'), 'utf8'));

const CWEBP = ['/usr/local/bin/cwebp', '/opt/homebrew/bin/cwebp', '/Applications/XAMPP/xamppfiles/bin/cwebp']
  .find((p) => fs.existsSync(p));
const IMG_EXT = CWEBP ? '.webp' : '.jpg';
const IMAGES = new Set(['.png', '.jpg', '.jpeg', '.heic', '.webp', '.tif', '.tiff']);
const VIDEOS = new Set(['.mp4', '.mov', '.m4v']);
const MAX_SIDE = 1600;          // px, longest side for images and posters
const VIDEO_LIMIT_MB = 95;      // GitHub rejects files over 100 MB
const NO_CAPTION = /^(img|dsc|pxl|screenshot|screen ?recording|simulator[_ ]screenshot|signal|skype[_ ]picture|whatsapp|photo|video|\d{5,})/i;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-'));
const log = [];

const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const slugify = (s) => s.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().toLowerCase()
  .replace(/[\s_]+/g, '-').replace(/-+/g, '-') || 'file';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const captionOf = (name) => {
  if (NO_CAPTION.test(name)) return '';
  const t = name.replace(/^\d+[\s._-]*/, '').replace(/[_]+/g, ' ').replace(/\s+-\s+|-(?=\S)/g, ' ').trim();
  return t && !/^\d/.test(t) ? t[0].toUpperCase() + t.slice(1) : '';
};
const clock = (s) => { const t = Math.round(s || 0); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
const sizeMB = (f) => fs.statSync(f).size / 1048576;
const mtime = (f) => fs.statSync(f).mtimeMs;
const run = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };

function pixelSize(file) {
  const out = run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file]);
  return { w: +(out.match(/pixelWidth:\s*(\d+)/) || [])[1] || 0, h: +(out.match(/pixelHeight:\s*(\d+)/) || [])[1] || 0 };
}

// Re-encode an image: shrink to MAX_SIDE (never enlarge) and drop metadata (EXIF/GPS).
function writeImage(src, out) {
  const { w, h } = pixelSize(src);
  const png = path.join(tmp, 'frame.png');
  const args = ['-s', 'format', 'png'];
  if (Math.max(w, h) > MAX_SIDE) args.push('-Z', String(MAX_SIDE));
  run('sips', [...args, src, '--out', png]);
  if (CWEBP) run(CWEBP, ['-quiet', '-q', '80', png, '-o', out]);
  else run('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '80', png, '--out', out]);
}

// AVFoundation encoder (tools/transcode.swift), compiled once and cached outside the repo.
const TRANSCODE = (() => {
  const source = path.join(__dirname, 'transcode.swift');
  const bin = path.join(os.homedir(), 'Library', 'Caches', 'portfolio-tools', 'transcode');
  try {
    if (!fs.existsSync(bin) || mtime(source) > mtime(bin)) {
      fs.mkdirSync(path.dirname(bin), { recursive: true });
      run('swiftc', ['-O', source, '-o', bin]);
    }
    return bin;
  } catch (e) {
    log.push('note: Swift encoder unavailable, using avconvert (first segment only, bigger files, keeps audio)');
    return null;
  }
})();

// Encode a video from segments; writes out.mp4 and poster. Returns duration in seconds.
function writeVideo(segments, out, poster, posterAt) {
  if (TRANSCODE) {
    const spec = path.join(tmp, 'spec.json');
    const posterPng = path.join(tmp, 'poster.png');
    fs.rmSync(posterPng, { force: true });
    fs.writeFileSync(spec, JSON.stringify({
      out, maxSide: 1280, posterAt: posterAt != null ? posterAt : 0.5, posterOut: posterPng,
      segments: segments.map((s) => ({ src: s.src, start: s.start, end: s.end })),
    }));
    const info = JSON.parse(run(TRANSCODE, [spec]).trim().split('\n').pop());
    if (fs.existsSync(posterPng)) writeImage(posterPng, poster);
    return info.duration;
  }
  const s = segments[0];
  const part = [];
  if (s.start != null) part.push('--start', String(s.start));
  if (s.end != null) part.push('--duration', String(s.end - (s.start || 0)));
  run('avconvert', ['-s', s.src, '-p', 'Preset960x540', '-o', out, '--replace', ...part]);
  run('qlmanage', ['-t', '-s', String(MAX_SIDE), '-o', tmp, out]);
  const png = path.join(tmp, path.basename(out) + '.png');
  if (fs.existsSync(png)) writeImage(png, poster);
  return s.end != null ? s.end - (s.start || 0) : 0;
}

// 1) Process source folders into media/<slug>/
for (const p of PROJECTS) {
  const srcDir = path.join(INBOX, p.folder);
  const outDir = path.join(OUT, p.slug);
  if (!fs.existsSync(srcDir)) continue;

  const prev = readJSON(path.join(outDir, 'meta.json'), {});
  const meta = {};
  const keep = new Set(['meta.json']);
  const opts = p.files || {};
  const files = fs.readdirSync(srcDir).filter((f) => !f.startsWith('.')).sort(byName);
  const ensureDir = () => fs.mkdirSync(outDir, { recursive: true });

  // Images (and, when no curated "videos" list exists, whole video files).
  const videoJobs = (p.videos || []).map((v) => ({ ...v }));
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    const opt = opts[f] || {};
    if (opt.skip) continue;
    const raw = path.basename(f, path.extname(f));
    if (IMAGES.has(ext)) {
      ensureDir();
      const name = slugify(raw) + IMG_EXT;
      const src = path.join(srcDir, f), out = path.join(outDir, name);
      keep.add(name);
      meta[name] = { type: 'image', caption: opt.caption != null ? opt.caption : captionOf(raw), order: opt.order != null ? opt.order : 999 };
      try {
        if (!fs.existsSync(out) || mtime(src) > mtime(out)) { writeImage(src, out); log.push(`image  ${p.slug}/${name}`); }
      } catch (err) { log.push(`FAILED ${p.slug}/${f}: ${String(err.stderr || err.message).trim().split('\n')[0]}`); }
    } else if (VIDEOS.has(ext) && !p.videos) {
      videoJobs.push({ name: raw, caption: opt.caption != null ? opt.caption : captionOf(raw), order: opt.order, segments: [{ file: f }] });
    }
  }

  // Videos.
  for (const v of videoJobs) {
    const stem = slugify(v.name);
    const name = stem + '.mp4', posterName = stem + '.poster' + IMG_EXT;
    const out = path.join(outDir, name), poster = path.join(outDir, posterName);
    const segments = v.segments.map((s) => ({ ...s, src: path.join(srcDir, s.file) }));
    const missing = segments.find((s) => !fs.existsSync(s.src));
    if (missing) { log.push(`MISSING ${p.slug}/${missing.file} (video "${v.name}" skipped)`); continue; }
    ensureDir();
    const sig = JSON.stringify({ seg: v.segments, poster: v.poster, src: segments.map((s) => mtime(s.src)) });
    keep.add(name); keep.add(posterName);
    let duration = prev[name] && prev[name].duration;
    try {
      if (!fs.existsSync(out) || !fs.existsSync(poster) || !prev[name] || prev[name].sig !== sig) {
        duration = writeVideo(segments, out, poster, v.poster);
        const mb = sizeMB(out);
        if (mb > VIDEO_LIMIT_MB) {
          fs.unlinkSync(out); keep.delete(name); keep.delete(posterName);
          log.push(`SKIPPED ${p.slug}/${name}: ${mb.toFixed(0)} MB — use shorter segments`);
          continue;
        }
        log.push(`video  ${p.slug}/${name}  ${clock(duration)}  ${mb.toFixed(1)} MB`);
      }
      meta[name] = { type: 'video', caption: v.caption || '', order: v.order != null ? v.order : 999, duration, sig };
    } catch (err) {
      keep.delete(name); keep.delete(posterName);
      log.push(`FAILED ${p.slug}/${name}: ${String(err.stderr || err.message).trim().split('\n')[0]}`);
    }
  }

  if (!fs.existsSync(outDir)) continue; // folder has no images/videos yet
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
  for (const f of fs.readdirSync(outDir)) {
    if (!keep.has(f)) { fs.rmSync(path.join(outDir, f), { recursive: true, force: true }); log.push(`removed ${p.slug}/${f}`); }
  }
}

// 2) Collect published media per project
for (const p of PROJECTS) {
  const dir = path.join(OUT, p.slug);
  p.media = [];
  if (!fs.existsSync(dir)) continue;
  const meta = readJSON(path.join(dir, 'meta.json'), {});
  const files = fs.readdirSync(dir);
  const items = [];
  for (const [f, m] of Object.entries(meta)) {
    if (!files.includes(f)) continue;
    const rel = `media/${p.slug}/${f}`;
    if (m.type === 'video') {
      const stem = f.replace(/\.mp4$/, '');
      const poster = files.find((x) => x.startsWith(stem + '.poster.'));
      items.push({ type: 'video', src: rel, poster: poster ? `media/${p.slug}/${poster}` : '', caption: m.caption || '', order: m.order, duration: m.duration, name: f });
    } else {
      items.push({ type: 'image', src: rel, caption: m.caption || '', order: m.order, name: f });
    }
  }
  items.sort((a, b) => (a.type === b.type ? 0 : a.type === 'video' ? -1 : 1) || a.order - b.order || byName(a.name, b.name));
  p.media = items;
}

// 3) Render HTML
const ART = {
  floorplan: `<svg viewBox="0 0 320 170" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="20" y="16" width="280" height="138" rx="4" stroke-width="3"/><path d="M150 16v58M150 104v50M150 92h-22M20 92h86M230 16v40M230 86v68M230 56h70" stroke-width="2.5"/><path d="M150 74a18 18 0 0 1 18 18" stroke-width="1.6" opacity=".7"/><path d="M106 92a22 22 0 0 0 22-22" stroke-width="1.6" opacity=".7"/><path d="M60 16h40" stroke-width="6" opacity=".35"/><path d="M300 112v28" stroke-width="6" opacity=".35"/><path d="M24 46h272" stroke-width="1.4" stroke-dasharray="5 6" opacity=".55"/><g font-family="JetBrains Mono, monospace" font-size="10" fill="currentColor" stroke="none" opacity=".8"><text x="56" y="62">Living</text><text x="178" y="130">Bedroom</text><text x="246" y="40">Bath</text><text x="56" y="128">Kitchen</text></g></svg>`,
  uwb: `<svg viewBox="0 0 320 170" fill="none" stroke="currentColor" stroke-linecap="round"><g stroke-width="1.4" opacity=".45"><circle cx="60" cy="40" r="70"/><circle cx="60" cy="40" r="110"/><circle cx="262" cy="52" r="85"/><circle cx="262" cy="52" r="125"/><circle cx="150" cy="150" r="48"/><circle cx="150" cy="150" r="80"/></g><g fill="currentColor" stroke="none"><rect x="52" y="32" width="16" height="16" rx="4"/><rect x="254" y="44" width="16" height="16" rx="4"/><rect x="142" y="142" width="16" height="16" rx="4"/></g><circle cx="166" cy="92" r="9" fill="currentColor" stroke="none"/><circle cx="166" cy="92" r="17" stroke-width="2" opacity=".6"/><path d="M60 40L166 92M262 52L166 92M150 150L166 92" stroke-width="1.6" stroke-dasharray="4 5"/><g font-family="JetBrains Mono, monospace" font-size="10" fill="currentColor" stroke="none" opacity=".85"><text x="184" y="98">x: 4.2  y: 2.7</text><text x="34" y="66">UWB A</text><text x="246" y="80">UWB B</text><text x="100" y="156">UWB C</text></g></svg>`,
};
const PLAY = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';

const countLabel = (m) => {
  const v = m.filter((x) => x.type === 'video').length;
  const i = m.length - v;
  return [v && `${v} video${v > 1 ? 's' : ''}`, i && `${i} screenshot${i > 1 ? 's' : ''}`].filter(Boolean).join(' · ');
};
const captionText = (m) => [m.caption, m.type === 'video' && m.duration ? clock(m.duration) : ''].filter(Boolean).join(' · ');

function bodyHTML(p, withCount) {
  const meta = [esc(p.meta), withCount && p.media.length ? esc(countLabel(p.media)) : ''].filter(Boolean).join(' · ');
  return `<div class="body">
          <div class="meta">${p.featured ? '<span class="tag">Featured</span>' : ''}${meta}</div>
          <h3>${esc(p.title)}</h3>${p.summary ? `\n          <p class="desc">${esc(p.summary)}</p>` : ''}
          <p class="label">What I did</p>
          <ul>${p.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
          <div class="chips">${p.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>
        </div>`;
}

function showcaseHTML(p) {
  const items = p.media;
  let stage, thumbs = '', caption = '';
  if (items.length) {
    stage = items.map((m, i) => {
      const alt = esc(`${p.title}${m.caption ? ' — ' + m.caption : ''}`);
      const inner = m.type === 'video'
        ? `<video controls muted playsinline loop preload="none"${i === 0 ? ' data-lead' : ''}${m.poster ? ` poster="${m.poster}"` : ''} aria-label="${alt}"><source src="${m.src}" type="video/mp4"></video>`
        : `<button class="zoom" type="button" aria-label="Open larger: ${alt}"><img src="${m.src}" alt="${alt}" loading="lazy" decoding="async"></button>`;
      return `<div class="item${i === 0 ? ' on' : ''}" data-caption="${esc(captionText(m))}">${inner}</div>`;
    }).join('\n            ');
    if (items.length > 1) {
      thumbs = `\n          <div class="thumbs" aria-label="${esc(p.title)} media">` + items.map((m, i) => {
        const img = m.type === 'video' ? m.poster : m.src;
        const label = esc(`${m.type === 'video' ? 'Video' : 'Screenshot'} ${i + 1}${m.caption ? ': ' + m.caption : ''}`);
        const badge = m.type === 'video' ? `<span class="play">${PLAY}</span>${m.duration ? `<span class="dur">${clock(m.duration)}</span>` : ''}` : '';
        return `<button class="thumb${i === 0 ? ' on' : ''}" type="button" data-i="${i}" aria-label="${label}">${img ? `<img src="${img}" alt="" loading="lazy">` : ''}${badge}</button>`;
      }).join('') + `</div>`;
    }
    caption = `\n          <p class="caption">${esc(captionText(items[0]))}</p>`;
  } else {
    stage = `<div class="item on art" aria-hidden="true">${ART[p.illustration] || ''}</div>`;
  }
  return `<article class="show reveal" id="project-${p.slug}">
        <div class="media" data-gallery>
          <div class="stage">
            ${stage}
          </div>${caption}${thumbs}
        </div>
        ${bodyHTML(p, true)}
      </article>`;
}

function cardHTML(p) {
  return `<article class="proj reveal" id="project-${p.slug}">
        ${bodyHTML(p, false)}
      </article>`;
}

const showcase = PROJECTS.filter((p) => p.media.length || p.illustration);
const compact = PROJECTS.filter((p) => !(p.media.length || p.illustration));
const jump = `<nav class="jump" aria-label="Jump to a project">${PROJECTS.map((p) => {
  const kind = p.media.some((m) => m.type === 'video') ? '▶ ' : '';
  return `<a href="#project-${p.slug}">${kind}${esc(p.short || p.title)}</a>`;
}).join('')}</nav>`;
let html = `${jump}\n      <div class="showcase">\n      ${showcase.map(showcaseHTML).join('\n      ')}\n      </div>`;
if (compact.length) {
  html += `\n      <h3 class="more-title">More projects</h3>\n      <div class="more">\n      ${compact.map(cardHTML).join('\n      ')}\n      </div>`;
}

const page = fs.readFileSync(INDEX, 'utf8');
const START = '<!-- PROJECTS:START -->', END = '<!-- PROJECTS:END -->';
const a = page.indexOf(START), b = page.indexOf(END);
if (a < 0 || b < a) { console.error('Markers not found in index.html'); process.exit(1); }
fs.writeFileSync(INDEX, page.slice(0, a + START.length) + '\n      ' + html + '\n      ' + page.slice(b));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(log.length ? log.join('\n') : 'No media changes.');
for (const p of PROJECTS) console.log(`${p.slug.padEnd(20)} ${p.media.length ? countLabel(p.media) : (p.illustration ? 'illustration' : 'text only')}`);
