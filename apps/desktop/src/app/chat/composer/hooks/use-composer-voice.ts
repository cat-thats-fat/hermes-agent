import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { useI18n } from '@/i18n'
import { chatMessageText, collectUnspokenTurnSpeech } from '@/lib/chat-messages'
import { triggerHaptic } from '@/lib/haptics'
import { markAssistantIdSpoken, resolveSpokenReply } from '@/lib/spoken-reply'
import { clearWakeIndicator, syncWakeIndicatorWithVoice } from '@/lib/wake-indicator'
import { $voiceConversationStartRequest, takeVoiceConversationStart } from '@/store/composer'
import { resetBrowseState } from '@/store/composer-input-history'
import { $gateway } from '@/store/gateway'
import { notify, notifyError } from '@/store/notifications'
import { $autoSpeakReplies, $voiceStopPhrase, setAutoSpeakReplies } from '@/store/voice-prefs'
import { resumeWakeAfterVoice } from '@/store/wake-word'

import type { ComposerTarget } from '../focus'
import { onComposerDictateRequest, onComposerVoiceToggleRequest, reportComposerDictateState } from '../focus'
import { useComposerScope } from '../scope'
import type { ChatBarProps } from '../types'

import { useAutoSpeakReplies } from './use-auto-speak-replies'
import { useVoiceConversation } from './use-voice-conversation'
import { useVoiceRecorder } from './use-voice-recorder'

interface UseComposerVoiceArgs {
  busy: boolean
  clearDraft: () => void
  disabled: boolean
  focusInput: () => void
  insertText: (text: string) => void
  maxRecordingSeconds: number
  /** Interrupt the in-flight agent turn (Stop-button seam) — fired when the
   *  user speaks over the model while it is still generating. */
  onInterrupt?: () => Promise<void> | void
  onSubmit: ChatBarProps['onSubmit']
  onTranscribeAudio: ChatBarProps['onTranscribeAudio']
  sessionId: string | null | undefined
  /** This composer's focus-bus key — voice toggles targeting another
   *  composer (or the active one, when not us) are ignored. */
  target: ComposerTarget
}

/**
 * The composer's voice engine: push-to-talk dictation (transcript → draft), the
 * full voice-conversation loop, and auto-speak of replies. Self-contained — it
 * consumes the draft/submit primitives passed in but nothing depends back on it,
 * so it lifts cleanly out of ChatBar.
 */
