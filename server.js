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
const PORT = 3000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const JOBS_DIR = path.join(__dirname, 'jobs');
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// Ensure directories exist
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(JOBS_DIR)) fs.mkdirSync(JOBS_DIR, { recursive: true });

// Multer setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage });

// Active jobs logging mapping
const activeJobs = new Map();

app.use(express.static(path.join(__dirname, 'public')));

// Get a free port dynamically
function getFreePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

// Poll server until ready
function checkServerReady(port) {
  return new Promise((resolve) => {
    const check = () => {
      http.get(`http://localhost:${port}/`, (res) => {
        if (res.statusCode === 200) {
          resolve(true);
        } else {
          setTimeout(check, 200);
        }
      }).on('error', () => {
        setTimeout(check, 200);
      });
    };
    check();
  });
}

// Helper to log SSE messages
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

// 1. Upload route
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const jobId = Math.random().toString(36).substring(2, 15);
  const zipPath = req.file.path;
  const size = req.body.size || 'a5';
  
  // Set up job tracking
  activeJobs.set(jobId, {
    zipPath,
    res: null,
    status: 'pending',
    size
  });

  // Start processing in background
  processJob(jobId, zipPath, size);

  res.json({ jobId });
});

// 2. Logs SSE endpoint
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
  
  // Send initial state
  logToJob(jobId, 'Connected to PDF Brochure Compiler.', 'system');
  progressJob(jobId, 5, 'Initializing extraction...');
});

// 3. Download endpoint
app.get('/download/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  const pdfPath = path.join(JOBS_DIR, jobId, 'brochure.pdf');
  
  if (fs.existsSync(pdfPath)) {
    res.download(pdfPath, 'brochure.pdf');
  } else {
    res.status(404).send('PDF not found or not yet generated.');
  }
});

