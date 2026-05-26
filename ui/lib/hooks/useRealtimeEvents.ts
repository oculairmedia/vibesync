/**
 * useRealtimeEvents Hook
 *
 * Hook for Server-Sent Events (SSE) real-time updates
 */

import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { SSEEvent } from '../types'
import {
  SSEConnectedEventSchema,
  SSESyncStartedEventSchema,
  SSESyncCompletedEventSchema,
  SSESyncErrorEventSchema,
  SSEConfigUpdatedEventSchema,
  SSEHealthUpdatedEventSchema,
  SSEOrchestrationEventSchema,
} from '../schemas'

interface UseRealtimeEventsOptions {
  onConnected?: (clientId: string) => void
  onSyncStarted?: (data: any) => void
  onSyncCompleted?: (data: any) => void
  onSyncError?: (data: any) => void
  onConfigUpdated?: (data: any) => void
  onHealthUpdated?: (data: any) => void
  onEvent?: (event: SSEEvent) => void
}

const ORCHESTRATION_EVENT_TYPES = [
  'dispatcher/formula.started',
  'dispatcher/formula.completed',
  'dispatcher/formula.failed',
  'dispatcher/formula.cancelled',
  'dispatcher/formula.resume.paused',
  'dispatcher/step.started',
  'dispatcher/step.task_recorded',
  'dispatcher/step.finished',
  'dispatcher/step.failed',
  'dispatcher/step.retry',
  'dispatcher/step.cancelled',
  'runtime/session.started',
  'runtime/session.first_token',
  'runtime/session.message_delta',
  'runtime/session.tool_call',
  'runtime/session.tool_result',
  'runtime/session.usage',
  'runtime/session.turn_done',
  'runtime/session.error',
  'runtime/session.stopped',
  'runtime/provider.deprecated.instantiated',
  'health-patrol/session.stalled',
  'health-patrol/session.restarted',
  'health-patrol/session.unhealthy',
  'health-patrol/daemon.restarted',
  'health-patrol/daemon.unhealthy',
] as const

export interface RealtimeEventsState {
  connected: boolean
  reconnecting: boolean
  error: string | null
  events: SSEEvent[]
}

/**
 * Hook for SSE real-time events
 *
 * Automatically connects to /api/events/stream and handles reconnection
 *
 * @param options - Event handlers
 * @returns Events state and connection info
 */
