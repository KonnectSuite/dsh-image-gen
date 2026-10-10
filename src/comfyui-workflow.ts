/** Pure ComfyUI API-workflow validation and placeholder injection. */
import { MAX_COMFYUI_WORKFLOW_BYTES } from './shared.js'

export const COMFYUI_PROMPT_PLACEHOLDER = '{{prompt}}'
export const COMFYUI_SEED_PLACEHOLDER = '{{seed}}'
export const COMFYUI_IMAGE_PLACEHOLDER = '{{image}}'

/** Legacy single-percent placeholders from early releases, still accepted. */
const LEGACY_PROMPT_PLACEHOLDER = '%prompt%'
const LEGACY_SEED_PLACEHOLDER = '%seed%'
const LEGACY_IMAGE_PLACEHOLDER = '%image%'

/** LoadImage-style input key that receives the uploaded source image name. */
const IMAGE_INPUT_KEY = 'image'

type JsonRecord = Record<string, unknown>

/** Validate imported JSON without exposing workflow graph details to callers. */
export function validateComfyUIWorkflowJson(workflowJson: string): void {
  const workflow = parseWorkflow(workflowJson)
  const imageInputs = countImagePlaceholders(workflow)
  const slots = Object.values(workflow).map(node => imageSlot(record(record(node)?.inputs)?.image)).filter((slot): slot is number => slot !== undefined)
  if (slots.some(slot => !Number.isSafeInteger(slot) || slot > slots.length) || new Set(slots).size !== slots.length) {
    throw new Error(`ComfyUI workflow must contain at most one {{image}} input per reference, with contiguous slots starting at {{image}}; found ${imageInputs}`)
  }
  if (imageInputs > 1 && countImagePlaceholders(workflow, 1) > 1) {
    throw new Error(`ComfyUI workflow must contain at most one ${COMFYUI_IMAGE_PLACEHOLDER} image input; found ${String(imageInputs)}`)
  }
}

/** Return whether a validated API workflow accepts reference images. */
export function comfyUIWorkflowAcceptsImage(workflowJson: string): boolean {
  validateComfyUIWorkflowJson(workflowJson)
  return countImagePlaceholders(parseWorkflow(workflowJson)) >= 1
}

/**
 * Parse, clone, and inject one prompt plus an optional randomized seed.
 *
 * Prompt and seed placeholders are replaced inside any string so existing
 * workflows that embed them in longer text keep working. The image
 * placeholder is stricter: it only matches a dedicated `inputs.image` field
 * whose value is exactly {{image}} or a numbered {{image_N}} placeholder.
 * Every supplied image is assigned exactly once, in caller order. A single-reference
 * Qwen Image 2.1 encoder graph expands its image group for additional references;
 * other workflows must explicitly provide all numbered slots.
 */