// Background processor
async function processJob(jobId, zipPath, size) {
  const jobDir = path.join(JOBS_DIR, jobId);
  let viteProcess = null;
  let browser = null;

  try {
    fs.mkdirSync(jobDir, { recursive: true });
    
    // Step 1: Extraction
    logToJob(jobId, 'Extracting codebase ZIP archive...', 'info');
    progressJob(jobId, 15, 'Extracting ZIP...');
    
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(jobDir, true);
    
    // Handle nested workspace directory root (e.g. from GitHub zips)
    let runDir = jobDir;
    const contents = fs.readdirSync(jobDir);
    if (contents.length === 1 && fs.statSync(path.join(jobDir, contents[0])).isDirectory()) {
      runDir = path.join(jobDir, contents[0]);
      logToJob(jobId, `Detected nested directory: ${contents[0]}`, 'info');
    }

    logToJob(jobId, 'Codebase extracted successfully.', 'success');

    // Step 1.5: Auto-patch codebase to support print-mode and scaling
    logToJob(jobId, 'Auto-patching codebase for printing and scaling...', 'info');
    
    // Patch index.css
    const indexCssPath = path.join(runDir, 'src/styles/index.css');
    if (fs.existsSync(indexCssPath)) {
      const existingCss = fs.readFileSync(indexCssPath, 'utf8');
      if (!existingCss.includes('.print-page')) {
        const printStyles = `
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
        fs.appendFileSync(indexCssPath, printStyles, 'utf8');
        logToJob(jobId, 'Patched index.css successfully.', 'success');
      }
    }

    // Patch App.tsx
    const appTsxPath = path.join(runDir, 'src/app/App.tsx');
    if (fs.existsSync(appTsxPath)) {
      let appContent = fs.readFileSync(appTsxPath, 'utf8');
      if (!appContent.includes('isPrint')) {
        // Prepend useEffect import
        appContent = `import { useEffect } from "react";\n` + appContent;
        // Inject layout interceptor
        appContent = appContent.replace(
          'export default function App() {',
          `export default function App() {
  const isPrint = typeof window !== "undefined" && window.location.search.includes("print");
  const isA4 = typeof window !== "undefined" && window.location.search.includes("size=a4");
  const [fontsLoaded, setFontsLoaded] = useState(false);

  useEffect(() => {
    if (isPrint) {
      document.fonts.ready
        .then(() => {
          setTimeout(() => setFontsLoaded(true), 500);
        })
        .catch(err => {
          console.error("Fonts ready error:", err);
          setFontsLoaded(true);
        });
    } else {
      setFontsLoaded(true);
    }
  }, [isPrint]);

  useEffect(() => {
    if (isPrint) {
      const style = document.createElement("style");
      style.innerHTML = \`@page { size: \${isA4 ? "210mm 297mm" : "148mm 210mm"}; margin: 0; }\`;
      document.head.appendChild(style);
      return () => {
        document.head.removeChild(style);
      };
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
        {pages.map(p => {
          const PC = pageComponents[p];
          return (
            <div
              key={p}
              className={\`print-page relative overflow-hidden bg-white \${isA4 ? "size-a4" : "size-a5"}\`}
              style={{
                width: isA4 ? "210mm" : "148mm",
                height: isA4 ? "297mm" : "210mm"
              }}
            >
              <div style={{
                transform: isA4 ? "scale(1.414)" : "none",
                transformOrigin: "center",
                width: "559px",
                height: "794px",
                flexShrink: 0
              }}>
                <PC />
              </div>
            </div>
          );
        })}
      </div>
    );
  }`
        );
        fs.writeFileSync(appTsxPath, appContent, 'utf8');
        logToJob(jobId, 'Patched App.tsx successfully.', 'success');
      }
    }

    progressJob(jobId, 30, 'Starting compiler sandbox...');

    // Step 2: Acquire Port & Launch Vite
    const port = await getFreePort();
    logToJob(jobId, `Starting Vite sandbox server on port ${port}...`, 'info');

    viteProcess = spawn('npx', ['vite', '--port', port.toString(), '--strictPort'], {
      cwd: runDir,
      shell: true,
      stdio: 'pipe'
    });

    viteProcess.stdout.on('data', (data) => {
      const line = data.toString().trim();
      if (line) logToJob(jobId, `[Vite] ${line}`, 'info');
    });

    viteProcess.stderr.on('data', (data) => {
      const line = data.toString().trim();
      if (line) logToJob(jobId, `[Vite Error] ${line}`, 'error');
    });

    // Wait for Vite server to listen
    await checkServerReady(port);
    logToJob(jobId, 'Vite sandbox server is ready.', 'success');
    progressJob(jobId, 50, 'Opening headless Chrome...');

    // Step 3: Launch Puppeteer and render
    logToJob(jobId, 'Launching headless Chrome browser...', 'info');
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
    });

    const page = await browser.newPage();
    const printUrl = `http://localhost:${port}/?print&size=${size}`;
    logToJob(jobId, `Navigating to target brochure page: ${printUrl}`, 'info');
    progressJob(jobId, 65, 'Rendering brochure page...');

    // Navigate and wait for network activity to settle
    await page.goto(printUrl, {
      waitUntil: 'networkidle0',
      timeout: 30000
    });

    // Wait for the fonts to load and the loading screen to disappear
    logToJob(jobId, 'Waiting for document web fonts to load...', 'info');
    progressJob(jobId, 80, 'Loading Google fonts...');
    
    // Evaluate document.fonts.ready and custom App.tsx font loading state
    await page.evaluate(async () => {
      await document.fonts.ready;
      // Wait for fontsLoaded react hook state to resolve to true
      await new Promise((resolve) => {
        const check = () => {
          if (!document.body.innerText.includes("Loading fonts and preparing document layout")) {
            resolve();
          } else {
            setTimeout(check, 100);
          }
        };
        check();
      });
    });

    const pdfWidth = size === 'a4' ? '210mm' : '148mm';
    const pdfHeight = size === 'a4' ? '297mm' : '210mm';

    logToJob(jobId, `Fonts loaded. Generating ${size.toUpperCase()} PDF...`, 'info');
    progressJob(jobId, 90, 'Exporting PDF...');

    const pdfPath = path.join(jobDir, 'brochure.pdf');
    await page.pdf({
      path: pdfPath,
      width: pdfWidth,
      height: pdfHeight,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      printBackground: true
    });

    logToJob(jobId, `PDF exported successfully. File size: ${(fs.statSync(pdfPath).size / 1024).toFixed(2)} KB`, 'success');
    progressJob(jobId, 95, 'Cleaning up...');
    
    // Close browser & Vite
    await browser.close();
    browser = null;
    viteProcess.kill();
    viteProcess = null;

    // Clean up zip and temporary folders (except brochure.pdf)
    try {
      fs.unlinkSync(zipPath);
      // Clean up extracted files to save space, keeping only brochure.pdf
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
      logToJob(jobId, `Cleanup warning: ${e.message}`, 'info');
    }

    logToJob(jobId, 'Sandbox cleanup complete.', 'success');
    
    // Complete SSE stream
    sendJobEvent(jobId, { type: 'success' });
    activeJobs.delete(jobId);

  } catch (error) {
    logToJob(jobId, `Error processing: ${error.message}`, 'error');
    sendJobEvent(jobId, { type: 'error', text: error.message });
    
    // Cleanup on error
    if (browser) await browser.close().catch(() => {});
    if (viteProcess) viteProcess.kill();
    try { fs.unlinkSync(zipPath); } catch {}
  }
}

app.listen(PORT, () => {
  console.log(`PDF Generator Portal running at http://localhost:${PORT}`);
});
