import DOMPurify from 'dompurify';
import { marked } from 'marked';

export function renderMarkdown(source: string): string {
  return DOMPurify.sanitize(marked.parse(source, { async: false, gfm: true }), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'input', 'form', 'button', 'textarea', 'select'],
    FORBID_ATTR: ['style', 'srcset'],
  });
}

export function documentUrl(path: string): URL {
  const normalized = path.replace(/\\/g, '/').replace(/^\/\/\?\//, '');
  return new URL(`file://${normalized.startsWith('/') ? '' : '/'}${normalized.split('/').map(encodeURIComponent).join('/')}`);
}
export function localPath(url: URL): string {
  const path = decodeURIComponent(url.pathname);
  return /^\/[a-z]:\//i.test(path) ? path.slice(1) : path;
}
