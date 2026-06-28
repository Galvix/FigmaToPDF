import express from 'express';
import multer from 'multer';
import AdmZip from 'adm-zip';
import puppeteer from 'puppeteer-core';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import http from 'http';
import net from 'net';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3080;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const JOBS_DIR = path.join(__dirname, 'jobs');
const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/chromium';

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(JOBS_DIR)) fs.mkdirSync(JOBS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage });

const activeJobs = new Map();

app.use(express.static(path.join(__dirname, 'public')));

// ─── Utility helpers ─────────────────────────────────────────────────────────

function getFreePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function checkServerReady(port, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const check = () => {
      if (Date.now() > deadline) {
        return reject(new Error(`Server on port ${port} did not respond within 30s`));
      }
      http.get(`http://127.0.0.1:${port}/`, (res) => {
        res.resume();
        resolve(true);
      }).on('error', () => {
        setTimeout(check, 200);
      });
    };
    check();
  });
}

function sendJobEvent(jobId, data) {
  const job = activeJobs.get(jobId);
  if (job && job.res) {
    job.res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}

function logToJob(jobId, text, level = 'info') {
  console.log(`[Job ${jobId}] [${level}] ${text}`);
  sendJobEvent(jobId, { type: 'log', text, level });
}

function progressJob(jobId, percent, status) {
  sendJobEvent(jobId, { type: 'progress', percent, status });
}

function runInstall(jobId, cwd) {
  return new Promise((resolve, reject) => {
    logToJob(jobId, 'Installing dependencies...', 'info');
    const proc = spawn('npm', ['install', '--no-audit', '--no-fund'], {
      cwd,
      shell: true,
      stdio: 'pipe'
    });
    proc.stdout.on('data', d => {
      const line = d.toString().trim();
      if (line) logToJob(jobId, `[npm] ${line}`, 'info');
    });
    proc.stderr.on('data', d => {
      const line = d.toString().trim();
      if (line) logToJob(jobId, `[npm] ${line}`, 'info');
    });
    proc.on('close', code => {
      code === 0
        ? (logToJob(jobId, 'Dependencies installed.', 'success'), resolve())
        : reject(new Error(`npm install failed with exit code ${code}`));
    });
    proc.on('error', reject);
  });
}

function findFile(dir, candidates) {
  for (const c of candidates) {
    const p = path.join(dir, c);
    if (fs.existsSync(p)) return { abs: p, rel: c };
  }
  return null;
}

function startStaticServer(dir, port) {
  return new Promise((resolve) => {
    const staticApp = express();
    staticApp.use(express.static(dir));
    const server = staticApp.listen(port, '127.0.0.1', () => resolve(server));
  });
}

// ─── Color utilities ─────────────────────────────────────────────────────────

function hexToHSL(hex) {
  hex = hex.replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  const r = parseInt(hex.substring(0, 2), 16) / 255;
  const g = parseInt(hex.substring(2, 4), 16) / 255;
  const b = parseInt(hex.substring(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  return { h: h * 360, s: s * 100, l: l * 100 };
}

function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(100, s)) / 100;
  l = Math.max(0, Math.min(100, l)) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let r, g, b;
  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  const toHex = v => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function derivePalette(primaryHex) {
  const { h, s } = hexToHSL(primaryHex);
  return {
    PRIMARY: primaryHex,
    PRIMARY_LIGHT: hslToHex(h, s * 0.3, 95),
    PRIMARY_MID: hslToHex(h, s * 0.5, 80),
    DARK: hslToHex(h, s * 0.3, 10),
    MID: hslToHex(h, s * 0.2, 28),
    LIGHT_TEXT: hslToHex(h, s * 0.15, 50),
    PAGE_BG: '#ffffff',
    WARM_BG: hslToHex(h, s * 0.15, 97),
    BORDER: hslToHex(h, s * 0.15, 87),
  };
}

// ─── Website content extraction ──────────────────────────────────────────────

async function extractWebsiteContent(page, jobId) {
  logToJob(jobId, 'Scrolling page to trigger lazy content...', 'info');

  await page.evaluate(async () => {
    await new Promise(resolve => {
      let totalHeight = 0;
      const distance = 300;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= document.body.scrollHeight) {
          window.scrollTo(0, 0);
          clearInterval(timer);
          resolve();
        }
      }, 100);
    });
  });
  await new Promise(r => setTimeout(r, 500));

  logToJob(jobId, 'Extracting content from rendered page...', 'info');

  return await page.evaluate(() => {
    function parseRGB(str) {
      const m = str.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
      return m ? { r: +m[1], g: +m[2], b: +m[3] } : null;
    }
    function rgbToHex(r, g, b) {
      return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
    }
    function isSaturated(colorStr) {
      const rgb = parseRGB(colorStr);
      if (!rgb) return false;
      const max = Math.max(rgb.r, rgb.g, rgb.b) / 255;
      const min = Math.min(rgb.r, rgb.g, rgb.b) / 255;
      const l = (max + min) / 2;
      const d = max - min;
      const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
      return s > 0.2 && l > 0.1 && l < 0.9;
    }
    function isInsideTag(el, tags) {
      let p = el.parentElement;
      while (p) { if (tags.includes(p.tagName)) return true; p = p.parentElement; }
      return false;
    }

    const result = {
      companyName: '', tagline: '', description: '',
      logoUrl: '', heroImageUrl: '',
      sections: [], images: [],
      contact: { emails: [], phones: [], address: '', website: window.location.origin },
      colors: { primary: '', background: '', textColor: '' },
      navItems: [], features: [],
    };

    // Company name
    const ogSiteName = document.querySelector('meta[property="og:site_name"]');
    const firstH1 = document.querySelector('h1');
    if (ogSiteName) result.companyName = ogSiteName.content.trim();
    else if (firstH1) result.companyName = firstH1.textContent.trim();
    else result.companyName = document.title.replace(/\s*[|–—\-].*$/, '').trim();

    // Tagline / description
    const ogDesc = document.querySelector('meta[property="og:description"]');
    const metaDesc = document.querySelector('meta[name="description"]');
    result.tagline = ogDesc?.content?.trim() || metaDesc?.content?.trim() || '';

    if (firstH1) {
      let sib = firstH1.nextElementSibling;
      for (let i = 0; i < 5 && sib; i++) {
        if (sib.tagName === 'P' && sib.textContent.trim().length > 30) {
          result.description = sib.textContent.trim();
          break;
        }
        sib = sib.nextElementSibling;
      }
    }
    if (!result.description) result.description = result.tagline;

    // Logo
    const logoCandidates = document.querySelectorAll(
      '[class*="logo" i] img, header img, nav img, [class*="brand" i] img'
    );
    for (const img of logoCandidates) {
      if (img.src && img.naturalWidth > 10) { result.logoUrl = img.src; break; }
    }
    if (!result.logoUrl) {
      const favicon = document.querySelector('link[rel*="icon"]');
      if (favicon) result.logoUrl = favicon.href;
    }

    // All significant images
    document.querySelectorAll('img').forEach(img => {
      if (img.naturalWidth > 100 && img.naturalHeight > 80 && img.src) {
        result.images.push(img.src);
      }
    });

    // Hero image
    for (const img of document.querySelectorAll('img')) {
      if (img.naturalWidth > 200 && img.naturalHeight > 150 && img.src && !isInsideTag(img, ['NAV'])) {
        result.heroImageUrl = img.src;
        break;
      }
    }
    if (!result.heroImageUrl && result.images.length > 0) result.heroImageUrl = result.images[0];

    // Sections from headings
    const headingEls = Array.from(document.querySelectorAll('h1, h2, h3')).filter(
      h => !isInsideTag(h, ['NAV', 'FOOTER']) && h.textContent.trim().length > 0
    );

    for (let i = 0; i < Math.min(headingEls.length, 20); i++) {
      const h = headingEls[i];
      const section = {
        heading: h.textContent.trim().substring(0, 100),
        level: parseInt(h.tagName.charAt(1)),
        paragraphs: [], listItems: [], imageUrl: '',
      };

      let sib = h.nextElementSibling;
      const nextH = headingEls[i + 1];

      while (sib && sib !== nextH) {
        if (['H1', 'H2', 'H3'].includes(sib.tagName)) break;

        if (sib.tagName === 'P' && sib.textContent.trim().length > 10) {
          section.paragraphs.push(sib.textContent.trim().substring(0, 500));
        }
        if (sib.tagName === 'UL' || sib.tagName === 'OL') {
          sib.querySelectorAll('li').forEach(li => {
            const t = li.textContent.trim();
            if (t.length > 3 && t.length < 200) section.listItems.push(t);
          });
        }
        if (!section.imageUrl) {
          const img = sib.tagName === 'IMG' ? sib : sib.querySelector?.('img');
          if (img && img.naturalWidth > 100) section.imageUrl = img.src;
        }
        if (['DIV', 'SECTION', 'ARTICLE'].includes(sib.tagName)) {
          sib.querySelectorAll('p').forEach(p => {
            if (p.textContent.trim().length > 10 && section.paragraphs.length < 5)
              section.paragraphs.push(p.textContent.trim().substring(0, 500));
          });
          sib.querySelectorAll('li').forEach(li => {
            const t = li.textContent.trim();
            if (t.length > 3 && t.length < 200 && section.listItems.length < 12)
              section.listItems.push(t);
          });
          if (!section.imageUrl) {
            const img = sib.querySelector('img');
            if (img && img.naturalWidth > 100) section.imageUrl = img.src;
          }
        }
        sib = sib.nextElementSibling;
      }

      if (section.paragraphs.length > 0 || section.listItems.length > 0) {
        result.sections.push(section);
      }
    }

    // Nav items
    document.querySelectorAll('nav a, header nav a').forEach(a => {
      const t = a.textContent.trim();
      if (t.length > 1 && t.length < 30) result.navItems.push(t);
    });
    result.navItems = [...new Set(result.navItems)].slice(0, 10);

    // Features
    document.querySelectorAll(
      '[class*="feature" i], [class*="benefit" i], [class*="service" i], [class*="card" i]'
    ).forEach(el => {
      const heading = el.querySelector('h2, h3, h4, strong, b');
      if (heading) {
        const t = heading.textContent.trim();
        if (t.length > 3 && t.length < 100) result.features.push(t);
      }
    });
    result.features = [...new Set(result.features)].slice(0, 12);

    // Contact info
    const bodyText = document.body.innerText;
    const emailMatches = bodyText.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g);
    if (emailMatches) result.contact.emails = [...new Set(emailMatches)].slice(0, 3);
    const phoneMatches = bodyText.match(/(\+?\d[\d\s\-().]{7,}\d)/g);
    if (phoneMatches) result.contact.phones = [...new Set(phoneMatches.map(p => p.trim()))].slice(0, 3);
    const addressEl = document.querySelector('address, [class*="address" i], [class*="location" i]');
    if (addressEl) result.contact.address = addressEl.textContent.trim().substring(0, 200);

    // Brand colors — sample from UI elements
    const colorCounts = {};
    document.querySelectorAll('a, button, [class*="btn" i], [class*="cta" i], [class*="primary" i]').forEach(el => {
      const styles = getComputedStyle(el);
      [styles.backgroundColor, styles.color, styles.borderColor].forEach(c => {
        if (c && isSaturated(c)) {
          const rgb = parseRGB(c);
          if (rgb) { const hex = rgbToHex(rgb.r, rgb.g, rgb.b); colorCounts[hex] = (colorCounts[hex] || 0) + 1; }
        }
      });
    });
    document.querySelectorAll('h1, h2, h3').forEach(el => {
      const c = getComputedStyle(el).color;
      if (isSaturated(c)) {
        const rgb = parseRGB(c);
        if (rgb) { const hex = rgbToHex(rgb.r, rgb.g, rgb.b); colorCounts[hex] = (colorCounts[hex] || 0) + 1; }
      }
    });
    const rootStyles = getComputedStyle(document.documentElement);
    ['--primary', '--accent', '--brand', '--color-primary', '--theme-color'].forEach(prop => {
      const val = rootStyles.getPropertyValue(prop).trim();
      if (val && isSaturated(val)) {
        const rgb = parseRGB(val);
        if (rgb) { const hex = rgbToHex(rgb.r, rgb.g, rgb.b); colorCounts[hex] = (colorCounts[hex] || 0) + 5; }
      }
    });
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor?.content) result.colors.primary = themeColor.content;
    if (!result.colors.primary) {
      const sorted = Object.entries(colorCounts).sort((a, b) => b[1] - a[1]);
      if (sorted.length > 0) result.colors.primary = sorted[0][0];
    }
    result.colors.background = getComputedStyle(document.body).backgroundColor || '#ffffff';
    result.colors.textColor = getComputedStyle(document.body).color || '#333333';

    return result;
  });
}

