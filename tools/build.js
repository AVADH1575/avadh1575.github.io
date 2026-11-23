#!/usr/bin/env node
// Portfolio build: optimises project screenshots/videos and regenerates the
// projects section of index.html (between the PROJECTS:START/END markers).
//
// Source media (private, never published): ~/Documents/Portfolio Media/<project folder>/
// Optimised media (published):              media/<slug>/
// Project text + per-file options:          tools/projects.json
//
// Per-file options in projects.json ("files": { "<source file name>": {...} }):
//   caption: "..."     text under the item
//   order:   1         position (videos are always shown before images)
//   skip:    true      leave this file out
//   clips:   [{ start, duration, caption, order }]   (videos) publish only these parts
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
const VIDEO_WARN_MB = 40;       // try a smaller preset above this
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
const sizeMB = (f) => fs.statSync(f).size / 1048576;
const newerThan = (src, out) => !fs.existsSync(out) || fs.statSync(src).mtimeMs > fs.statSync(out).mtimeMs;
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

// Compile the AVFoundation encoder (tools/transcode.swift) once; cached outside the repo.
const TRANSCODE = (() => {
  const source = path.join(__dirname, 'transcode.swift');
  const bin = path.join(os.homedir(), 'Library', 'Caches', 'portfolio-tools', 'transcode');
  try {
    if (!fs.existsSync(bin) || fs.statSync(source).mtimeMs > fs.statSync(bin).mtimeMs) {
      fs.mkdirSync(path.dirname(bin), { recursive: true });
      run('swiftc', ['-O', source, '-o', bin]);
    }
    return bin;
  } catch (e) {
    log.push('note: Swift encoder unavailable, using avconvert (bigger files, keeps audio)');
    return null;
  }
})();

// Re-encode a video (or part of it) to H.264 MP4 without audio or metadata.
function writeVideo(src, out, clip) {
  if (TRANSCODE) {
    run(TRANSCODE, [src, out, String(clip.start != null ? clip.start : 0), String(clip.duration != null ? clip.duration : -1), '1280']);
    return;
  }
  const part = [];
  if (clip.start != null) part.push('--start', String(clip.start));
  if (clip.duration != null) part.push('--duration', String(clip.duration));
  run('avconvert', ['-s', src, '-p', 'Preset1280x720', '-o', out, '--replace', ...part]);
  if (sizeMB(out) > VIDEO_WARN_MB) run('avconvert', ['-s', src, '-p', 'Preset960x540', '-o', out, '--replace', ...part]);
}

