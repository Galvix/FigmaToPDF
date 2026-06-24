const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const submitBtn = document.getElementById('submit-btn');
const selectedFileInfo = document.getElementById('selected-file');
const fileNameEl = document.getElementById('file-name');
const fileSizeEl = document.getElementById('file-size');
const removeFileBtn = document.getElementById('remove-file');
const dropzoneContent = document.querySelector('.dropzone-content');

const progressContainer = document.getElementById('progress-container');
const progressBar = document.getElementById('progress-bar');
const progressPercent = document.getElementById('progress-percent');
const logTerminal = document.getElementById('log-terminal');
const statusText = document.querySelector('.status-text');

const successContainer = document.getElementById('success-container');
const downloadLink = document.getElementById('download-link');

let selectedFile = null;

// Drag & Drop handlers
['dragenter', 'dragover'].forEach(eventName => {
  dropzone.addEventListener(eventName, (e) => {
    e.preventDefault();
    dropzone.classList.add('active');
  }, false);
});

['dragleave', 'drop'].forEach(eventName => {
  dropzone.addEventListener(eventName, (e) => {
    e.preventDefault();
    dropzone.classList.remove('active');
  }, false);
});

dropzone.addEventListener('drop', (e) => {
  const dt = e.dataTransfer;
  const files = dt.files;
  if (files.length > 0 && files[0].name.endsWith('.zip')) {
    handleFileSelected(files[0]);
  } else {
    addLogLine('Only ZIP files are supported.', 'error');
  }
});

fileInput.addEventListener('change', (e) => {
  if (fileInput.files.length > 0) {
    handleFileSelected(fileInput.files[0]);
  }
});

removeFileBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  resetFileSelection();
});

function handleFileSelected(file) {
  selectedFile = file;
  fileNameEl.textContent = file.name;
  fileSizeEl.textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB`;
  
  dropzoneContent.classList.add('hidden');
  selectedFileInfo.classList.remove('hidden');
  
  submitBtn.removeAttribute('disabled');
  submitBtn.classList.remove('disabled');
}

function resetFileSelection() {
  selectedFile = null;
  fileInput.value = '';
  dropzoneContent.classList.remove('hidden');
  selectedFileInfo.classList.add('hidden');
  submitBtn.setAttribute('disabled', 'true');
  submitBtn.classList.add('disabled');
}

function addLogLine(text, type = 'info') {
  const line = document.createElement('div');
  line.className = `log-line ${type}`;
  line.textContent = `> ${text}`;
  logTerminal.appendChild(line);
  logTerminal.scrollTop = logTerminal.scrollHeight;
}

// Form Submission
document.getElementById('upload-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!selectedFile) return;

  // Prepare UI
  submitBtn.setAttribute('disabled', 'true');
  submitBtn.classList.add('disabled');
  document.querySelector('.spinner').classList.remove('hidden');
  document.querySelector('.btn-text').textContent = 'Uploading...';
  
  progressContainer.classList.remove('hidden');
  successContainer.classList.add('hidden');
  logTerminal.innerHTML = '';
  addLogLine('Uploading ZIP file to compiler...', 'system');
  progressBar.style.width = '0%';
  progressPercent.textContent = '0%';

  const selectedSize = document.querySelector('input[name="size"]:checked').value;
  const formData = new FormData();
  formData.append('file', selectedFile);
  formData.append('size', selectedSize);

  try {
    const response = await fetch('/upload', {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      throw new Error('Upload failed');
    }

    const { jobId } = await response.json();
    addLogLine(`Upload completed. Job ID assigned: ${jobId}`, 'success');
    
    // Connect to SSE for logs
    connectToLogs(jobId);
  } catch (error) {
    addLogLine(`Error: ${error.message}`, 'error');
    resetSubmitButton();
  }
});

function resetSubmitButton() {
  submitBtn.removeAttribute('disabled');
  submitBtn.classList.remove('disabled');
  document.querySelector('.spinner').classList.add('hidden');
  document.querySelector('.btn-text').textContent = 'Generate Brochure PDF';
}

function connectToLogs(jobId) {
  const eventSource = new EventSource(`/logs/${jobId}`);
  
  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    
    if (data.type === 'log') {
      addLogLine(data.text, data.level);
    } else if (data.type === 'progress') {
      progressBar.style.width = `${data.percent}%`;
      progressPercent.textContent = `${data.percent}%`;
      statusText.textContent = data.status;
    } else if (data.type === 'success') {
      addLogLine('PDF generation complete!', 'success');
      progressBar.style.width = '100%';
      progressPercent.textContent = '100%';
      statusText.textContent = 'Completed';
      
      eventSource.close();
      resetSubmitButton();
      
      // Show download
      downloadLink.href = `/download/${jobId}`;
      successContainer.classList.remove('hidden');
      successContainer.scrollIntoView({ behavior: 'smooth' });
    } else if (data.type === 'error') {
      addLogLine(`Failed: ${data.text}`, 'error');
      statusText.textContent = 'Failed';
      eventSource.close();
      resetSubmitButton();
    }
  };

  eventSource.onerror = (err) => {
    addLogLine('Lost connection to compiler logs.', 'error');
    eventSource.close();
    resetSubmitButton();
  };
}
