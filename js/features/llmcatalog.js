// The models WebLLM 0.2.87 can run (its built-in catalogue, the version llm-worker.js loads), with the
// download size measured from each model's file list on Hugging Face (huggingface.co/mlc-ai) and the
// graphics memory WebLLM says it needs. Embedding, vision and very large (70B) models are left out.
// [key, download MB, graphics memory MB with 16-bit floats, same with 32-bit floats (0 = no such build)]
// The model id is `${key}-q4f16_1-MLC` or `${key}-q4f32_1-MLC`, picked by what the graphics chip supports.
const ROWS = [
  ['Llama-3.2-1B-Instruct', 695, 879, 1129],
  ['Llama-3.2-3B-Instruct', 1807, 2264, 2952],
  ['Llama-3.1-8B-Instruct', 4517, 5001, 6101],
  ['DeepSeek-R1-Distill-Qwen-7B', 4284, 5107, 5900],
  ['DeepSeek-R1-Distill-Llama-8B', 4517, 5001, 6101],
  ['Hermes-2-Theta-Llama-3-8B', 4517, 4976, 6051],
  ['Hermes-2-Pro-Llama-3-8B', 4517, 4976, 6051],
  ['Hermes-3-Llama-3.2-3B', 1807, 2264, 2952],
  ['Hermes-3-Llama-3.1-8B', 4517, 4876, 5779],
  ['Hermes-2-Pro-Mistral-7B', 4074, 4033, 0],
  ['Phi-3.5-mini-instruct', 2149, 3672, 5483],
  ['Phi-4-mini-instruct', 2158, 3438, 4221],
  ['Mistral-7B-Instruct-v0.3', 4077, 4573, 5619],
  ['Mistral-7B-Instruct-v0.2', 4073, 4573, 0],
  ['OpenHermes-2.5-Mistral-7B', 4073, 4573, 0],
  ['NeuralHermes-2.5-Mistral-7B', 4073, 4573, 0],
  ['WizardMath-7B-V1.1', 4073, 4573, 0],
  ['SmolLM2-1.7B-Instruct', 962, 1774, 2692],
  ['SmolLM2-360M-Instruct', 203, 376, 580],
  ['gemma-4-E2B-it', 2797, 3387, 3863],
  ['gemma-2-2b-it', 1470, 1895, 2509],
  ['gemma-2-9b-it', 5199, 6422, 8383],
  ['gemma-2-2b-jpn-it', 1470, 1895, 2509],
  ['gemma3-1b-it', 562, 711, 0],
  ['OLMo-2-1124-7B-Instruct', 4106, 6479, 9086],
  ['OLMo-2-0425-1B-Instruct', 835, 1777, 2454],
  ['Qwen3-0.6B', 335, 1403, 1925],
  ['Qwen3-1.7B', 968, 2037, 2635],
  ['Qwen3-4B', 2262, 3432, 4328],
  ['Qwen3-8B', 4607, 5696, 6853],
  ['Qwen3.5-0.8B', 423, 1629, 1894],
  ['Qwen3.5-2B', 1059, 2245, 2592],
  ['Qwen3.5-4B', 2367, 3868, 4680],
  ['Qwen3.5-9B', 5038, 6433, 7545],
  ['Qwen2.5-0.5B-Instruct', 277, 945, 1060],
  ['Qwen2.5-1.5B-Instruct', 868, 1630, 1889],
  ['Qwen2.5-3B-Instruct', 1736, 2505, 2894],
  ['Qwen2.5-7B-Instruct', 4284, 5107, 5900],
  ['Qwen2.5-Coder-0.5B-Instruct', 277, 945, 1060],
  ['Qwen2.5-Coder-1.5B-Instruct', 868, 1630, 1889],
  ['Qwen2.5-Coder-3B-Instruct', 1736, 2505, 2894],
  ['Qwen2.5-Coder-7B-Instruct', 4284, 5107, 5900],
  ['Qwen2.5-Math-1.5B-Instruct', 868, 1630, 1889],
  ['stablelm-2-zephyr-1_6b', 925, 2088, 2999],
  ['RedPajama-INCITE-Chat-3B-v1', 1563, 2972, 3928],
  ['TinyLlama-1.1B-Chat-v1.0', 618, 697, 840],
  ['Ministral-3-3B-Base-2512', 1929, 2864, 3532],
  ['Ministral-3-3B-Reasoning-2512', 1929, 2864, 3532],
  ['Ministral-3-3B-Instruct-2512-BF16', 1929, 2864, 3532],
  ['Qwen2-0.5B-Instruct', 277, 945, 0],
  ['Qwen2-1.5B-Instruct', 868, 1630, 1889],
  ['Qwen2-7B-Instruct', 4284, 5107, 5900],
  ['Qwen2-Math-1.5B-Instruct', 868, 1630, 1889],
  ['Qwen2-Math-7B-Instruct', 4284, 5107, 5900],
  ['Llama-3-8B-Instruct', 4517, 5001, 6101],
  ['Phi-3-mini-4k-instruct', 2149, 3672, 5483],
  ['Llama-2-7b-chat-hf', 3790, 6749, 9109],
  ['Llama-2-13b-chat-hf', 7322, 11814, 0],
  ['gemma-2b-it', 1409, 1477, 1751],
  ['phi-2', 1564, 3054, 4032],
  ['phi-1_5', 798, 1210, 1682],
  ['TinyLlama-1.1B-Chat-v0.4', 618, 697, 840],

];
export const LLM_CATALOG = ROWS.map(([key, sizeMB, vram16, vram32]) => ({ key, sizeMB, vram16, vram32 }));

/** Picks for translating, smallest first: multilingual instruction models that fit common devices. */
export const LLM_CURATED = [
  ['Qwen3.5-0.8B', 'Tiny: fits phones, rough translations'],
  ['gemma3-1b-it', 'Tiny: fits phones'],
  ['Qwen2.5-1.5B-Instruct', 'Small: fast, works on most computers'],
  ['Qwen3.5-2B', 'Small: newer, good for its size'],
  ['gemma-2-2b-it', 'Small: good at European languages'],
  ['Llama-3.2-3B-Instruct', 'Medium: balanced'],
  ['Qwen3.5-4B', 'Medium: good quality, many languages'],
  ['gemma-4-E2B-it', 'Medium: newest Gemma, many languages'],
  ['Qwen3.5-9B', 'Large: best quality, needs a strong graphics chip'],
  ['gemma-2-9b-it', 'Large: very good translations, needs a strong graphics chip'],
];

/** "Qwen 2.5 1.5B Instruct" from "Qwen2.5-1.5B-Instruct". */
export const prettyName = (key) => key.replace(/-it$/i, '').replace(/-/g, ' ').replace(/_/g, '.')
  .replace(/^gemma3/i, 'Gemma 3').replace(/^gemma/i, 'Gemma').replace(/^Qwen(\d)/, 'Qwen $1').replace(/^phi/, 'Phi').replace(/(\d)b\b/g, '$1B');
