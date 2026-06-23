import { app, BrowserWindow, dialog } from 'electron';
import * as fs from 'node:fs/promises';
import { createScopedLogger } from '@core/logger';

const logger = createScopedLogger({ service: 'exportService' });

const PDF_CSS = `
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  font-size: 14px;
  line-height: 1.6;
  color: #1a1a1a;
  max-width: 800px;
  margin: 0 auto;
  padding: 40px 20px;
}
h1, h2, h3, h4, h5, h6 {
  margin-top: 1.5em;
  margin-bottom: 0.5em;
  font-weight: 600;
  line-height: 1.3;
}
h1 { font-size: 2em; border-bottom: 1px solid #e5e5e5; padding-bottom: 0.3em; }
h2 { font-size: 1.5em; border-bottom: 1px solid #e5e5e5; padding-bottom: 0.3em; }
h3 { font-size: 1.25em; }
p { margin: 1em 0; }
li > p { margin: 0.25em 0; }
code {
  background-color: #f5f5f5;
  padding: 0.2em 0.4em;
  border-radius: 3px;
  font-family: 'SF Mono', Monaco, Consolas, 'Liberation Mono', monospace;
  font-size: 0.9em;
}
pre {
  background-color: #f5f5f5;
  padding: 16px;
  border-radius: 6px;
  overflow-x: auto;
}
pre code {
  background: none;
  padding: 0;
}
blockquote {
  margin: 1em 0;
  padding: 0 1em;
  border-left: 4px solid #e5e5e5;
  color: #666;
}
ul, ol {
  margin: 1em 0;
  padding-left: 2em;
}
li { margin: 0.25em 0; }
table {
  border-collapse: collapse;
  width: 100%;
  margin: 1em 0;
}
th, td {
  border: 1px solid #e5e5e5;
  padding: 8px 12px;
  text-align: left;
}
th {
  background-color: #f5f5f5;
  font-weight: 600;
}
a { color: #0066cc; text-decoration: none; }
a:hover { text-decoration: underline; }
hr {
  border: none;
  border-top: 1px solid #e5e5e5;
  margin: 2em 0;
}
img { max-width: 100%; height: auto; }
`;

export type ExportToPdfPayload = {
  html: string;
  fileName: string;
};

export type ExportToPdfResult = {
  success: boolean;
  filePath?: string;
  error?: string;
  cancelled?: boolean;
};

export async function exportToPdf(
  parentWindow: BrowserWindow | null,
  payload: ExportToPdfPayload
): Promise<ExportToPdfResult> {
  const { html, fileName } = payload;
  const defaultName = fileName.replace(/\.(md|markdown)$/i, '') + '.pdf';

  const saveDialogOptions = {
    title: 'Export as PDF',
    defaultPath: defaultName,
    filters: [{ name: 'PDF Documents', extensions: ['pdf'] }]
  };

  const saveResult = parentWindow
    ? await dialog.showSaveDialog(parentWindow, saveDialogOptions)
    : await dialog.showSaveDialog(saveDialogOptions);

  if (saveResult.canceled || !saveResult.filePath) {
    return { success: false, cancelled: true };
  }

  const targetPath = saveResult.filePath;

  let hiddenWindow: BrowserWindow | null = null;

  try {
    const fullHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>${PDF_CSS}</style>
</head>
<body>${html}</body>
</html>`;

    // Ensure app is ready before creating BrowserWindow
    await app.whenReady();

    hiddenWindow = new BrowserWindow({
      show: false,
      width: 800,
      height: 600,
      webPreferences: {
        offscreen: true,
        nodeIntegration: false,
        contextIsolation: true,
        javascript: false
      }
    });

    await hiddenWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(fullHtml)}`);

    // Wait for content to render
    await new Promise((resolve) => setTimeout(resolve, 200));

    const pdfBuffer = await hiddenWindow.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: {
        top: 0.5,
        bottom: 0.5,
        left: 0.5,
        right: 0.5
      }
    });

    await fs.writeFile(targetPath, pdfBuffer);

    logger.info({ filePath: targetPath }, 'PDF export successful');
    return { success: true, filePath: targetPath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message }, 'PDF export failed');
    return { success: false, error: message };
  } finally {
    if (hiddenWindow && !hiddenWindow.isDestroyed()) {
      hiddenWindow.close();
    }
  }
}

export type SaveFilePayload = {
  data: ArrayBuffer;
  fileName: string;
  filters: Electron.FileFilter[];
  title?: string;
};

export type SaveFileResult = {
  success: boolean;
  filePath?: string;
  error?: string;
  cancelled?: boolean;
};

export async function saveFileWithDialog(
  parentWindow: BrowserWindow | null,
  payload: SaveFilePayload
): Promise<SaveFileResult> {
  const { data, fileName, filters, title } = payload;

  const saveDialogOptions = {
    title: title ?? 'Save File',
    defaultPath: fileName,
    filters
  };

  const saveResult = parentWindow
    ? await dialog.showSaveDialog(parentWindow, saveDialogOptions)
    : await dialog.showSaveDialog(saveDialogOptions);

  if (saveResult.canceled || !saveResult.filePath) {
    return { success: false, cancelled: true };
  }

  const targetPath = saveResult.filePath;

  try {
    await fs.writeFile(targetPath, Buffer.from(data));
    logger.info({ filePath: targetPath }, 'File saved successfully');
    return { success: true, filePath: targetPath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message }, 'File save failed');
    return { success: false, error: message };
  }
}
