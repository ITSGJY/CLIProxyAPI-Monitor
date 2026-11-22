/**
 * OMC v0.4.11 model-to-manufacturer mark resolver.
 * Reused from web/src/types/modelSquare.ts in WizisCool/oh-my-cpa.
 */
export interface ModelReference {
  id?: string;
  author?: string;
}

export interface ModelManufacturer {
  id: string;
  name: string;
  iconId?: string;
  modelIconId?: string;
}

// A model's maker is distinct from the relay or protocol adapter carrying it.
const MODEL_MANUFACTURERS: Record<string, ModelManufacturer> = {
  openai: { id: 'openai', name: 'OpenAI', iconId: 'OpenAI', modelIconId: 'OpenAI' },
  anthropic: { id: 'anthropic', name: 'Anthropic', iconId: 'Anthropic', modelIconId: 'Claude' },
  google: { id: 'google', name: 'Google', iconId: 'Google', modelIconId: 'Gemini' },
  xai: { id: 'xai', name: 'xAI', iconId: 'XAI', modelIconId: 'Grok' },
  alibaba: { id: 'alibaba', name: 'Qwen', iconId: 'Qwen', modelIconId: 'Qwen' },
  deepseek: { id: 'deepseek', name: 'DeepSeek', iconId: 'DeepSeek', modelIconId: 'DeepSeek' },
  moonshotai: { id: 'moonshotai', name: 'Moonshot AI', iconId: 'Moonshot', modelIconId: 'Kimi' },
  zai: { id: 'zai', name: 'Z.ai', iconId: 'ZAI', modelIconId: 'Zhipu' },
  minimax: { id: 'minimax', name: 'MiniMax', iconId: 'Minimax', modelIconId: 'Minimax' },
  mistral: { id: 'mistral', name: 'Mistral AI', iconId: 'Mistral', modelIconId: 'Mistral' },
  meta: { id: 'meta', name: 'Meta', iconId: 'Meta', modelIconId: 'Meta' },
  cohere: { id: 'cohere', name: 'Cohere', iconId: 'Cohere', modelIconId: 'Cohere' },
  'bytedance-seed': { id: 'bytedance-seed', name: 'ByteDance', iconId: 'ByteDance', modelIconId: 'Doubao' },
  xiaomi: { id: 'xiaomi', name: 'Xiaomi', iconId: 'XiaomiMiMo', modelIconId: 'XiaomiMiMo' },
  inception: { id: 'inception', name: 'Inception', iconId: 'Inception', modelIconId: 'Inception' },
  bilibili: { id: 'bilibili', name: 'Bilibili', iconId: 'Bilibili', modelIconId: 'BilibiliIndex' },
  microsoft: { id: 'microsoft', name: 'Microsoft', iconId: 'Microsoft', modelIconId: 'Microsoft' },
  amazon: { id: 'amazon', name: 'Amazon', iconId: 'Aws', modelIconId: 'Nova' },
  baidu: { id: 'baidu', name: 'Baidu', iconId: 'Baidu', modelIconId: 'Wenxin' },
  tencent: { id: 'tencent', name: 'Tencent', iconId: 'Tencent', modelIconId: 'Hunyuan' },
  perplexity: { id: 'perplexity', name: 'Perplexity', iconId: 'Perplexity', modelIconId: 'Perplexity' },
  nvidia: { id: 'nvidia', name: 'NVIDIA', iconId: 'Nvidia', modelIconId: 'Nvidia' },
  stepfun: { id: 'stepfun', name: 'StepFun', iconId: 'Stepfun', modelIconId: 'Stepfun' },
};
const AUTHOR_ALIASES: Record<string, string> = { 'x-ai': 'xai', qwen: 'alibaba', 'z-ai': 'zai', zhipuai: 'zai', 'zai-org': 'zai', mistralai: 'mistral', 'meta-llama': 'meta', 'moonshotai-cn': 'moonshotai', 'deepseek-ai': 'deepseek', inceptionlabs: 'inception', 'amazon-nova': 'amazon', bytedance: 'bytedance-seed' };
const UNKNOWN_MANUFACTURER: ModelManufacturer = { id: 'unknown', name: '' };
const COPILOT_FALLBACK_MANUFACTURER: ModelManufacturer = {
  id: 'copilot',
  name: 'GitHub Copilot',
  iconId: 'GithubCopilot',
  modelIconId: 'GithubCopilot',
};
const MODEL_FAMILY_RULES: readonly [RegExp, string][] = [
  [/^(?:gpt(?:-|\d)|chatgpt-|o[134](?:-|$)|codex(?:-|$))/, 'openai'],
  [/^claude(?:-|$)/, 'anthropic'], [/^(?:gemini|gemma)(?:-|$)/, 'google'],
  [/^grok(?:-|$)/, 'xai'], [/^(?:qwen|qwq)(?:\d|[-.]|$)/, 'alibaba'],
  [/^deepseek(?:-|$)/, 'deepseek'], [/^(?:kimi|moonshot)(?:[-\d]|$)/, 'moonshotai'],
  [/^glm(?:[-\d]|$)/, 'zai'], [/^minimax(?:[-\d]|$)/, 'minimax'],
  [/^(?:mistral|mixtral|codestral|devstral|magistral|ministral|pixtral|voxtral)(?:[-\d]|$)/, 'mistral'],
  [/^(?:llama(?:[-\d.]|$)|muse-)/, 'meta'], [/^command(?:-|$)/, 'cohere'],
  [/^(?:doubao|seed)(?:-|$)/, 'bytedance-seed'], [/^mimo(?:-|$)/, 'xiaomi'],
  [/^mercury(?:[-\d]|$)/, 'inception'], [/^index-/, 'bilibili'], [/^(?:phi(?:[-\d]|$)|mai-)/, 'microsoft'],
  [/^nova-/, 'amazon'], [/^ernie(?:[-\d]|$)/, 'baidu'], [/^hunyuan(?:-|$)/, 'tencent'],
  [/^sonar(?:-|$)/, 'perplexity'], [/^nemotron(?:-|$)/, 'nvidia'], [/^step-/, 'stepfun'],
];

