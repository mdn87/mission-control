import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatInput } from './chat-input'
import { useMissionControl } from '@/store'
import { DEEPSEEK_CHAT_MODEL, GROK_CHAT_MODEL, LOCAL_CHAT_MODEL } from '@/integrations/lugos/model-budgets'

const apiFetchMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api-client', () => ({ apiFetch: apiFetchMock }))

function freshBudgets() {
  return {
    schema: 'lugos-model-budgets/v1',
    generatedAt: new Date().toISOString(),
    staleAfterSeconds: 120,
    defaultModel: LOCAL_CHAT_MODEL,
    lanes: [
      { id: 'deepseek', label: 'DeepSeek', model: DEEPSEEK_CHAT_MODEL, provider: 'NVIDIA', paid: true, maxBudgetUsd: 2, maxOutputTokens: 2048, spendUsd: 0.25, remainingUsd: 1.75, percentUsed: 12.5, budgetDuration: '30d', resetAt: null, status: 'healthy' },
      { id: 'grok', label: 'Grok', model: GROK_CHAT_MODEL, provider: 'xAI', paid: true, maxBudgetUsd: 2, maxOutputTokens: 2048, spendUsd: 1.6, remainingUsd: 0.4, percentUsed: 80, budgetDuration: '30d', resetAt: null, status: 'warning' },
    ],
  }
}

describe('ChatInput paid-model controls', () => {
  beforeEach(() => {
    apiFetchMock.mockReset()
    apiFetchMock.mockResolvedValue(freshBudgets())
    useMissionControl.setState({ chatInput: '', isSendingMessage: false })
  })

  it('keeps local as default and requires a second explicit action for a paid send', async () => {
    const onSend = vi.fn()
    render(<ChatInput onSend={onSend} />)
    const selector = await screen.findByLabelText('Chat model')
    expect(selector).toHaveValue(LOCAL_CHAT_MODEL)
    expect(await screen.findByText(/DeepSeek \$1\.75 left/)).toBeInTheDocument()
    expect(screen.getByText(/Grok \$0\.400 left · 80% warning/)).toBeInTheDocument()

    fireEvent.change(selector, { target: { value: DEEPSEEK_CHAT_MODEL } })
    fireEvent.change(screen.getByPlaceholderText(/Message/), { target: { value: 'Use the paid lane' } })
    fireEvent.click(screen.getByTitle('Send message'))

    expect(onSend).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Confirm paid DeepSeek request' })).toBeInTheDocument()
    expect(screen.getByText('2,048 tokens')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Use DeepSeek' }))

    expect(onSend).toHaveBeenCalledWith('Use the paid lane', undefined, {
      model: DEEPSEEK_CHAT_MODEL,
      paidModelConfirmed: true,
    })
  })

  it('fails closed to local when the budget read is unavailable', async () => {
    apiFetchMock.mockRejectedValue(new Error('offline'))
    render(<ChatInput onSend={vi.fn()} />)
    expect(await screen.findByText('Paid routes unavailable')).toBeInTheDocument()
    const selector = screen.getByLabelText('Chat model')
    expect(selector).toHaveValue(LOCAL_CHAT_MODEL)
    expect((screen.getByRole('option', { name: 'DeepSeek · paid' }) as HTMLOptionElement).disabled).toBe(true)
  })
})
