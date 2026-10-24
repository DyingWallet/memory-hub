// 本地 embedding 运行时：bge-small-zh-v1.5（ONNX + onnxruntime-node）。
//
// 设计约束（2026-10-24 实测，见 memories/50-knowledge/2026-10-24-embedding-benchmark-bge-small-zh.md）：
//   - 稳态 1 线程：一次短查询 ~0.5 ms，多给线程没有收益，只会抬高总 CPU；
//   - 批 ≤ 8、maxLen ≤ 256：批 32 × maxLen 512 会把 RSS 冲到 1.7 GB（激活张量被 arena 留住）；
//   - onnxruntime-node 是可选依赖：没装、模型没下载、加载失败 —— 一律返回「不可用」，
//     由上层静默退回纯 FTS，不能让检索报错。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_DIM = 512;
const MAX_TOKEN_CHARS = 100;

export interface EmbeddingOptions {
  modelDir: string;
  modelFile: string;
  vocabFile: string;
  maxLen: number;
  batchSize: number;
  threads: number;
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void };
}

/** 词表：一行一个 token，行号就是 id。 */
export function buildVocabulary(vocabText: string): Map<string, number> {
  const vocab = new Map<string, number>();
  for (const line of vocabText.split(/\r?\n/)) {
    if (line !== '') vocab.set(line, vocab.size);
  }
  return vocab;
}

const isCjk = (code: number): boolean => (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf);
const PUNCTUATION = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~，。、；：？！“”‘’（）《》【】…—·'.split(''));

/**
 * BERT WordPiece（BGE 用的就是这套）：小写化 → 空白/CJK/标点切分 → 贪心最长匹配。
 * 中文基本一字一 token，所以这里不需要真正的 subword 训练数据。
 */
export function tokenizeText(text: string, vocab: Map<string, number>, maxLen: number): number[] {
  const cls = vocab.get('[CLS]') ?? 101;
  const sep = vocab.get('[SEP]') ?? 102;
  const unk = vocab.get('[UNK]') ?? 100;

  const cleaned = String(text ?? '')
    .toLowerCase()
    .normalize('NFC')
    .replace(/[\u0000-\u001f]/g, ' ')
    .trim();

  const pieces: string[] = [];
  let word = '';
  const flush = (): void => {
    if (word === '') return;
    let start = 0;
    let matchedAll = true;
    const parts: string[] = [];
    while (start < word.length) {
      let end = Math.min(word.length, start + MAX_TOKEN_CHARS);
      let piece: string | null = null;
      while (end > start) {
        const candidate = (start === 0 ? '' : '##') + word.slice(start, end);
        if (vocab.has(candidate)) {
          piece = candidate;
          break;
        }
        end -= 1;
      }
      if (piece === null) {
        matchedAll = false;
        break;
      }
      parts.push(piece);
      start = end;
    }
    if (matchedAll) pieces.push(...parts);
    else pieces.push('[UNK]');
    word = '';
  };

  for (const ch of cleaned) {
    const code = ch.codePointAt(0) ?? 0;
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    if (isCjk(code) || PUNCTUATION.has(ch)) {
      flush();
      pieces.push(ch);
      continue;
    }
    word += ch;
  }
  flush();

  const ids = pieces.slice(0, Math.max(0, maxLen - 2)).map((piece) => vocab.get(piece) ?? unk);
  return [cls, ...ids, sep];
}

interface OrtModule {
  InferenceSession: {
    create: (path: string, options?: Record<string, unknown>) => Promise<OrtSession>;
  };
  Tensor: new (type: string, data: BigInt64Array, dims: number[]) => unknown;
}

interface OrtSession {
  inputNames: string[];
  outputNames: string[];
  run: (feeds: Record<string, unknown>) => Promise<Record<string, { dims: number[]; data: Float32Array | number[] }>>;
  release: () => Promise<void>;
}

export class EmbeddingRuntime {
  private readonly vocab: Map<string, number>;
  private session: OrtSession | null = null;
  private unavailableReason: string | null = null;
  private closed = false;

  private constructor(
    private readonly ort: OrtModule,
    private readonly options: EmbeddingOptions,
    vocab: Map<string, number>,
  ) {
    this.vocab = vocab;
  }

  get dim(): number {
    return DEFAULT_DIM;
  }

  get ready(): boolean {
    return this.session !== null;
  }

