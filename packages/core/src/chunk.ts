/**
 * Markdown → chunks. Full nesting/HTML is out of scope: headings, paragraphs,
 * and a hard character budget are enough for retrieval snippets.
 */

export interface Chunk {
  heading: string;
  text: string;
}

export interface ChunkOptions {
  /** Soft maximum characters per chunk (default 600). */
  maxChars?: number;
  /** Characters repeated between adjacent chunks of one long paragraph (default 80). */
  overlap?: number;
  /** Prefix chunks with the heading path (helps embeddings-free recall). */
  includeHeadingInText?: boolean;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const SENTENCE_RE = /[^。！？!?；;\n]+[。！？!?；;]?/g;

export function chunkMarkdown(markdown: string, options: ChunkOptions = {}): Chunk[] {
  const maxChars = Math.max(80, options.maxChars ?? 600);
  const overlap = Math.min(Math.max(0, options.overlap ?? 80), Math.floor(maxChars / 2));
  const headingInText = options.includeHeadingInText ?? false;

  const lines = markdown.replaceAll('\r\n', '\n').split('\n');
  const sections: { heading: string; body: string[] }[] = [];
  let current: { heading: string; body: string[] } = { heading: '', body: [] };
  const headingStack: string[] = [];

  for (const line of lines) {
    const heading = HEADING_RE.exec(line);
    if (heading) {
      if (current.body.some((l) => l.trim().length > 0) || current.heading) sections.push(current);
      const level = (heading[1] ?? '#').length;
      headingStack.length = Math.max(0, level - 1);
      headingStack[level - 1] = (heading[2] ?? '').trim();
      // Drop the H1 document title: it is the doc title, not part of the path.
      current = { heading: headingStack.slice(1).filter(Boolean).join(' / '), body: [] };
      continue;
    }
    current.body.push(line);
  }
  if (current.body.some((l) => l.trim().length > 0) || current.heading) sections.push(current);

  const chunks: Chunk[] = [];
  for (const section of sections) {
    const heading = section.heading;
    const paragraphs = section.body
      .join('\n')
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    let buffer = '';
    const flush = (): void => {
      const text = buffer.trim();
      if (text.length > 0) chunks.push({ heading, text: headingInText && heading ? `${heading}\n${text}` : text });
      buffer = '';
    };

    for (const paragraph of paragraphs) {
      if (paragraph.length > maxChars) {
        flush();
        for (const piece of splitLong(paragraph, maxChars, overlap)) {
          chunks.push({ heading, text: headingInText && heading ? `${heading}\n${piece}` : piece });
        }
        continue;
      }
      if (buffer.length === 0) buffer = paragraph;
      else if (buffer.length + 2 + paragraph.length <= maxChars) buffer = `${buffer}\n\n${paragraph}`;
      else {
        flush();
        buffer = paragraph;
      }
    }
    flush();
  }

  return chunks.filter((c) => c.text.trim().length > 0);
}

/** Splits one over-long paragraph on sentence boundaries, carrying an overlap. */
export function splitLong(text: string, maxChars: number, overlap: number): string[] {
  const sentences = text.match(SENTENCE_RE) ?? [text];
  const pieces: string[] = [];
  let buffer = '';

  const push = (): void => {
    const trimmed = buffer.trim();
    if (trimmed.length > 0) pieces.push(trimmed);
    buffer = '';
  };

  for (const raw of sentences) {
    const sentence = raw.trim();
    if (sentence.length === 0) continue;
    if (sentence.length > maxChars) {
      push();
      // Hard cut for pathological input (long URLs, unbroken strings).
      for (let i = 0; i < sentence.length; i += maxChars - overlap) {
        pieces.push(sentence.slice(i, i + maxChars));
      }
      continue;
    }
    if (buffer.length + sentence.length <= maxChars) {
      buffer += sentence;
    } else {
      const tail = buffer.slice(Math.max(0, buffer.length - overlap));
      push();
      buffer = tail + sentence;
    }
  }
  push();
  return pieces;
}

/** Facts are one row each; no splitting. */
export function chunkFact(text: string): Chunk[] {
  const trimmed = text.trim();
  return trimmed.length > 0 ? [{ heading: '', text: trimmed }] : [];
}
