import type { EmbeddingProvider } from './retrieval.js';

type FeaturePipeline = (input: string | string[], options?: Record<string, unknown>) => Promise<{
  data?: ArrayLike<number>;
  dims?: number[];
  tolist?: () => number[][] | number[][][];
}>;

/**
 * Local ONNX embedding provider powered by Transformers.js.
 * The model is downloaded and cached by Transformers.js on first use.
 */
export class TransformersJsEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  private pipelinePromise?: Promise<FeaturePipeline>;

  constructor(private readonly options: {
    model?: string;
    cacheDir?: string;
    device?: 'cpu' | 'gpu' | 'wasm' | string;
  } = {}) {
    this.id = `transformers.js:${options.model ?? 'Xenova/paraphrase-multilingual-MiniLM-L12-v2'}`;
  }

  async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    if (!texts.length) return [];
    const extractor = await this.getPipeline();
    const result = await extractor([...texts], { pooling: 'mean', normalize: true });
    const rows = result.tolist?.();
    if (!Array.isArray(rows)) throw new Error('Embedding model returned an unsupported tensor.');
    const vectors = rows as number[][];
    if (vectors.length !== texts.length) throw new Error('Embedding model returned an unexpected vector count.');
    return vectors.map((vector) => {
      if (!vector.length || vector.some((value) => !Number.isFinite(value))) {
        throw new Error('Embedding model returned an invalid vector.');
      }
      return vector;
    });
  }

  private getPipeline(): Promise<FeaturePipeline> {
    this.pipelinePromise ??= (async () => {
      let module: { pipeline?: (task: string, model: string, options?: Record<string, unknown>) => Promise<FeaturePipeline> };
      try {
        const packageName = '@huggingface/transformers';
        module = await import(packageName) as typeof module;
      } catch (error) {
        throw new Error(
          'Local semantic retrieval requires the optional @huggingface/transformers package. Install it or provide a custom EmbeddingProvider.',
          { cause: error },
        );
      }
      if (!module.pipeline) throw new Error('Transformers.js does not expose pipeline().');
      return module.pipeline('feature-extraction',
        this.options.model ?? 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
        {
          ...(this.options.cacheDir ? { cache_dir: this.options.cacheDir } : {}),
          ...(this.options.device ? { device: this.options.device } : {}),
        });
    })();
    return this.pipelinePromise;
  }
}
