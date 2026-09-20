import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { expect, it } from 'vitest'

it('waits for asynchronous removal after an entry loses its fiber', async () => {
  const ctx = new Context()
  let release!: () => void
  let started!: () => void
  const cleanup = new Promise<void>(resolve => { release = resolve })
  const disposing = new Promise<void>(resolve => { started = resolve })
  try {
    await ctx.plugin(Loader).await()
    ctx.loader.builtins.fixture = (child: Context) => {
      child.effect(() => async () => { started(); await cleanup })
    }
    await ctx.loader.root.update([{ id: 'fixture', name: 'cordis:fixture' }])
    const removal = ctx.loader.root.remove('fixture')
    await disposing
    let settled = false
    const waiting = ctx.loader.await().then(() => { settled = true })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(settled).toBe(false)
    release()
    await Promise.all([removal, waiting])
    expect([...ctx.loader.entries()]).toHaveLength(0)
  } finally {
    release()
    await ctx.fiber.dispose()
  }
})
