// @vitest-environment jsdom

import { fireEvent, renderHook } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { markActiveComposer, onComposerDictateRequest, reportComposerDictateState } from '@/app/chat/composer/focus'
import { $dictateMode, resetBinding, setBinding } from '@/store/keybinds'

import { useKeybinds } from './use-keybinds'

const deps = {
  archiveSelectedSession: () => undefined,
  openNewSessionTab: () => undefined,
  startFreshSession: () => undefined,
  toggleCommandCenter: () => undefined,
  toggleSelectedPin: () => undefined
}

const flushDispatch = () => new Promise(resolve => window.setTimeout(resolve, 0))

afterEach(() => {
  resetBinding('composer.dictate')
  $dictateMode.set('hold')
  markActiveComposer('main')
})

describe('composer.dictate keybind', () => {
  it('starts once on keydown and stops on its matching keyup, ignoring repeat', async () => {
    setBinding('composer.dictate', ['alt+v'])
    const requests: string[] = []
    const off = onComposerDictateRequest(({ request }) => requests.push(request))

    renderHook(() => useKeybinds(deps), { wrapper: MemoryRouter })

    fireEvent.keyDown(window, { altKey: true, code: 'KeyV', key: 'v' })
    fireEvent.keyDown(window, { altKey: true, code: 'KeyV', key: 'v', repeat: true })
    fireEvent.keyUp(window, { altKey: true, code: 'KeyV', key: 'v' })
    await flushDispatch()
    off()

    expect(requests).toEqual(['start', 'stop'])
  })

  it('works from an editable draft and pins hold stop to the composer that started it', async () => {
    setBinding('composer.dictate', ['alt+v'])
    markActiveComposer('tile:one')
    const requests: Array<{ generation?: number; request: string; target: string }> = []
    const off = onComposerDictateRequest(detail => requests.push(detail))
    const textarea = globalThis.document.createElement('textarea')
    globalThis.document.body.append(textarea)

    renderHook(() => useKeybinds(deps), { wrapper: MemoryRouter })

    fireEvent.keyDown(textarea, { altKey: true, code: 'KeyV', key: 'v' })
    markActiveComposer('main')
    fireEvent.keyUp(textarea, { altKey: true, code: 'KeyV', key: 'v' })
    await flushDispatch()
    off()
    textarea.remove()

    expect(requests).toEqual([
      { generation: 1, request: 'start', target: 'tile:one' },
      { generation: 1, request: 'stop', target: 'tile:one' }
    ])
  })

  it('claims Escape from a focused draft while a take is starting', async () => {
    setBinding('composer.dictate', ['alt+v'])
    const requests: string[] = []
    const haltRun = vi.fn()
    const off = onComposerDictateRequest(({ request }) => requests.push(request))
    const textarea = globalThis.document.createElement('textarea')
    textarea.addEventListener('keydown', haltRun)
    globalThis.document.body.append(textarea)

    renderHook(() => useKeybinds(deps), { wrapper: MemoryRouter })

    fireEvent.keyDown(textarea, { altKey: true, code: 'KeyV', key: 'v' })
    const escape = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' })
    textarea.dispatchEvent(escape)
    await flushDispatch()
    off()
    textarea.remove()

    expect(escape.defaultPrevented).toBe(true)
    expect(haltRun).not.toHaveBeenCalled()
    expect(requests).toEqual(['start', 'cancel'])
  })

  it('keeps a newer same-composer take pinned when an older take finishes late', async () => {
    setBinding('composer.dictate', ['alt+v'])
    const requests: Array<{ generation?: number; request: string }> = []
    const off = onComposerDictateRequest(({ generation, request }) => requests.push({ generation, request }))

    renderHook(() => useKeybinds(deps), { wrapper: MemoryRouter })

    fireEvent.keyDown(window, { altKey: true, code: 'KeyV', key: 'v' })
    reportComposerDictateState('started', 'main', 1)
    const firstEscape = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' })
    window.dispatchEvent(firstEscape)
    fireEvent.keyDown(window, { altKey: true, code: 'KeyV', key: 'v' })
    reportComposerDictateState('finished', 'main', 1)
    reportComposerDictateState('started', 'main', 2)
    await flushDispatch()
    fireEvent.blur(window)
    await flushDispatch()
    off()

    expect(requests).toEqual([
      { generation: 1, request: 'start' },
      { generation: 1, request: 'cancel' },
      { generation: 2, request: 'start' },
      { generation: 2, request: 'stop' }
    ])
  })

  it('uses toggle, owns one live Escape, and stops a live take on blur', async () => {
    setBinding('composer.dictate', ['alt+v'])
    $dictateMode.set('toggle')
    const requests: string[] = []
    const off = onComposerDictateRequest(({ request }) => requests.push(request))

    renderHook(() => useKeybinds(deps), { wrapper: MemoryRouter })

    fireEvent.keyDown(window, { altKey: true, code: 'KeyV', key: 'v' })
    await flushDispatch()
    reportComposerDictateState('started', 'main', 1)
    await flushDispatch()

    const firstEscape = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' })
    window.dispatchEvent(firstEscape)
    await flushDispatch()
    const secondEscape = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' })
    window.dispatchEvent(secondEscape)

    fireEvent.keyDown(window, { altKey: true, code: 'KeyV', key: 'v' })
    await flushDispatch()
    reportComposerDictateState('started', 'main', 2)
    await flushDispatch()
    fireEvent.blur(window)
    await flushDispatch()
    off()

    expect(firstEscape.defaultPrevented).toBe(true)
    expect(secondEscape.defaultPrevented).toBe(false)
    expect(requests).toEqual(['toggle', 'cancel', 'toggle', 'stop'])
  })
})
