# PDF Brochure Engine

A self-hosted tool that converts Vite + React brochure codebases into print-ready PDFs. Design your brochure pages in Figma, export the code, upload the ZIP, and get a pixel-perfect A5 or A4 PDF -- no manual print styling required.

## Workflow

```
Design in Figma ──> Export code ──> ZIP it ──> Upload to engine ──> Get PDF
```

### Design-to-PDF Pipeline

1. **Design** your brochure pages in [Figma](https://www.figma.com/) -- each page as a separate frame (e.g. 559 x 794 px for A5 proportions)
2. **Export code** using a Figma-to-code plugin (e.g. Locofy, Anima, or Builder.io) that outputs a Vite + React + Tailwind project
3. **Download** the exported project and ZIP it (exclude `node_modules`)
4. **Upload** the ZIP to this engine and pick your print size (A5 or A4)
5. **Download** your print-ready `brochure.pdf`

The engine handles all print layout concerns automatically -- you just focus on the design.

## How It Works

```
ZIP Upload ──> Extract to sandbox ──> Auto-patch CSS & React code
     ──> Start ephemeral Vite dev server ──> Render in headless Chrome
     ──> Wait for fonts + network idle ──> Export PDF ──> Cleanup
```

1. **Upload** a `.zip` of your Vite + React brochure project (excluding `node_modules`)
2. **Extract** the archive into an isolated `jobs/<jobId>/` sandbox
3. **Auto-patch** `src/styles/index.css` with `@media print` rules and `src/app/App.tsx` with a print-mode layout interceptor that handles font loading and page sizing
4. **Launch** a Vite dev server on a dynamically allocated port
5. **Render** the page in headless Chrome (Puppeteer) with `?print&size=a5|a4`
6. **Export** a margin-free PDF with exact page dimensions and full background colors
7. **Cleanup** all sandbox files, keeping only the generated `brochure.pdf`

Real-time progress and logs are streamed to the browser via Server-Sent Events (SSE).

## Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [Google Chrome](https://www.google.com/chrome/) installed at the default Windows path (`C:\Program Files\Google\Chrome\Application\chrome.exe`)

> To use a different Chrome path or OS, update `CHROME_PATH` in [server.js](server.js#L19).

## Getting Started

```bash
git clone https://github.com/<your-username>/BrochureMaker.git
cd BrochureMaker
npm install
npm start
```

Open [http://localhost:3080](http://localhost:3080) in your browser.

## Usage

### Preparing Your Brochure in Figma

1. Create a new Figma file with one frame per brochure page (recommended: 559 x 794 px for A5 proportions)
2. Design your pages -- typography, images, backgrounds, icons, etc.
3. Use a Figma-to-code plugin to export as a Vite + React project:
   - [Locofy](https://www.locofy.ai/) -- exports production-ready React/Tailwind code
   - [Anima](https://www.animaapp.com/) -- converts Figma designs to React
   - [Builder.io](https://www.builder.io/figma) -- Figma to code with AI
4. Download the exported project folder
5. ZIP it (**excluding** `node_modules`)

### Generating the PDF

1. Open the portal UI at `http://localhost:3080`
2. Drag and drop or browse to select the ZIP file
3. Choose a print size: **A5** (148 x 210 mm) or **A4** (210 x 297 mm, 1.41x scaled)
4. Click **Generate Brochure PDF**
5. Watch the real-time terminal logs as the engine processes your codebase
6. Download the generated `brochure.pdf`

## Auto-Patching

The engine automatically injects print-mode support into the uploaded codebase so it works without any manual modification.

### CSS Patch (`src/styles/index.css`)

Appends `@media print` rules that:
- Set `@page` size to match the selected format (A5 or A4)
- Force `height: auto` and `overflow: visible` on the document root
- Apply `page-break-after: always` between `.print-page` elements
- Enable `print-color-adjust: exact` for accurate background rendering

### React Patch (`src/app/App.tsx`)

Injects into the `App()` component:
- A `?print` query parameter check to activate print layout
- A `?size=a4` check for A4 scaling (`transform: scale(1.414)` from center)
- A `document.fonts.ready` hook to defer rendering until all Google Fonts are loaded
- A print-mode render path that wraps each page in a `.print-page` container

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/upload` | Upload a ZIP file. Returns `{ jobId }`. Accepts multipart form with `file` (ZIP) and `size` (`a5` or `a4`). |
| `GET` | `/logs/:jobId` | SSE stream of real-time processing logs and progress updates. |
| `GET` | `/download/:jobId` | Download the generated `brochure.pdf` for a completed job. |

## Project Structure

```
BrochureMaker/
  server.js        # Express server, Puppeteer PDF pipeline, auto-patching logic
  package.json     # Dependencies and start script
  public/          # Portal frontend (served as static files)
    index.html     # Upload UI with drag-and-drop and size selector
    styles.css     # Dark theme styling with ambient glow effects
    app.js         # Frontend logic: file handling, SSE log streaming
  uploads/         # Temporary storage for uploaded ZIP files
  jobs/            # Sandboxed extraction and PDF output per job
```

## Tech Stack

- **Express** -- HTTP server and file upload handling
- **Multer** -- Multipart form parsing for ZIP uploads
- **adm-zip** -- ZIP extraction
- **Puppeteer Core** -- Headless Chrome automation for PDF rendering
- **Vite** -- Ephemeral dev server for rendering the brochure (spawned per job from the uploaded codebase)
- **SSE** -- Real-time log streaming to the browser

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server listen port |
| `CHROME_PATH` | `C:\Program Files\Google\Chrome\Application\chrome.exe` | Path to Chrome executable |
| `UPLOADS_DIR` | `./uploads` | Temporary ZIP storage |
| `JOBS_DIR` | `./jobs` | Per-job sandbox directory |

## License

MIT