export function useRealtimeEvents(options: UseRealtimeEventsOptions = {}) {
  const queryClient = useQueryClient()
  const eventSourceRef = useRef<EventSource | null>(null)
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const [state, setState] = useState<RealtimeEventsState>({
    connected: false,
    reconnecting: false,
    error: null,
    events: [],
  })

  const [reconnectDelay, setReconnectDelay] = useState(1000) // Start with 1 second

  const appendEvent = (event: SSEEvent) => {
    setState(prev => ({
      ...prev,
      events: [event, ...prev.events].slice(0, 100),
    }))
    options.onEvent?.(event)
  }

  /**
   * Connect to SSE stream
   */
  const connect = () => {
    // Don't connect if already connected or reconnecting
    if (eventSourceRef.current) {
      return
    }

    setState(prev => ({ ...prev, reconnecting: true, error: null }))

    const apiUrl = process.env.NEXT_PUBLIC_API_URL || ''
    const url = `${apiUrl}/api/events/stream`

    try {
      const eventSource = new EventSource(url)
      eventSourceRef.current = eventSource

      // Handle connection open
      eventSource.onopen = () => {
        setState(prev => ({
          ...prev,
          connected: true,
          reconnecting: false,
          error: null,
        }))
        setReconnectDelay(1000) // Reset delay on successful connection
      }

      // Handle generic messages
      eventSource.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data)
          const event: SSEEvent = {
            type: e.type || 'message',
            data,
            timestamp: new Date().toISOString(),
          }

          appendEvent(event)
        } catch (error) {
          console.error('Failed to parse SSE message:', error)
        }
      }

      // Handle specific event types
      eventSource.addEventListener('connected', (e) => {
        try {
          const rawData = JSON.parse(e.data)
          const event = SSEConnectedEventSchema.parse({
            type: 'connected',
            data: rawData,
            timestamp: new Date().toISOString(),
          })
          appendEvent(event)
          options.onConnected?.(event.data.clientId)
        } catch (error) {
          console.error('Failed to validate connected event:', error)
        }
      })

      eventSource.addEventListener('sync:started', (e) => {
        try {
          const rawData = JSON.parse(e.data)
          const event = SSESyncStartedEventSchema.parse({
            type: 'sync:started',
            data: rawData,
            timestamp: new Date().toISOString(),
          })
          appendEvent(event)
          options.onSyncStarted?.(event.data)
        } catch (error) {
          console.error('Failed to validate sync:started event:', error)
        }
      })

      eventSource.addEventListener('sync:completed', (e) => {
        try {
          const rawData = JSON.parse(e.data)
          const event = SSESyncCompletedEventSchema.parse({
            type: 'sync:completed',
            data: rawData,
            timestamp: new Date().toISOString(),
          })
          appendEvent(event)
          options.onSyncCompleted?.(event.data)

          // Invalidate health query to refetch updated stats
          queryClient.invalidateQueries({ queryKey: ['health'] })
          queryClient.invalidateQueries({ queryKey: ['syncHistory'] })
        } catch (error) {
          console.error('Failed to validate sync:completed event:', error)
        }
      })

      eventSource.addEventListener('sync:error', (e) => {
        try {
          const rawData = JSON.parse(e.data)
          const event = SSESyncErrorEventSchema.parse({
            type: 'sync:error',
            data: rawData,
            timestamp: new Date().toISOString(),
          })
          appendEvent(event)
          options.onSyncError?.(event.data)

          // Invalidate health query to show error
          queryClient.invalidateQueries({ queryKey: ['health'] })
        } catch (error) {
          console.error('Failed to validate sync:error event:', error)
        }
      })

      eventSource.addEventListener('config:updated', (e) => {
        try {
          const rawData = JSON.parse(e.data)
          const event = SSEConfigUpdatedEventSchema.parse({
            type: 'config:updated',
            data: rawData,
            timestamp: new Date().toISOString(),
          })
          appendEvent(event)
          options.onConfigUpdated?.(event.data)

          // Invalidate config query to refetch
          queryClient.invalidateQueries({ queryKey: ['config'] })
          queryClient.invalidateQueries({ queryKey: ['health'] })
        } catch (error) {
          console.error('Failed to validate config:updated event:', error)
        }
      })

      eventSource.addEventListener('health:updated', (e) => {
        try {
          const rawData = JSON.parse(e.data)
          const event = SSEHealthUpdatedEventSchema.parse({
            type: 'health:updated',
            data: rawData,
            timestamp: new Date().toISOString(),
          })
          appendEvent(event)
          options.onHealthUpdated?.(event.data)

          // Optionally update health cache directly
          queryClient.setQueryData(['health'], event.data)
        } catch (error) {
          console.error('Failed to validate health:updated event:', error)
        }
      })

      for (const eventType of ORCHESTRATION_EVENT_TYPES) {
        eventSource.addEventListener(eventType, (e) => {
          try {
            const rawData = JSON.parse(e.data)
            const event = SSEOrchestrationEventSchema.parse({
              type: eventType,
              data: rawData,
              timestamp: new Date().toISOString(),
            })
            const payload = event.data.payload
            const isDelta = eventType === 'runtime/session.message_delta'
            const textLength = typeof payload?.textLength === 'number' ? payload.textLength : 0
            if (!isDelta || textLength > 0) appendEvent(event)
            if (eventType.startsWith('runtime/') || eventType.startsWith('dispatcher/') || eventType.startsWith('health-patrol/')) {
              queryClient.invalidateQueries({ queryKey: ['orchestration'] })
            }
          } catch (error) {
            console.error(`Failed to validate ${eventType} event:`, error)
          }
        })
      }

      // Handle errors
      eventSource.onerror = (error) => {
        console.error('SSE error:', error)

        setState(prev => ({
          ...prev,
          connected: false,
          reconnecting: false,
          error: 'Connection lost',
        }))

        // Close the connection
        eventSource.close()
        eventSourceRef.current = null

        // Schedule reconnection with exponential backoff
        reconnectTimeoutRef.current = setTimeout(() => {
          setReconnectDelay(prev => Math.min(prev * 2, 30000)) // Max 30 seconds
          connect()
        }, reconnectDelay)
      }
    } catch (error) {
      console.error('Failed to create EventSource:', error)
      setState(prev => ({
        ...prev,
        connected: false,
        reconnecting: false,
        error: 'Failed to connect',
      }))
    }
  }

  /**
   * Disconnect from SSE stream
   */
  const disconnect = () => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = null
    }

    if (eventSourceRef.current) {
      eventSourceRef.current.close()
      eventSourceRef.current = null
    }

    setState(prev => ({
      ...prev,
      connected: false,
      reconnecting: false,
    }))
  }

  // Connect on mount, disconnect on unmount
  useEffect(() => {
    connect()

    return () => {
      disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return {
    ...state,
    reconnect: connect,
    disconnect,
  }
}