function writePoster(video, out) {
  run('qlmanage', ['-t', '-s', String(MAX_SIDE), '-o', tmp, video]);
  const png = path.join(tmp, path.basename(video) + '.png');
  if (fs.existsSync(png)) writeImage(png, out);
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

  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (!IMAGES.has(ext) && !VIDEOS.has(ext)) continue;
    const opt = opts[f] || {};
    if (opt.skip) continue;
    const raw = path.basename(f, path.extname(f));
    const base = slugify(raw);
    const src = path.join(srcDir, f);
    fs.mkdirSync(outDir, { recursive: true });

    try {
      if (IMAGES.has(ext)) {
        const name = base + IMG_EXT;
        const out = path.join(outDir, name);
        keep.add(name);
        meta[name] = { caption: opt.caption != null ? opt.caption : captionOf(raw), order: opt.order != null ? opt.order : 999 };
        if (newerThan(src, out)) { writeImage(src, out); log.push(`image  ${p.slug}/${name}  ${sizeMB(out).toFixed(1)} MB`); }
        continue;
      }
      const clips = opt.clips && opt.clips.length ? opt.clips : [{}];
      clips.forEach((c, k) => {
        const stem = opt.clips ? `${base}-part${k + 1}` : base;
        const name = stem + '.mp4', posterName = stem + '.poster' + IMG_EXT;
        const out = path.join(outDir, name), poster = path.join(outDir, posterName);
        const sig = JSON.stringify([c.start != null ? c.start : null, c.duration != null ? c.duration : null]);
        meta[name] = {
          caption: c.caption != null ? c.caption : (opt.caption != null ? opt.caption : captionOf(raw)),
          order: c.order != null ? c.order : (opt.order != null ? opt.order : 999),
          sig,
        };
        keep.add(name); keep.add(posterName);
        const stale = newerThan(src, out) || (prev[name] && prev[name].sig) !== sig;
        if (stale) {
          writeVideo(src, out, c);
          const mb = sizeMB(out);
          if (mb > VIDEO_LIMIT_MB) {
            fs.unlinkSync(out); keep.delete(name); keep.delete(posterName); delete meta[name];
            log.push(`SKIPPED ${p.slug}/${f}: still ${mb.toFixed(0)} MB after compression — trim it shorter`);
            return;
          }
          log.push(`video  ${p.slug}/${name}  ${mb.toFixed(1)} MB`);
        }
        if (stale || !fs.existsSync(poster)) writePoster(out, poster);
      });
    } catch (err) {
      log.push(`FAILED ${p.slug}/${f}: ${String(err.stderr || err.message).trim().split('\n')[0]}`);
    }
  }
  if (!fs.existsSync(outDir)) continue; // folder has no images/videos yet
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
  for (const f of fs.readdirSync(outDir)) {
    if (!keep.has(f)) { fs.unlinkSync(path.join(outDir, f)); log.push(`removed ${p.slug}/${f}`); }
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
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    const base = path.basename(f, ext);
    if (base.endsWith('.poster') || !meta[f]) continue;
    const rel = `media/${p.slug}/${f}`;
    const m = meta[f];
    if (ext === '.mp4') {
      const poster = files.find((x) => x.startsWith(base + '.poster.'));
      items.push({ type: 'video', src: rel, poster: poster ? `media/${p.slug}/${poster}` : '', caption: m.caption || '', order: m.order, name: f });
    } else if (ext === '.webp' || ext === '.jpg') {
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

function bodyHTML(p, withCount) {
  const meta = [esc(p.meta), withCount && p.media.length ? esc(countLabel(p.media)) : ''].filter(Boolean).join(' · ');
  return `<div class="body">
          <div class="meta">${p.featured ? '<span class="tag">Featured</span>' : ''}${meta}</div>
          <h3>${esc(p.title)}</h3>${p.summary ? `\n          <p class="desc">${esc(p.summary)}</p>` : ''}
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
        ? `<video controls playsinline preload="none"${m.poster ? ` poster="${m.poster}"` : ''} aria-label="${alt}"><source src="${m.src}" type="video/mp4"></video>`
        : `<button class="zoom" type="button" aria-label="Open larger: ${alt}"><img src="${m.src}" alt="${alt}" loading="lazy" decoding="async"></button>`;
      return `<div class="item${i === 0 ? ' on' : ''}" data-caption="${esc(m.caption)}">${inner}</div>`;
    }).join('\n            ');
    if (items.length > 1) {
      thumbs = `\n          <div class="thumbs" aria-label="${esc(p.title)} media">` + items.map((m, i) => {
        const img = m.type === 'video' ? m.poster : m.src;
        const label = esc(`${m.type === 'video' ? 'Video' : 'Screenshot'} ${i + 1}${m.caption ? ': ' + m.caption : ''}`);
        return `<button class="thumb${i === 0 ? ' on' : ''}" type="button" data-i="${i}" aria-label="${label}">${img ? `<img src="${img}" alt="" loading="lazy">` : ''}${m.type === 'video' ? `<span class="play">${PLAY}</span>` : ''}</button>`;
      }).join('') + `</div>`;
    }
    caption = `\n          <p class="caption">${esc(items[0].caption)}</p>`;
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
let html = `<div class="showcase">\n      ${showcase.map(showcaseHTML).join('\n      ')}\n      </div>`;
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