  get reason(): string | null {
    return this.unavailableReason;
  }

  /**
   * 尝试建立运行时。任何一步失败都返回 `null` 并给出原因，调用方据此静默降级。
   */
  static async create(options: EmbeddingOptions): Promise<{ runtime: EmbeddingRuntime | null; reason: string | null }> {
    const modelPath = join(options.modelDir, options.modelFile);
    const vocabPath = join(options.modelDir, options.vocabFile);
    if (!existsSync(modelPath)) return { runtime: null, reason: `model missing: ${modelPath}` };
    if (!existsSync(vocabPath)) return { runtime: null, reason: `vocab missing: ${vocabPath}` };

    // onnxruntime-node 用变量说明符导入：它是可选依赖，TS 不应该为它要类型。
    const spec = 'onnxruntime-node';
    let ort: OrtModule;
    try {
      ort = (await import(spec)) as unknown as OrtModule;
    } catch {
      return { runtime: null, reason: 'onnxruntime-node not installed' };
    }

    let vocab: Map<string, number>;
    try {
      vocab = buildVocabulary(readFileSync(vocabPath, 'utf8'));
    } catch (error) {
      return { runtime: null, reason: `vocab unreadable: ${(error as Error).message}` };
    }

    const runtime = new EmbeddingRuntime(ort, options, vocab);
    try {
      runtime.session = await ort.InferenceSession.create(modelPath, {
        intraOpNumThreads: options.threads,
        interOpNumThreads: 1,
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
      });
      runtime.options.logger?.info?.(`semantic: embedding ready (${options.modelFile}, ${options.threads} thread(s))`);
      return { runtime, reason: null };
    } catch (error) {
      runtime.unavailableReason = `session failed: ${(error as Error).message}`;
      return { runtime: null, reason: runtime.unavailableReason };
    }
  }

  /** 批量向量化；返回 L2 归一化后的 CLS 向量。失败抛错，由调用方决定降级。 */
  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    if (!this.session) throw new Error(this.unavailableReason ?? 'embedding runtime not ready');
    const out: Float32Array[] = [];
    const batchSize = Math.max(1, this.options.batchSize);
    for (let offset = 0; offset < texts.length; offset += batchSize) {
      const slice = texts.slice(offset, offset + batchSize);
      out.push(...(await this.embedBatch(slice)));
    }
    return out;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const session = this.session;
    this.session = null;
    await session?.release?.();
  }

  private async embedBatch(texts: readonly string[]): Promise<Float32Array[]> {
    const session = this.session;
    if (!session) throw new Error('embedding runtime not ready');
    const tokenized = texts.map((text) => tokenizeText(text, this.vocab, this.options.maxLen));
    const width = Math.max(...tokenized.map((ids) => ids.length));
    const count = tokenized.length;
    const ids = new BigInt64Array(count * width);
    const mask = new BigInt64Array(count * width);
    tokenized.forEach((tokens, index) => {
      tokens.forEach((id, position) => {
        ids[index * width + position] = BigInt(id);
        mask[index * width + position] = 1n;
      });
    });

    const feeds: Record<string, unknown> = {
      input_ids: new this.ort.Tensor('int64', ids, [count, width]),
      attention_mask: new this.ort.Tensor('int64', mask, [count, width]),
    };
    if (session.inputNames.includes('token_type_ids')) {
      feeds.token_type_ids = new this.ort.Tensor('int64', new BigInt64Array(count * width), [count, width]);
    }

    const outputs = await session.run(feeds);
    const hidden = outputs[session.outputNames[0] ?? 'last_hidden_state'];
    if (!hidden) throw new Error('model returned no hidden state');
    const dim = hidden.dims[2] ?? DEFAULT_DIM;
    const data = hidden.data;
    const vectors: Float32Array[] = [];
    for (let row = 0; row < count; row += 1) {
      const vector = new Float32Array(dim);
      let norm = 0;
      // CLS pooling（BGE 的标准做法）
      for (let d = 0; d < dim; d += 1) {
        const value = Number(data[row * width * dim + d]);
        vector[d] = value;
        norm += value * value;
      }
      norm = Math.sqrt(norm) || 1;
      for (let d = 0; d < dim; d += 1) vector[d] = (vector[d] ?? 0) / norm;
      vectors.push(vector);
    }
    return vectors;
  }
}