export function useComposerVoice({
  busy,
  clearDraft,
  disabled,
  focusInput,
  insertText,
  maxRecordingSeconds,
  onInterrupt,
  onSubmit,
  onTranscribeAudio,
  sessionId,
  target
}: UseComposerVoiceArgs) {
  const { t } = useI18n()
  // A tile's composer speaks ITS transcript, not the primary chat's.
  const { $messages } = useComposerScope()
  const [voiceConversationActive, setVoiceConversationActive] = useState(false)
  const ownsWakeIndicatorRef = useRef(false)
  const voiceStartRequest = useStore($voiceConversationStartRequest)
  const dictationStartingRef = useRef(false)
  const dictationStopRequestedRef = useRef(false)
  const dictationCancelRequestedRef = useRef(false)
  // The keybind dispatcher labels each gesture. Keep that label with the
  // recorder lifecycle so a deferred completion cannot finish a newer take on
  // the same composer.
  const dictationGenerationRef = useRef<number | undefined>(undefined)
  // Key events can arrive before React paints the recorder status update.
  // Keep the live capture truth in a ref so a quick hold/release cannot strand
  // the mic waiting for its duration cap.
  const dictationActiveRef = useRef(false)
  const cancelDictationRef = useRef<() => void>(() => undefined)
  const voiceConversationActiveRef = useRef(voiceConversationActive)
  voiceConversationActiveRef.current = voiceConversationActive

  const wakePausedRef = useRef(false)
  // Resolves once the in-flight wake.pause round-trip completes (mic released by
  // the wake listener). Both conversation and dictation await this before
  // opening the recorder, so Windows never sees two clients fighting for it.
  const wakePauseBarrierRef = useRef<Promise<void> | null>(null)

  const resumeWakeIfUnused = useCallback(() => {
    if (
      !wakePausedRef.current ||
      voiceConversationActiveRef.current ||
      dictationActiveRef.current ||
      dictationStartingRef.current
    ) {
      return
    }

    wakePausedRef.current = false
    wakePauseBarrierRef.current = null
    void resumeWakeAfterVoice()
  }, [])

  // The ref is a request token (did WE issue wake.pause?), not an atom mirror —
  // it prevents either voice mode from rearming a detector owned elsewhere.
  const pauseWakeForVoice = useCallback(() => {
    if (wakePausedRef.current) {
      return wakePauseBarrierRef.current ?? Promise.resolve()
    }

    wakePausedRef.current = true

    const barrier = (async () => {
      try {
        await $gateway.get()?.request('wake.pause', {})
      } catch {
        // No wake listener / older backend — nothing held the mic.
      }
    })()

    wakePauseBarrierRef.current = barrier

    return barrier
  }, [])

  const finishDictation = useCallback(() => {
    dictationActiveRef.current = false
    reportComposerDictateState('finished', target, dictationGenerationRef.current)
    dictationGenerationRef.current = undefined
    resumeWakeIfUnused()
  }, [resumeWakeIfUnused, target])

  const { cancel, start, stop, voiceActivityState, voiceStatus } = useVoiceRecorder({
    focusInput,
    maxRecordingSeconds,
    onTranscript: insertText,
    onTranscribeAudio,
    onFinished: finishDictation
  })

  /** Auto-speak selector: the latest unspoken reply only — a backlog collapses to the newest. */
  const pendingResponse = () => {
    const messages = $messages.get()
    const last = messages.findLast(m => m.role === 'assistant' && !m.hidden)
    const spoken = resolveSpokenReply(sessionId, messages)

    if (!last || last.id === spoken?.id) {
      return null
    }

    const text = chatMessageText(last).trim()

    if (!text) {
      return null
    }

    return {
      id: last.id,
      pending: Boolean(last.pending),
      text
    }
  }

  /**
   * Voice-conversation selector: every unspoken assistant bubble of the turn,
   * in order — narration interims AND the final answer, not just whichever
   * bubble happens to be last. See `collectUnspokenTurnSpeech`.
   */
  const pendingTurnResponse = () => {
    const messages = $messages.get()

    return collectUnspokenTurnSpeech(messages, resolveSpokenReply(sessionId, messages)?.id ?? null)
  }

  const consumePendingResponse = () => {
    const messages = $messages.get()
    const last = messages.findLast(m => m.role === 'assistant' && !m.hidden)

    if (last) {
      markAssistantIdSpoken(sessionId, messages, last.id)
    }
  }

  const submitVoiceTurn = async (text: string) => {
    if (busy) {
      return
    }

    triggerHaptic('submit')
    resetBrowseState(sessionId)
    clearDraft()
    await onSubmit(text)
  }

  const conversation = useVoiceConversation({
    busy,
    consumePendingResponse,
    enabled: voiceConversationActive,
    onFatalError: () => setVoiceConversationActive(false),
    // Speaking over the model mid-generation interrupts the in-flight turn —
    // the same seam as the Stop button — so the interjection becomes the next
    // turn instead of waiting behind a reply the user already rejected.
    onInterrupt,
    // A spoken stop command ("stop", "never mind", "goodbye", …) ends the
    // hands-free conversation. Flipping the flag is the authoritative off
    // switch — the enabled=false prop + effect below drive conversation.end()
    // teardown (mic close, wake re-arm).
    onStopWord: () => setVoiceConversationActive(false),
    onSubmit: submitVoiceTurn,
    onTranscribeAudio,
    pendingResponse: pendingTurnResponse,
    // Before the conversation opens the mic, wait for any in-flight wake.pause
    // to finish releasing the capture device (see wakePauseBarrierRef).
    beforeMicOpen: () => wakePauseBarrierRef.current ?? undefined
  })

  // eslint-disable-next-line no-restricted-syntax -- ownership token used only by unmount cleanup
  useEffect(() => {
    if (target !== 'main') {
      return
    }

    if (syncWakeIndicatorWithVoice(voiceConversationActive, conversation.status)) {
      ownsWakeIndicatorRef.current = voiceConversationActive
    }
  }, [conversation.status, target, voiceConversationActive])

  useEffect(
    () => () => {
      if (ownsWakeIndicatorRef.current) {
        clearWakeIndicator()
      }
    },
    []
  )

  // The `composer.voice` hotkey (Ctrl+B) toggles the conversation. Starting
  // with STT unconfigured lets the conversation surface its own "configure
  // speech-to-text" notice rather than silently no-opping.
  const toggleVoiceConversation = useCallback(() => {
    if (disabled) {
      return
    }

    if (voiceConversationActive) {
      setVoiceConversationActive(false)
      void conversation.end()
    } else {
      // Starting a conversation wins the mic immediately; do not let a
      // dictation take overlap it while React effects are catching up.
      voiceConversationActiveRef.current = true
      cancelDictationRef.current()
      setVoiceConversationActive(true)
    }
  }, [conversation, disabled, voiceConversationActive])

  useEffect(
    () => onComposerVoiceToggleRequest(toggled => toggled === target && toggleVoiceConversation()),
    [target, toggleVoiceConversation]
  )

  // eslint-disable-next-line no-restricted-syntax -- this is an immediate ownership token, not a mirrored reactive value
  useEffect(() => {
    if (target === 'main' && !disabled && takeVoiceConversationStart(voiceStartRequest) && !voiceConversationActive) {
      voiceConversationActiveRef.current = true
      cancelDictationRef.current()
      setVoiceConversationActive(true)
    }
  }, [disabled, target, voiceConversationActive, voiceStartRequest])

  // 'Say "stop" to end the voice chat.' notice when the conversation starts.
  // Phrase comes from voice.stop_phrases (first entry) so a custom phrase
  // renders correctly; a null phrase (stop_phrases: []) shows no notice.
  useEffect(() => {
    if (!voiceConversationActive) {
      return
    }

    const phrase = $voiceStopPhrase.get()

    if (phrase) {
      notify({
        id: 'voice-stop-hint',
        kind: 'info',
        icon: 'mic',
        message: t.notifications.voice.sayStopToEnd(phrase)
      })
    }
  }, [t, voiceConversationActive])

  useEffect(() => resumeWakeIfUnused, [resumeWakeIfUnused])

  const startDictation = useCallback(
    async (generation?: number) => {
      // Conversation owns the shared recorder. Do not stop or alter it from a
      // dictate key; a stray hold while talking must be a harmless no-op.
      if (disabled || voiceConversationActiveRef.current || voiceStatus !== 'idle' || dictationStartingRef.current) {
        reportComposerDictateState('finished', target, generation)

        return
      }

      dictationStartingRef.current = true
      dictationGenerationRef.current = generation
      dictationStopRequestedRef.current = false
      dictationCancelRequestedRef.current = false

      try {
        await pauseWakeForVoice()

        if (voiceConversationActiveRef.current) {
          reportComposerDictateState('finished', target, generation)
          dictationGenerationRef.current = undefined

          return
        }

        if (!(await start())) {
          reportComposerDictateState('finished', target, generation)
          dictationGenerationRef.current = undefined

          return
        }

        dictationActiveRef.current = true
        reportComposerDictateState('started', target, generation)

        // The focus bus deliberately defers commands. A very short hold can
        // therefore queue stop immediately after start, before React has painted
        // `voiceStatus: 'recording'`; retain that intent instead of leaving mic
        // capture open until max duration.
        if (dictationCancelRequestedRef.current) {
          cancel()
        } else if (dictationStopRequestedRef.current) {
          void stop()
        }
      } finally {
        dictationStartingRef.current = false
        resumeWakeIfUnused()
      }
    },
    [cancel, disabled, pauseWakeForVoice, resumeWakeIfUnused, start, stop, target, voiceStatus]
  )

  const stopDictation = useCallback(
    (generation?: number) => {
      if (dictationStartingRef.current) {
        dictationStopRequestedRef.current = true

        return
      }

      if (dictationActiveRef.current) {
        if (generation !== undefined) {
          dictationGenerationRef.current = generation
        }

        void stop()
      }
    },
    [stop]
  )

  const cancelDictation = useCallback(
    (generation?: number) => {
      if (dictationStartingRef.current) {
        dictationCancelRequestedRef.current = true

        return
      }

      if (dictationActiveRef.current) {
        if (generation !== undefined) {
          dictationGenerationRef.current = generation
        }

        cancel()
      }
    },
    [cancel]
  )

  cancelDictationRef.current = cancelDictation

  const toggleDictation = useCallback(
    (generation?: number) => {
      if (dictationActiveRef.current || dictationStartingRef.current) {
        stopDictation(generation)
      } else {
        void startDictation(generation)
      }
    },
    [startDictation, stopDictation]
  )

  useEffect(() => {
    if (voiceConversationActive) {
      cancelDictation()
      void pauseWakeForVoice()
    } else {
      resumeWakeIfUnused()
    }
  }, [cancelDictation, pauseWakeForVoice, resumeWakeIfUnused, voiceConversationActive])

  useEffect(
    () =>
      onComposerDictateRequest(({ generation, request, target: requestTarget }) => {
        if (requestTarget !== target) {
          return
        }

        if (request === 'start') {
          void startDictation(generation)
        } else if (request === 'stop') {
          stopDictation(generation)
        } else if (request === 'cancel') {
          cancelDictation(generation)
        } else {
          toggleDictation(generation)
        }
      }),
    [cancelDictation, startDictation, stopDictation, target, toggleDictation]
  )

  // Explicit start/end for the on-screen conversation controls (the hotkey uses
  // the gated toggle above).
  const startConversation = useCallback(() => {
    voiceConversationActiveRef.current = true
    cancelDictationRef.current()
    setVoiceConversationActive(true)
  }, [])

  const endConversation = useCallback(() => {
    setVoiceConversationActive(false)
    void conversation.end()
  }, [conversation])

  const handleToggleAutoSpeak = useCallback(() => {
    void setAutoSpeakReplies(!$autoSpeakReplies.get()).catch(error =>
      notifyError(error, t.settings.config.autosaveFailed)
    )
  }, [t])

  useAutoSpeakReplies({
    conversationActive: voiceConversationActive,
    failureLabel: t.assistant.thread.readAloudFailed,
    markSpoken: consumePendingResponse,
    pendingReply: pendingResponse,
    sessionId
  })

  return {
    conversation,
    dictate: toggleDictation,
    endConversation,
    handleToggleAutoSpeak,
    startConversation,
    voiceActivityState,
    voiceConversationActive,
    voiceStatus
  }
}