/**
 * The catalog mark a model is drawn with: its maker's model mark, else the maker's own. A name
 * that resolves to no maker - a custom alias, say - is tried again as the upstream it routes to.
 */
export function modelMarkIconId(model: string, fallbackModel = '', metadata?: ModelReference): string | undefined {
  const primary = model.trim();
  const fallback = fallbackModel.trim();
  for (const [identity, reference] of [[primary, metadata], [fallback !== primary ? fallback : '', undefined]] as const) {
    if (!identity) continue;
    const maker = resolveModelManufacturer(identity, reference);
    const candidate = maker.modelIconId || maker.iconId;
    if (candidate) return candidate;
  }
  return undefined;
}

export function resolveModelManufacturer(identity: string, metadata?: ModelReference): ModelManufacturer {
  if (!identity) return UNKNOWN_MANUFACTURER;
  const author = (metadata?.author || (metadata?.id ?? identity).split('/').slice(0, -1).join('/')).toLowerCase();
  const slug = identity.split('/').at(-1)?.toLowerCase() ?? '';
  const maker = MODEL_MANUFACTURERS[AUTHOR_ALIASES[author] ?? author] ?? MODEL_MANUFACTURERS[MODEL_FAMILY_RULES.find(([pattern]) => pattern.test(slug))?.[1] ?? ''];
  if (!maker) {
    if (author === 'copilot') return COPILOT_FALLBACK_MANUFACTURER;
    return metadata && author ? { id: author, name: author } : UNKNOWN_MANUFACTURER;
  }
  if (maker.id === 'openai' && slug.includes('codex')) return { ...maker, modelIconId: 'Codex' };
  if (maker.id === 'google' && slug.startsWith('gemma')) return { ...maker, modelIconId: 'Gemma' };
  return maker;
}
