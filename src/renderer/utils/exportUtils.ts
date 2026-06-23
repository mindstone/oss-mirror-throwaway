import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import { remarkDocx } from '@m2d/remark-docx';

export type ExportResult = {
  success: boolean;
  filePath?: string;
  error?: string;
  cancelled?: boolean;
};

export async function markdownToHtml(markdown: string): Promise<string> {
  const result = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: false })
    .use(rehypeStringify)
    .process(markdown);
  return String(result);
}

export async function exportToPdf(markdown: string, fileName: string): Promise<ExportResult> {
  try {
    const html = await markdownToHtml(markdown);
    const result = await window.exportApi.toPdf({ html, fileName });
    return result as ExportResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

export async function exportToDocx(markdown: string, fileName: string): Promise<ExportResult> {
  try {
    const processor = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkDocx);

    const vfile = await processor.process(markdown);
    // vfile.result is a Promise<Blob> in browser environment
    const docxBlob = await (vfile.result as Promise<Blob>);

    const arrayBuffer = await docxBlob.arrayBuffer();
    const defaultName = fileName.replace(/\.(md|markdown)$/i, '') + '.docx';

    const result = await window.exportApi.saveFile({
      data: arrayBuffer,
      fileName: defaultName,
      filters: [{ name: 'Word Documents', extensions: ['docx'] }],
      title: 'Export as Word Document'
    });

    return result as ExportResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}