// ─── Brochure generation from extracted content ──────────────────────────────

function planContentPages(sections) {
  const MAX_HEIGHT = 680;
  const pages = [];
  let currentPage = { sections: [], estimatedHeight: 0 };

  for (const section of sections) {
    let h = 40;
    h += section.paragraphs.length * 30;
    h += Math.ceil(section.listItems.length / 2) * 18;
    if (section.imageUrl) h += 160;

    if (currentPage.estimatedHeight + h > MAX_HEIGHT && currentPage.sections.length > 0) {
      pages.push(currentPage);
      currentPage = { sections: [], estimatedHeight: 0 };
    }
    currentPage.sections.push(section);
    currentPage.estimatedHeight += h;
  }
  if (currentPage.sections.length > 0) pages.push(currentPage);
  return pages.slice(0, 4);
}

function generateBrochureHTML(content, palette, size, port) {
  const isA4 = size === 'a4';
  const pageW = isA4 ? '210mm' : '148mm';
  const pageH = isA4 ? '297mm' : '210mm';

  function esc(str) {
    return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  const contentPages = planContentPages(content.sections);
  if (contentPages.length === 0 && (content.description || content.tagline)) {
    contentPages.push({
      sections: [{
        heading: 'About Us',
        level: 2,
        paragraphs: [content.description || content.tagline],
        listItems: content.features.slice(0, 6),
        imageUrl: content.images[1] || '',
      }],
      estimatedHeight: 300,
    });
  }

  const logoHTML = content.logoUrl
    ? `<img src="${esc(content.logoUrl)}" alt="Logo" style="height:40px;width:auto;object-fit:contain" onerror="this.style.display='none'">`
    : `<div class="font-heading" style="font-size:16px;font-weight:700;color:${palette.DARK};letter-spacing:0.04em">${esc(content.companyName)}</div>`;

  const heroHTML = content.heroImageUrl
    ? `<div style="margin:0 32px;height:${isA4 ? '300px' : '220px'};position:relative;overflow:hidden;background:${palette.WARM_BG}">
        <img src="${esc(content.heroImageUrl)}" alt="" style="width:100%;height:100%;object-fit:cover" onerror="this.parentElement.style.background='${palette.PRIMARY_LIGHT}'">
        <div style="position:absolute;bottom:0;left:0;right:0;padding:8px 12px;background:linear-gradient(to top,rgba(0,0,0,0.5),transparent)">
          <span class="font-mono" style="font-size:8px;color:rgba(255,255,255,0.8);letter-spacing:0.12em">${esc(content.companyName.toUpperCase())}</span>
        </div>
      </div>`
    : `<div style="margin:0 32px;height:${isA4 ? '300px' : '220px'};display:flex;align-items:center;justify-content:center;background:${palette.PRIMARY_LIGHT}">
        <span class="font-heading" style="font-size:120px;font-weight:700;color:${palette.PRIMARY};opacity:0.15">${esc(content.companyName.charAt(0))}</span>
      </div>`;

  const tags = (content.features.length > 0 ? content.features : content.navItems).slice(0, 4);
  const tagsHTML = tags.map(t => `<span class="tag">${esc(t.toUpperCase())}</span>`).join('\n          ');

  const taglineText = content.tagline || (content.description || '').substring(0, 120);

  // ── Cover page ──
  const coverPage = `
    <div class="page">
      <div class="accent-bar accent-top"></div>
      <div style="padding:20px 32px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid ${palette.BORDER}">
        ${logoHTML}
        <div style="text-align:right">
          <div class="font-mono" style="font-size:8px;color:${palette.LIGHT_TEXT};letter-spacing:0.12em">COMPANY OVERVIEW</div>
          <div class="font-mono" style="font-size:8px;color:${palette.PRIMARY};letter-spacing:0.12em">${new Date().getFullYear()}</div>
        </div>
      </div>
      ${heroHTML}
      <div style="padding:20px 32px;flex:1">
        ${tags.length > 0 ? `<div style="margin-bottom:4px">${tagsHTML}</div>` : ''}
        <h1 class="font-heading" style="font-size:${isA4 ? '42px' : '34px'};font-weight:700;line-height:1.1;margin-top:8px;color:${palette.DARK};letter-spacing:-0.01em">
          ${esc(content.companyName)}
        </h1>
        <div style="width:60px;height:3px;background:${palette.PRIMARY};margin:12px 0"></div>
        <p class="font-body" style="font-size:10.5px;line-height:1.7;color:${palette.MID};font-weight:300;max-width:360px">
          ${esc(content.description || content.tagline || '')}
        </p>
      </div>
      ${taglineText ? `
      <div style="margin:0 32px 20px;padding:10px 16px;background:${palette.PRIMARY_LIGHT};border-left:3px solid ${palette.PRIMARY}">
        <p class="font-body" style="font-size:11px;font-weight:600;font-style:italic;color:${palette.PRIMARY}">
          "${esc(taglineText)}"
        </p>
      </div>` : ''}
      <div class="accent-bar accent-bottom"></div>
    </div>`;

  // ── Content pages ──
  let contentPagesHTML = '';
  contentPages.forEach((pageData, pageIndex) => {
    const pageNum = pageIndex + 2;
    let sectionsHTML = '';

    pageData.sections.forEach((section, sIdx) => {
      const subNum = String(pageIndex + sIdx + 1).padStart(2, '0');
      const words = section.heading.split(' ');
      const lastWord = words.pop() || '';
      const headingMain = words.join(' ');

      sectionsHTML += `
        <div class="section-header" ${sIdx > 0 ? 'style="margin-top:16px"' : ''}>
          <span class="font-mono section-num">${subNum}</span>
          <h2 class="font-heading section-title">${esc(headingMain)} <span class="section-accent">${esc(lastWord)}</span></h2>
        </div>`;

      if (section.paragraphs.length > 0) {
        if (section.imageUrl && section.paragraphs.length <= 3) {
          sectionsHTML += `
          <div style="display:flex;gap:16px;margin-bottom:12px">
            <div style="flex:1">
              ${section.paragraphs.map(p => `<p class="font-body" style="font-size:10px;line-height:1.75;color:${palette.MID};font-weight:300;margin-bottom:8px">${esc(p)}</p>`).join('')}
            </div>
            <div style="flex:0 0 40%;height:140px;overflow:hidden;background:${palette.WARM_BG}">
              <img src="${esc(section.imageUrl)}" alt="" style="width:100%;height:100%;object-fit:cover" onerror="this.parentElement.style.display='none'">
            </div>
          </div>`;
        } else {
          sectionsHTML += section.paragraphs.map(p =>
            `<p class="font-body" style="font-size:10px;line-height:1.75;color:${palette.MID};font-weight:300;margin-bottom:8px">${esc(p)}</p>`
          ).join('');
          if (section.imageUrl) {
            sectionsHTML += `
            <div style="height:140px;overflow:hidden;margin:8px 0;background:${palette.WARM_BG}">
              <img src="${esc(section.imageUrl)}" alt="" style="width:100%;height:100%;object-fit:cover" onerror="this.parentElement.style.display='none'">
            </div>`;
          }
        }
      }

      if (section.listItems.length > 0) {
        if (section.listItems.length > 3 && !section.imageUrl) {
          sectionsHTML += `<div style="display:flex;flex-direction:column;gap:6px;margin:8px 0">`;
          section.listItems.slice(0, 8).forEach(item => {
            sectionsHTML += `
            <div style="display:flex;gap:8px;padding:8px 12px;background:${palette.WARM_BG};border-left:2px solid ${palette.PRIMARY}">
              <p class="font-body" style="font-size:9px;line-height:1.5;color:${palette.MID};font-weight:300">${esc(item)}</p>
            </div>`;
          });
          sectionsHTML += `</div>`;
        } else {
          sectionsHTML += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 16px;margin:8px 0">`;
          section.listItems.slice(0, 8).forEach(item => {
            sectionsHTML += `
            <div class="feature-dot">
              <span class="font-body" style="font-size:10px;line-height:1.5;color:${palette.MID};font-weight:300">${esc(item)}</span>
            </div>`;
          });
          sectionsHTML += `</div>`;
        }
      }

      if (sIdx < pageData.sections.length - 1) sectionsHTML += `<div class="divider"></div>`;
    });

    contentPagesHTML += `
    <div class="page">
      <div class="accent-bar accent-top"></div>
      <div style="flex:1;padding:24px 32px;display:flex;flex-direction:column">
        ${sectionsHTML}
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;padding:0 32px 20px">
        <span class="font-mono" style="font-size:8px;color:${palette.LIGHT_TEXT};letter-spacing:0.15em">${esc(content.companyName.toUpperCase())}</span>
        <span class="font-mono page-num">P.${String(pageNum).padStart(2, '0')}</span>
      </div>
      <div class="accent-bar accent-bottom"></div>
    </div>`;
  });

  // ── Contact page ──
  let contactDetailsHTML = '';
  if (content.contact.phones.length > 0) {
    contactDetailsHTML += `
    <div style="display:flex;align-items:center;gap:16px;padding:12px 16px;background:${palette.WARM_BG};border:1px solid ${palette.BORDER};border-left:3px solid ${palette.PRIMARY}">
      <span class="font-mono" style="font-size:8px;width:56px;flex-shrink:0;color:${palette.PRIMARY};letter-spacing:0.12em">PHONE</span>
      <span class="font-body" style="font-size:11px;font-weight:500;color:${palette.DARK}">${esc(content.contact.phones.join(' / '))}</span>
    </div>`;
  }
  if (content.contact.emails.length > 0) {
    contactDetailsHTML += `
    <div style="display:flex;align-items:center;gap:16px;padding:12px 16px;background:${palette.WARM_BG};border:1px solid ${palette.BORDER};border-left:3px solid ${palette.PRIMARY}">
      <span class="font-mono" style="font-size:8px;width:56px;flex-shrink:0;color:${palette.PRIMARY};letter-spacing:0.12em">EMAIL</span>
      <span class="font-body" style="font-size:11px;font-weight:500;color:${palette.DARK}">${esc(content.contact.emails.join(', '))}</span>
    </div>`;
  }
  contactDetailsHTML += `
  <div style="display:flex;align-items:center;gap:16px;padding:12px 16px;background:${palette.WARM_BG};border:1px solid ${palette.BORDER};border-left:3px solid ${palette.PRIMARY}">
    <span class="font-mono" style="font-size:8px;width:56px;flex-shrink:0;color:${palette.PRIMARY};letter-spacing:0.12em">WEBSITE</span>
    <span class="font-body" style="font-size:11px;font-weight:500;color:${palette.DARK}">${esc(content.contact.website || 'N/A')}</span>
  </div>`;

  const credentials = content.features.length > 0 ? content.features : content.navItems;
  const credentialsHTML = credentials.slice(0, 6).map(c => `
    <div style="display:flex;align-items:center;gap:8px;padding:6px 8px;background:${palette.PRIMARY_LIGHT};border:1px solid ${palette.PRIMARY_MID}">
      <div style="width:4px;height:4px;border-radius:50%;background:${palette.PRIMARY};flex-shrink:0"></div>
      <span class="font-body" style="font-size:9px;color:${palette.MID}">${esc(c)}</span>
    </div>`).join('');

  const addressCard = content.contact.address
    ? `<div style="padding:20px;background:${palette.PRIMARY};margin-bottom:16px">
        <div class="font-heading" style="font-size:11px;font-weight:700;color:white;margin-bottom:4px;letter-spacing:0.08em">HEADQUARTERS</div>
        <div class="font-heading" style="font-size:13px;font-weight:700;color:white">${esc(content.contact.address)}</div>
      </div>`
    : `<div style="padding:20px;background:${palette.PRIMARY};margin-bottom:16px">
        <div class="font-heading" style="font-size:13px;font-weight:700;color:white;letter-spacing:0.04em">${esc(content.companyName)}</div>
        ${content.tagline ? `<div class="font-body" style="font-size:11px;color:rgba(255,255,255,0.85);margin-top:4px">${esc(content.tagline.substring(0, 100))}</div>` : ''}
      </div>`;

  const contactPage = `
    <div class="page">
      <div class="accent-bar accent-top"></div>
      <div style="padding:20px 32px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid ${palette.BORDER}">
        ${logoHTML}
        <div style="text-align:right">
          <div class="font-heading" style="font-size:9px;font-weight:700;color:${palette.DARK};letter-spacing:0.06em">${esc(content.companyName.toUpperCase())}</div>
        </div>
      </div>
      <div style="flex:1;padding:24px 32px;display:flex;flex-direction:column">
        <div class="section-header">
          <span class="font-mono section-num">${String(contentPages.length + 1).padStart(2, '0')}</span>
          <h2 class="font-heading section-title">GET IN <span class="section-accent">TOUCH</span></h2>
        </div>
        ${addressCard}
        <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:20px">
          ${contactDetailsHTML}
        </div>
        <div class="divider"></div>
        ${credentials.length > 0 ? `
        <div style="margin-bottom:20px">
          <div class="font-mono" style="font-size:8.5px;font-weight:600;color:${palette.PRIMARY};letter-spacing:0.15em;margin-bottom:8px">KEY HIGHLIGHTS</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            ${credentialsHTML}
          </div>
        </div>` : ''}
        <div style="margin-top:auto;text-align:center;margin-bottom:8px">
          <div class="font-heading" style="font-size:18px;font-weight:700;font-style:italic;color:${palette.PRIMARY}">
            ${esc(content.companyName)}
          </div>
          ${content.tagline ? `<div class="font-body" style="font-size:9px;margin-top:4px;color:${palette.LIGHT_TEXT}">${esc(content.tagline.substring(0, 80))}</div>` : ''}
        </div>
      </div>
      <div class="accent-bar" style="height:6px"></div>
    </div>`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    @page { size: ${pageW} ${pageH}; margin: 0; }
    body { margin: 0; padding: 0; background: white; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .page { width: ${pageW}; height: ${pageH}; position: relative; overflow: hidden; display: flex; flex-direction: column; background: #ffffff; page-break-after: always; break-after: page; }
    .page:last-child { page-break-after: auto; break-after: auto; }
    .font-heading { font-family: 'Rajdhani', sans-serif; }
    .font-body { font-family: 'DM Sans', sans-serif; }
    .font-mono { font-family: 'JetBrains Mono', monospace; }
    .accent-bar { background: ${palette.PRIMARY}; width: 100%; }
    .accent-top { height: 6px; }
    .accent-bottom { height: 3px; }
    .section-header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 16px; }
    .section-num { font-size: 9px; font-weight: 500; color: ${palette.PRIMARY}; letter-spacing: 0.15em; }
    .section-title { font-size: 18px; font-weight: 700; line-height: 1.2; color: ${palette.DARK}; letter-spacing: -0.01em; }
    .section-accent { color: ${palette.PRIMARY}; }
    .tag { display: inline-block; padding: 2px 8px; font-size: 8px; font-weight: 500; font-family: 'JetBrains Mono', monospace; background: ${palette.PRIMARY_LIGHT}; color: ${palette.PRIMARY}; border: 1px solid ${palette.PRIMARY_MID}; letter-spacing: 0.08em; margin-right: 4px; }
    .feature-dot { display: flex; align-items: flex-start; gap: 8px; }
    .feature-dot::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: ${palette.PRIMARY}; flex-shrink: 0; margin-top: 5px; }
    .page-num { font-size: 8px; font-weight: 500; color: ${palette.PRIMARY}; letter-spacing: 0.1em; }
    .divider { width: 100%; height: 1px; background: ${palette.BORDER}; margin: 12px 0; }
  </style>
</head>
<body>
  ${coverPage}
  ${contentPagesHTML}
  ${contactPage}
</body>
</html>`;
}

// ─── Project analysis ────────────────────────────────────────────────────────
// Reads the uploaded project and figures out what kind of project it is,
// what the page/component variables are named, what CSS files exist, etc.

function analyzeProject(runDir, jobId) {
  logToJob(jobId, 'Analyzing project structure...', 'info');

  const analysis = {
    type: 'unknown',
    appFile: null,
    pagesVar: null,
    componentsVar: null,
    pageSize: { width: 559, height: 794 },
    existingImports: { useState: false, useEffect: false },
    exportName: null,
    cssFiles: [],
    hasVite: false,
    hasPackageJson: false,
  };

  // Check for package.json and Vite
  const pkgPath = path.join(runDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    analysis.hasPackageJson = true;
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      analysis.hasVite = 'vite' in allDeps ||
        (pkg.scripts && Object.values(pkg.scripts).some(s => s.includes('vite')));
    } catch {}
  }

  // Find App entry point
  const appMatch = findFile(runDir, [
    'src/app/App.tsx', 'src/App.tsx', 'src/app/App.jsx', 'src/App.jsx',
    'src/app/App.js', 'src/App.js', 'src/app/app.tsx', 'src/app/app.jsx',
    'src/app/app.js', 'src/App.ts',
  ]);

  if (appMatch) {
    analysis.appFile = appMatch.abs;
    const content = fs.readFileSync(appMatch.abs, 'utf8');

    // Check which React hooks are already imported
    analysis.existingImports.useState = /import\s[^;]*\buseState\b/.test(content);
    analysis.existingImports.useEffect = /import\s[^;]*\buseEffect\b/.test(content);

    // Find the default-exported component name
    const funcExport = content.match(/export\s+default\s+function\s+(\w+)\s*\(/);
    const bottomExport = content.match(/export\s+default\s+(\w+)\s*;?\s*$/m);
    if (funcExport) {
      analysis.exportName = funcExport[1];
    } else if (bottomExport) {
      analysis.exportName = bottomExport[1];
    }

    // Find a pages/slides array: const pages = ["cover", "about", ...] as const;
    const pageArrayRegex = /const\s+(\w+)\s*=\s*\[([\s\S]*?)\]\s*(as\s+const)?;/g;
    let match;
    while ((match = pageArrayRegex.exec(content)) !== null) {
      const items = match[2];
      const stringLiterals = items.match(/["'][^"']+["']/g);
      if (stringLiterals && stringLiterals.length >= 2) {
        analysis.pagesVar = match[1];
        break;
      }
    }

    // Find a component map: const pageComponents = { cover: CoverPage, ... }
    // Matches any object literal whose values are PascalCase identifiers
    const compMapRegex = /const\s+(\w+)\s*(?::\s*[^=]+?)?\s*=\s*\{([^}]+)\}/g;
    while ((match = compMapRegex.exec(content)) !== null) {
      const body = match[2];
      const pascalValues = body.match(/:\s*[A-Z][A-Za-z0-9]+/g);
      if (pascalValues && pascalValues.length >= 2) {
        analysis.componentsVar = match[1];
        break;
      }
    }

    // Try to discover native page pixel dimensions (A5_W, PAGE_WIDTH, etc.)
    const wMatch = content.match(/(?:A5_W|A4_W|PAGE_W(?:IDTH)?|CARD_W(?:IDTH)?)\s*=\s*(\d+)/);
    const hMatch = content.match(/(?:A5_H|A4_H|PAGE_H(?:EIGHT)?|CARD_H(?:EIGHT)?)\s*=\s*(\d+)/);
    if (wMatch) analysis.pageSize.width = parseInt(wMatch[1]);
    if (hMatch) analysis.pageSize.height = parseInt(hMatch[1]);
  }

  // Collect candidate CSS files
  const cssCandidates = [
    'src/styles/index.css', 'src/index.css', 'src/styles/globals.css',
    'src/globals.css', 'src/App.css', 'src/app/App.css', 'src/style.css',
    'src/styles/global.css', 'styles/index.css', 'src/main.css',
  ];
  for (const c of cssCandidates) {
    const p = path.join(runDir, c);
    if (fs.existsSync(p)) analysis.cssFiles.push(p);
  }

  // Determine project type
  if (analysis.appFile && analysis.pagesVar && analysis.componentsVar && analysis.exportName) {
    analysis.type = 'brochure';
  } else if (analysis.appFile || analysis.hasVite) {
    analysis.type = 'react-app';
  } else if (fs.existsSync(path.join(runDir, 'index.html'))) {
    analysis.type = 'static';
  }

  logToJob(jobId, `Detected project type: ${analysis.type}`, 'info');
  if (analysis.type === 'brochure') {
    logToJob(jobId, `  Pages array  → "${analysis.pagesVar}"`, 'info');
    logToJob(jobId, `  Component map → "${analysis.componentsVar}"`, 'info');
    logToJob(jobId, `  Export name   → "${analysis.exportName}"`, 'info');
    logToJob(jobId, `  Page size     → ${analysis.pageSize.width}×${analysis.pageSize.height}px`, 'info');
  } else if (analysis.type === 'react-app') {
    logToJob(jobId, 'No page array or component map found — will capture rendered page directly.', 'info');
  }

  return analysis;
}

// ─── Print-mode patching ─────────────────────────────────────────────────────

function patchCSS(analysis, runDir, jobId) {
  const cssPath = analysis.cssFiles[0];
  if (!cssPath) {
    logToJob(jobId, 'No CSS file found — skipping print style injection.', 'info');
    return;
  }

  const existing = fs.readFileSync(cssPath, 'utf8');
  if (existing.includes('.print-page')) {
    logToJob(jobId, 'Print CSS already present.', 'info');
    return;
  }

  const printCSS = `
@media print {
  @page {
    size: 148mm 210mm;
    margin: 0;
  }

  html, body, #root {
    height: auto !important;
    overflow: visible !important;
  }

  body, html {
    margin: 0 !important;
    padding: 0 !important;
    background: #ffffff !important;
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
  }

  .print-page {
    width: 148mm !important;
    height: 210mm !important;
    page-break-inside: avoid !important;
    break-inside: avoid !important;
    overflow: hidden !important;
    margin: 0 !important;
    padding: 0 !important;
    box-sizing: border-box !important;
    display: flex !important;
    justify-content: center !important;
    align-items: center !important;
    background: #ffffff !important;
  }

  .print-page:not(:last-child) {
    page-break-after: always !important;
    break-after: page !important;
  }

  .print-page.size-a4 {
    width: 210mm !important;
    height: 297mm !important;
  }

  .print-page.size-a5 {
    width: 148mm !important;
    height: 210mm !important;
  }
}
`;
  fs.appendFileSync(cssPath, printCSS, 'utf8');
  logToJob(jobId, `Patched ${path.basename(cssPath)} with print styles.`, 'success');
}

function patchBrochureApp(analysis, jobId) {
  let content = fs.readFileSync(analysis.appFile, 'utf8');

  if (content.includes('isPrint')) {
    logToJob(jobId, 'App already has print-mode support — skipping.', 'info');
    return true;
  }

  // ── Merge missing React hook imports ──
  const neededHooks = [];
  if (!analysis.existingImports.useState) neededHooks.push('useState');
  if (!analysis.existingImports.useEffect) neededHooks.push('useEffect');

  if (neededHooks.length > 0) {
    const reactImportRe = /import\s*\{([^}]+)\}\s*from\s*["']react["'];?/;
    const m = content.match(reactImportRe);
    if (m) {
      const existing = m[1].split(',').map(s => s.trim()).filter(Boolean);
      const merged = [...new Set([...existing, ...neededHooks])].join(', ');
      content = content.replace(m[0], `import { ${merged} } from "react";`);
    } else {
      content = `import { ${neededHooks.join(', ')} } from "react";\n` + content;
    }
  }

  // ── Build the print-mode code block using discovered variable names ──
  const { pagesVar, componentsVar, pageSize } = analysis;
  const W = pageSize.width;
  const H = pageSize.height;

  // Uses string concatenation in the injected code to avoid template-literal escaping issues
  const printBlock = `
  const isPrint = typeof window !== "undefined" && window.location.search.includes("print");
  const isA4 = typeof window !== "undefined" && window.location.search.includes("size=a4");
  const [fontsLoaded, setFontsLoaded] = useState(false);

  useEffect(() => {
    if (isPrint) {
      document.fonts.ready
        .then(() => setTimeout(() => setFontsLoaded(true), 500))
        .catch(() => setFontsLoaded(true));
    } else {
      setFontsLoaded(true);
    }
  }, [isPrint]);

  useEffect(() => {
    if (isPrint) {
      const s = document.createElement("style");
      s.innerHTML = "@page { size: " + (isA4 ? "210mm 297mm" : "148mm 210mm") + "; margin: 0; }";
      document.head.appendChild(s);
      return () => document.head.removeChild(s);
    }
  }, [isPrint, isA4]);

  if (isPrint) {
    if (!fontsLoaded) {
      return (
        <div style={{ background: "white", width: "148mm", height: "210mm", padding: 40, fontFamily: "sans-serif", color: "#666" }}>
          Loading fonts and preparing document layout...
        </div>
      );
    }
    return (
      <div className="w-full flex flex-col items-center bg-white">
        {${pagesVar}.map(p => {
          const PC = ${componentsVar}[p];
          return (
            <div
              key={p}
              className={"print-page relative overflow-hidden bg-white " + (isA4 ? "size-a4" : "size-a5")}
              style={{
                width: isA4 ? "210mm" : "148mm",
                height: isA4 ? "297mm" : "210mm"
              }}
            >
              <div style={{
                transform: isA4 ? "scale(1.414)" : "none",
                transformOrigin: "center",
                width: "${W}px",
                height: "${H}px",
                flexShrink: 0
              }}>
                <PC />
              </div>
            </div>
          );
        })}
      </div>
    );
  }`;

  // ── Find the injection point ──
  // Try: export default function Name() {
  const inlineSig = `export default function ${analysis.exportName}(`;
  let injected = false;

  if (content.includes(inlineSig)) {
    const sigIdx = content.indexOf(inlineSig);
    const braceIdx = content.indexOf('{', sigIdx + inlineSig.length);
    if (braceIdx !== -1) {
      content = content.slice(0, braceIdx + 1) + '\n' + printBlock + '\n' + content.slice(braceIdx + 1);
      injected = true;
    }
  }

  // Fallback: function Name() {  (with export default Name elsewhere)
  if (!injected) {
    const standaloneSig = `function ${analysis.exportName}(`;
    if (content.includes(standaloneSig)) {
      const sigIdx = content.indexOf(standaloneSig);
      const braceIdx = content.indexOf('{', sigIdx + standaloneSig.length);
      if (braceIdx !== -1) {
        content = content.slice(0, braceIdx + 1) + '\n' + printBlock + '\n' + content.slice(braceIdx + 1);
        injected = true;
      }
    }
  }

  // Fallback: const Name = (...) => {
  if (!injected) {
    const arrowRe = new RegExp(`(?:const|let|var)\\s+${analysis.exportName}\\s*=\\s*\\([^)]*\\)\\s*=>\\s*\\{`);
    const arrowMatch = content.match(arrowRe);
    if (arrowMatch) {
      const matchEnd = arrowMatch.index + arrowMatch[0].length;
      content = content.slice(0, matchEnd) + '\n' + printBlock + '\n' + content.slice(matchEnd);
      injected = true;
    }
  }

  if (!injected) {
    logToJob(jobId, `Could not find component function "${analysis.exportName}" — falling back to generic capture.`, 'info');
    return false;
  }

  fs.writeFileSync(analysis.appFile, content, 'utf8');
  logToJob(jobId, 'Patched App with adaptive print-mode rendering.', 'success');
  return true;
}

function patchForPrint(analysis, runDir, jobId) {
  if (analysis.type === 'brochure') {
    patchCSS(analysis, runDir, jobId);
    const success = patchBrochureApp(analysis, jobId);
    if (!success) {
      analysis.type = 'react-app';
      logToJob(jobId, 'Brochure patch failed — downgrading to generic page capture.', 'info');
    }
  }

  if (analysis.type === 'react-app' || analysis.type === 'static') {
    logToJob(jobId, 'Will capture rendered page directly for PDF output.', 'info');
    if (analysis.cssFiles.length > 0) {
      const cssPath = analysis.cssFiles[0];
      const css = fs.readFileSync(cssPath, 'utf8');
      if (!css.includes('print-color-adjust')) {
        fs.appendFileSync(cssPath, `
@media print {
  body, html {
    margin: 0 !important;
    padding: 0 !important;
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
  }
}
`, 'utf8');
        logToJob(jobId, 'Added minimal print CSS for color accuracy.', 'success');
      }
    }
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────────

app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const jobId = Math.random().toString(36).substring(2, 15);
  const zipPath = req.file.path;
  const size = req.body.size || 'a5';

  activeJobs.set(jobId, {
    zipPath,
    res: null,
    status: 'pending',
    size
  });

  processJob(jobId, zipPath, size);
  res.json({ jobId });
});

app.get('/logs/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  const job = activeJobs.get(jobId);

  if (!job) {
    return res.status(404).send('Job not found');
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  job.res = res;
  logToJob(jobId, 'Connected to PDF Brochure Compiler.', 'system');
  progressJob(jobId, 5, 'Initializing...');
});

app.get('/download/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  const pdfPath = path.join(JOBS_DIR, jobId, 'brochure.pdf');

  if (fs.existsSync(pdfPath)) {
    res.download(pdfPath, 'brochure.pdf');
  } else {
    res.status(404).send('PDF not found or not yet generated.');
  }
});

// ─── Job processor ───────────────────────────────────────────────────────────

async function processJob(jobId, zipPath, size) {
  const jobDir = path.join(JOBS_DIR, jobId);
  let viteProcess = null;
  let staticServer = null;
  let browser = null;

  try {
    fs.mkdirSync(jobDir, { recursive: true });

    // Step 1: Extract
    logToJob(jobId, 'Extracting ZIP archive...', 'info');
    progressJob(jobId, 10, 'Extracting ZIP...');

    const zip = new AdmZip(zipPath);
    zip.extractAllTo(jobDir, true);

    let runDir = jobDir;
    const contents = fs.readdirSync(jobDir);
    if (contents.length === 1 && fs.statSync(path.join(jobDir, contents[0])).isDirectory()) {
      runDir = path.join(jobDir, contents[0]);
      logToJob(jobId, `Nested directory detected: ${contents[0]}`, 'info');
    }
    logToJob(jobId, 'Archive extracted.', 'success');

    // Step 2: Analyze
    progressJob(jobId, 15, 'Analyzing project...');
    const analysis = analyzeProject(runDir, jobId);

    // Step 3: Patch
    progressJob(jobId, 20, 'Preparing print mode...');
    patchForPrint(analysis, runDir, jobId);

    // Step 4: Install deps & start server
    const port = await getFreePort();

    if (analysis.hasVite && analysis.hasPackageJson) {
      progressJob(jobId, 25, 'Installing dependencies...');
      await runInstall(jobId, runDir);

      progressJob(jobId, 40, 'Starting dev server...');
      logToJob(jobId, `Launching Vite on port ${port}...`, 'info');

      viteProcess = spawn('npx', ['vite', '--host', '0.0.0.0', '--port', port.toString(), '--strictPort'], {
        cwd: runDir,
        shell: true,
        stdio: 'pipe'
      });

      viteProcess.stdout.on('data', d => {
        const line = d.toString().trim();
        if (line) logToJob(jobId, `[vite] ${line}`, 'info');
      });
      viteProcess.stderr.on('data', d => {
        const line = d.toString().trim();
        if (line) logToJob(jobId, `[vite] ${line}`, 'error');
      });
    } else if (analysis.hasPackageJson) {
      progressJob(jobId, 25, 'Installing dependencies...');
      await runInstall(jobId, runDir);

      progressJob(jobId, 40, 'Starting dev server...');
      logToJob(jobId, `Starting npm dev server on port ${port}...`, 'info');

      viteProcess = spawn('npx', ['serve', '-l', port.toString(), '-s'], {
        cwd: runDir,
        shell: true,
        stdio: 'pipe'
      });
      viteProcess.stdout.on('data', d => {
        const line = d.toString().trim();
        if (line) logToJob(jobId, `[serve] ${line}`, 'info');
      });
      viteProcess.stderr.on('data', d => {
        const line = d.toString().trim();
        if (line) logToJob(jobId, `[serve] ${line}`, 'info');
      });
    } else {
      progressJob(jobId, 40, 'Starting static server...');
      logToJob(jobId, `Serving static files on port ${port}...`, 'info');
      staticServer = await startStaticServer(runDir, port);
    }

    await checkServerReady(port);
    logToJob(jobId, 'Server ready.', 'success');
    progressJob(jobId, 50, 'Launching headless browser...');

    // Step 5: Render with Puppeteer
    logToJob(jobId, 'Launching headless Chrome...', 'info');
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-setuid-sandbox', '--disable-gpu']
    });

    const page = await browser.newPage();

    const pdfWidth = size === 'a4' ? '210mm' : '148mm';
    const pdfHeight = size === 'a4' ? '297mm' : '210mm';
    const pdfPath = path.join(jobDir, 'brochure.pdf');

    if (analysis.type === 'brochure') {
      // ── Brochure template path ──
      const targetUrl = `http://127.0.0.1:${port}/?print&size=${size}`;
      logToJob(jobId, `Navigating to ${targetUrl}`, 'info');
      progressJob(jobId, 65, 'Rendering brochure...');

      await page.goto(targetUrl, { waitUntil: 'networkidle0', timeout: 30000 });

      logToJob(jobId, 'Waiting for web fonts...', 'info');
      progressJob(jobId, 80, 'Loading fonts...');

      await page.evaluate(async () => { await document.fonts.ready; });
      await page.evaluate(async () => {
        await new Promise((resolve) => {
          const check = () => {
            if (!document.body.innerText.includes('Loading fonts and preparing document layout')) resolve();
            else setTimeout(check, 100);
          };
          check();
        });
      });

      logToJob(jobId, `Generating ${size.toUpperCase()} PDF...`, 'info');
      progressJob(jobId, 90, 'Exporting PDF...');

      await page.pdf({
        path: pdfPath, width: pdfWidth, height: pdfHeight,
        margin: { top: 0, right: 0, bottom: 0, left: 0 },
        printBackground: true, preferCSSPageSize: true,
      });

    } else {
      // ── Website-to-brochure path ──
      await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 });

      const siteUrl = `http://127.0.0.1:${port}/`;
      logToJob(jobId, `Navigating to ${siteUrl} for content extraction...`, 'info');
      progressJob(jobId, 55, 'Loading website...');

      await page.goto(siteUrl, { waitUntil: 'networkidle0', timeout: 30000 });

      logToJob(jobId, 'Extracting website content...', 'info');
      progressJob(jobId, 65, 'Extracting content...');

      const extracted = await extractWebsiteContent(page, jobId);
      logToJob(jobId, `Extracted: "${extracted.companyName}", ${extracted.sections.length} sections, ${extracted.images.length} images`, 'info');

      const primaryColor = extracted.colors.primary || '#2563eb';
      const palette = derivePalette(primaryColor);
      logToJob(jobId, `Brand color: ${primaryColor}`, 'info');

      logToJob(jobId, 'Generating brochure layout...', 'info');
      progressJob(jobId, 75, 'Building brochure...');

      const brochureHTML = generateBrochureHTML(extracted, palette, size, port);

      logToJob(jobId, 'Rendering generated brochure...', 'info');
      progressJob(jobId, 80, 'Rendering brochure...');

      await page.setContent(brochureHTML, { waitUntil: 'networkidle0', timeout: 30000 });
      await page.evaluate(async () => { await document.fonts.ready; });
      await new Promise(r => setTimeout(r, 1000));

      logToJob(jobId, `Generating ${size.toUpperCase()} PDF...`, 'info');
      progressJob(jobId, 90, 'Exporting PDF...');

      await page.pdf({
        path: pdfPath, width: pdfWidth, height: pdfHeight,
        margin: { top: 0, right: 0, bottom: 0, left: 0 },
        printBackground: true, preferCSSPageSize: true,
      });
    }

    logToJob(jobId, `PDF exported. Size: ${(fs.statSync(pdfPath).size / 1024).toFixed(2)} KB`, 'success');
    progressJob(jobId, 95, 'Cleaning up...');

    // Step 6: Cleanup
    await browser.close();
    browser = null;
    if (viteProcess) { viteProcess.kill(); viteProcess = null; }
    if (staticServer) { staticServer.close(); staticServer = null; }

    try {
      fs.unlinkSync(zipPath);
      const cleanDirectory = (dir, keepFile) => {
        const items = fs.readdirSync(dir);
        for (const item of items) {
          const itemPath = path.join(dir, item);
          if (itemPath === keepFile) continue;
          if (fs.statSync(itemPath).isDirectory()) {
            cleanDirectory(itemPath, keepFile);
            try { fs.rmdirSync(itemPath); } catch {}
          } else {
            fs.unlinkSync(itemPath);
          }
        }
      };
      cleanDirectory(jobDir, pdfPath);
    } catch (e) {
      logToJob(jobId, `Cleanup note: ${e.message}`, 'info');
    }

    logToJob(jobId, 'Done.', 'success');
    sendJobEvent(jobId, { type: 'success' });
    activeJobs.delete(jobId);

  } catch (error) {
    logToJob(jobId, `Error: ${error.message}`, 'error');
    sendJobEvent(jobId, { type: 'error', text: error.message });
    if (browser) await browser.close().catch(() => {});
    if (viteProcess) viteProcess.kill();
    if (staticServer) staticServer.close();
    try { fs.unlinkSync(zipPath); } catch {}
  }
}

app.listen(PORT, () => {
  console.log(`PDF Generator Portal running at http://localhost:${PORT}`);
});
