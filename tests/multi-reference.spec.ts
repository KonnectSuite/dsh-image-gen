import { describe, expect, it, vi, afterEach } from 'vitest'
import { prepareComfyUIWorkflow, validateComfyUIWorkflowJson } from '../src/comfyui-workflow.js'
import { editComfyUIImage } from '../src/comfyui.js'

const graph = JSON.stringify({
  1: { class_type: 'LoadImage', inputs: { image: '{{image}}' } },
  2: { class_type: 'TextEncodeQwenImage21', inputs: { prompt: '{{prompt}}', vae: ['3', 0], 'images.image_1': ['1', 0] } },
  3: { class_type: 'VAELoader', inputs: { vae_name: 'test' } },
})
afterEach(() => vi.unstubAllGlobals())
describe('ordered ComfyUI references', () => {
  it('rejects duplicate and skipped reference slots when importing a workflow', () => {
    const invalid = (slot: string) => JSON.stringify({ 1: { inputs: { image: '{{image}}', prompt: '{{prompt}}' } }, 2: { inputs: { image: slot } } })
    expect(() => validateComfyUIWorkflowJson(invalid('{{image}}'))).toThrow('at most one')
    expect(() => validateComfyUIWorkflowJson(invalid('{{image_3}}'))).toThrow('contiguous')
    expect(() => validateComfyUIWorkflowJson(invalid('{{image_2}}'))).not.toThrow()
  })
  it('keeps the customer photo first and extends the Qwen encoder with the costume second', () => {
    const prepared = prepareComfyUIWorkflow(graph, 'Keep image 1; use outfit from image 2', 4, ['customer.png', 'costume.png'])
    expect(prepared['1'].inputs.image).toBe('customer.png')
    expect(prepared['2'].inputs['images.image_1']).toEqual(['1', 0])
    expect(prepared['2'].inputs['images.image_2']).toEqual(['arya_reference_2', 0])
    expect(prepared.arya_reference_2.inputs.image).toBe('costume.png')
    expect(JSON.parse(graph)['2'].inputs['images.image_2']).toBeUndefined()
  })
  it('supports explicit numbered slots and refuses missing slots instead of dropping references', () => {
    const explicit = JSON.stringify({ 1: { inputs: { image: '{{image}}', prompt: '{{prompt}}' } }, 2: { inputs: { image: '{{image_2}}' } } })
    expect(prepareComfyUIWorkflow(explicit, 'p', 4, ['a.png', 'b.png'])['2'].inputs.image).toBe('b.png')
    expect(() => prepareComfyUIWorkflow(explicit, 'p', 4, ['a.png'])).toThrow('No references were dropped')
    const ordinary = JSON.stringify({ 1: { inputs: { image: '{{image}}', prompt: '{{prompt}}' } } })
    expect(() => prepareComfyUIWorkflow(ordinary, 'p', 4, ['a.png', 'b.png'])).toThrow('No references were dropped')
  })
  it('uploads each reference once, submits ordered encoder connections and returns the final image', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: 'customer.png', subfolder: '' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: 'costume.png', subfolder: '' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ prompt_id: 'job' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ job: { status: { completed: true }, outputs: { save: { images: [{ filename: 'final.png', type: 'output', subfolder: '' }] } } } })))
      .mockResolvedValueOnce(new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), { headers: { 'content-type': 'image/png' } }))
    vi.stubGlobal('fetch', fetcher)
    const primary = { data: new Uint8Array([1]), mediaType: 'image/png' as const }
    const secondary = { data: new Uint8Array([2]), mediaType: 'image/png' as const }
    await editComfyUIImage({ baseURL: 'http://127.0.0.1:8188', workflowJson: graph, prompt: 'p', sourceImage: primary, sourceImages: [primary, secondary], timeoutMs: 1000, maxBytes: 1024, signal: new AbortController().signal })
    expect(fetcher).toHaveBeenCalledTimes(5)
    const submitted = JSON.parse(fetcher.mock.calls[2][1].body).prompt
    expect(submitted['1'].inputs.image).toBe('customer.png')
    expect(submitted.arya_reference_2.inputs.image).toBe('costume.png')
  })
})