export function prepareComfyUIWorkflow(workflowJson: string, prompt: string, seed = randomSeed(), image?: string | readonly string[]): JsonRecord {
  const workflow = parseWorkflow(workflowJson)
  const names = image === undefined ? [] : typeof image === 'string' ? [image] : [...image]
  if (names.length > 1 && countImagePlaceholders(workflow) === 1) {
    const encoders = Object.values(workflow).filter(value => record(value)?.class_type === 'TextEncodeQwenImage21')
    if (encoders.length === 1) {
      const encoder = record(encoders[0])
      const inputs = record(encoder?.inputs)
      if (inputs && Array.isArray(inputs['images.image_1']) && inputs.vae !== undefined) {
        for (let index = 1; index < names.length; index += 1) {
          let id = `arya_reference_${index + 1}`
          while (workflow[id] !== undefined) id += '_'
          workflow[id] = { class_type: 'LoadImage', inputs: { image: `{{image_${index + 1}}}` } }
          inputs[`images.image_${index + 1}`] = [id, 0]
        }
      }
    }
  }
  let promptReplacements = 0

  const inject = (value: unknown): unknown => {
    if (typeof value === 'string') {
      let replaced = value
      if (replaced.includes(COMFYUI_PROMPT_PLACEHOLDER) || replaced.includes(LEGACY_PROMPT_PLACEHOLDER)) {
        promptReplacements += 1
        replaced = replaced
          .replaceAll(COMFYUI_PROMPT_PLACEHOLDER, prompt)
          .replaceAll(LEGACY_PROMPT_PLACEHOLDER, prompt)
      }
      if (replaced === COMFYUI_SEED_PLACEHOLDER || replaced === LEGACY_SEED_PLACEHOLDER) return seed
      if (replaced.includes(COMFYUI_SEED_PLACEHOLDER) || replaced.includes(LEGACY_SEED_PLACEHOLDER)) {
        replaced = replaced
          .replaceAll(COMFYUI_SEED_PLACEHOLDER, String(seed))
          .replaceAll(LEGACY_SEED_PLACEHOLDER, String(seed))
      }
      return replaced
    }
    if (Array.isArray(value)) return value.map(inject)
    if (!isRecord(value)) return value
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, inject(child)]))
  }

  let imageInputs = 0
  const slots = new Set<number>()
  const prepared = Object.fromEntries(Object.entries(workflow).map(([nodeId, value]) => {
    const node = record(value)
    const inputs = node === undefined ? undefined : record(node.inputs)
    if (inputs === undefined) return [nodeId, value]
    const nextInputs = inject(inputs) as JsonRecord
    if (isImagePlaceholder(nextInputs[IMAGE_INPUT_KEY])) {
      imageInputs += 1
      const slot = imageSlot(nextInputs[IMAGE_INPUT_KEY])!
      if (slots.has(slot)) throw new Error(`ComfyUI workflow must contain at most one image input per reference; found ${imageInputs} with duplicate image ${slot}`)
      slots.add(slot)
      if (names[slot - 1] !== undefined) nextInputs[IMAGE_INPUT_KEY] = names[slot - 1]
    }
    return [nodeId, { ...node, inputs: nextInputs }]
  }))
  if (promptReplacements === 0) {
    throw new Error(`ComfyUI workflow must contain ${COMFYUI_PROMPT_PLACEHOLDER} in a text input`)
  }
  if (names.length === 0) {
    if (imageInputs > 0) {
      throw new Error(`ComfyUI workflow contains an ${COMFYUI_IMAGE_PLACEHOLDER} image input, which requires edit_image with a source image`)
    }
    return prepared
  }
  if (imageInputs === 0) {
    throw new Error(`ComfyUI workflow must contain exactly one ${COMFYUI_IMAGE_PLACEHOLDER} image input to edit images`)
  }
  if (imageInputs !== names.length || [...slots].some(slot => slot > names.length)) throw new Error(`ComfyUI edit workflow accepts ${imageInputs} reference images but received ${names.length}; choose a compatible multi-reference workflow. No references were dropped.`)
  return prepared
}

/** Random seed in the 32-bit range ComfyUI samplers accept. */
export function randomSeed(): number {
  return Math.floor(Math.random() * 0x1_0000_0000)
}

function parseWorkflow(workflowJson: string): JsonRecord {
  if (workflowJson.trim().length === 0) throw new Error('Import a ComfyUI API workflow JSON file in Settings before generating')
  if (new TextEncoder().encode(workflowJson).byteLength > MAX_COMFYUI_WORKFLOW_BYTES) {
    throw new Error('ComfyUI workflow file must be no larger than 5 MB')
  }
  let value: unknown
  try {
    value = JSON.parse(workflowJson)
  } catch {
    throw new Error('ComfyUI workflow file is not valid JSON')
  }
  if (!isRecord(value) || Object.keys(value).length === 0) {
    throw new Error('ComfyUI workflow must be a non-empty API-format JSON object')
  }
  if (!Object.values(value).some(node => {
    const inputs = record(node)?.inputs
    return inputs !== undefined && containsPromptPlaceholder(inputs)
  })) {
    throw new Error(`ComfyUI workflow must contain ${COMFYUI_PROMPT_PLACEHOLDER} (or ${LEGACY_PROMPT_PLACEHOLDER}) in a text input`)
  }
  return value
}

/** Count `inputs.image` fields that are exactly an image placeholder. */
function countImagePlaceholders(workflow: JsonRecord, onlySlot?: number): number {
  let count = 0
  for (const node of Object.values(workflow)) {
    const inputs = record(record(node)?.inputs)
    if (inputs !== undefined && isImagePlaceholder(inputs[IMAGE_INPUT_KEY]) && (onlySlot === undefined || imageSlot(inputs[IMAGE_INPUT_KEY]) === onlySlot)) count += 1
  }
  return count
}

function isImagePlaceholder(value: unknown): boolean {
  return imageSlot(value) !== undefined
}

/** Dedicated numbered image slots preserve caller order; the legacy unnumbered slot is image 1. */
function imageSlot(value: unknown): number | undefined {
  if (value === COMFYUI_IMAGE_PLACEHOLDER || value === LEGACY_IMAGE_PLACEHOLDER) return 1
  if (typeof value !== 'string') return undefined
  const match = /^\{\{image_([1-9][0-9]*)\}\}$/.exec(value)
  return match === null ? undefined : Number(match[1])
}

function containsPromptPlaceholder(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.includes(COMFYUI_PROMPT_PLACEHOLDER) || value.includes(LEGACY_PROMPT_PLACEHOLDER)
  }
  if (Array.isArray(value)) return value.some(containsPromptPlaceholder)
  return isRecord(value) && Object.values(value).some(containsPromptPlaceholder)
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined
}
