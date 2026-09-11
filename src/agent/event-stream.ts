import type { HarnessLocale } from '../locale'
import { DEFAULT_LOCALE, diagnostic } from '../locale'

/** 一个最多保留一个待消费事件的内部异步通道，生产者会自然服从消费者背压。 */
export class AsyncEventStream<T> implements AsyncIterableIterator<T> {
  private state: 'open' | 'closed' | 'failed' = 'open'

  private failure: unknown

  private pendingRead?: {
    resolve: (result: IteratorResult<T>) => void
    reject: (reason?: unknown) => void
  }

  private pendingWrite?: {
    value: T
    resolve: () => void
    reject: (reason?: unknown) => void
  }

  constructor(private readonly locale: HarnessLocale = DEFAULT_LOCALE) {}

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this
  }

  /** 写入会等待消费者接走事件，避免慢客户端导致无界内存增长。 */
  async write(value: T): Promise<void> {
    if (this.state !== 'open')
      throw this.failure ?? new Error(diagnostic(this.locale, 'Agent 输出流已关闭', 'Agent output stream is closed'))
    if (this.pendingWrite)
      throw new Error(diagnostic(this.locale, 'Agent 输出流只允许串行写入', 'Agent output stream only supports serial writes'))

    const reader = this.pendingRead
    if (reader) {
      this.pendingRead = undefined
      reader.resolve({ done: false, value })
      return
    }

    await new Promise<void>((resolve, reject) => {
      this.pendingWrite = { value, resolve, reject }
    })
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.pendingRead)
      throw new Error(diagnostic(this.locale, 'Agent 输出流只允许串行读取', 'Agent output stream only supports serial reads'))

    const writer = this.pendingWrite
    if (writer) {
      this.pendingWrite = undefined
      writer.resolve()
      return { done: false, value: writer.value }
    }
    if (this.state === 'closed')
      return { done: true, value: undefined }
    if (this.state === 'failed')
      throw this.failure

    return await new Promise<IteratorResult<T>>((resolve, reject) => {
      this.pendingRead = { resolve, reject }
    })
  }

  close(): void {
    if (this.state !== 'open')
      return
    this.state = 'closed'
    this.pendingRead?.resolve({ done: true, value: undefined })
    this.pendingRead = undefined
  }

  fail(reason: unknown): void {
    if (this.state !== 'open')
      return
    this.state = 'failed'
    this.failure = reason
    this.pendingRead?.reject(reason)
    this.pendingRead = undefined
    this.pendingWrite?.reject(reason)
    this.pendingWrite = undefined
  }

  async return(): Promise<IteratorResult<T>> {
    this.fail(new Error(diagnostic(this.locale, 'Agent 输出流已由消费者取消', 'Agent output stream was cancelled by the consumer')))
    return { done: true, value: undefined }
  }
}
