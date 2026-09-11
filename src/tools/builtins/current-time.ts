import type { HarnessLocale } from '../../locale'
import { z } from 'zod'
import { diagnostic, resolveLocale } from '../../locale'
import { defineTool } from '../define-tool'
import { ToolError } from '../errors'

/** 为时间工具提供可替换时钟，使单元测试不依赖真实当前时间。 */
export interface Clock {
  now: () => Date
}

/** 创建当前时间工具时可以覆盖的运行参数。 */
export interface CurrentTimeToolOptions {
  readonly locale?: HarnessLocale
  readonly defaultTimezone?: string
  readonly clock?: Clock
}

const systemClock: Clock = {
  now: () => new Date(),
}

/**
 * 创建无外部服务依赖的当前日期时间工具。
 *
 * 工具接受 IANA 时区并返回带偏移量的 ISO 8601 墙上时间；空值使用创建时配置的默认时区。
 */
export function createCurrentTimeTool(options: CurrentTimeToolOptions = {}) {
  const locale = resolveLocale(options.locale)
  const defaultTimezone = validateTimezone(options.defaultTimezone ?? 'Asia/Shanghai', locale)
  const clock = options.clock ?? systemClock

  return defineTool({
    name: 'get_current_time',
    description: '获取指定 IANA 时区的当前日期、时间、星期和 UTC 偏移量。',
    inputSchema: z.strictObject({
      timezone: z.string()
        .min(1)
        .nullable()
        .optional()
        .describe('IANA 时区名称，例如 Asia/Shanghai；省略或传 null 时使用默认时区。'),
    }),
    outputSchema: z.strictObject({
      timezone: z.string(),
      currentDatetime: z.string(),
      date: z.string(),
      time: z.string(),
      weekday: z.string(),
      utcOffset: z.string(),
    }),
    execute(input) {
      const timezone = validateTimezone(input.timezone ?? defaultTimezone, locale)
      const now = clock.now()
      if (!Number.isFinite(now.getTime())) {
        throw new ToolError({
          code: 'INVALID_CLOCK_VALUE',
          message: diagnostic(locale, '时钟返回了无效日期', 'Clock returned an invalid date'),
        })
      }

      const parts = getDateTimeParts(now, timezone)
      const date = `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`
      const time = `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`
      const utcOffset = getUtcOffset(now, parts)

      return {
        timezone,
        currentDatetime: `${date}T${time}${utcOffset}`,
        date,
        time,
        weekday: new Intl.DateTimeFormat('zh-CN', {
          timeZone: timezone,
          weekday: 'long',
        }).format(now),
        utcOffset,
      }
    },
  }, { locale })
}

/** 时间格式化所需的数字字段。 */
interface DateTimeParts {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly second: number
}

/** 验证 IANA 时区名称，并将底层 RangeError 转成稳定工具错误。 */
function validateTimezone(timezone: string, locale: HarnessLocale): string {
  const normalized = timezone.trim()
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: normalized }).format()
  }
  catch (error) {
    throw new ToolError({
      code: 'INVALID_TIMEZONE',
      message: diagnostic(locale, `不支持的 IANA 时区：${normalized}`, `Unsupported IANA timezone: ${normalized}`),
      cause: error,
    })
  }
  return normalized
}

/** 在指定时区中提取稳定的日期时间数字。 */
function getDateTimeParts(date: Date, timezone: string): DateTimeParts {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date).map(part => [part.type, part.value]),
  )

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  }
}

/** 根据同一时刻的 UTC 值和目标墙上时间计算 ISO 8601 偏移量。 */
function getUtcOffset(now: Date, parts: DateTimeParts): string {
  const localAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  )
  const instant = Math.floor(now.getTime() / 1000) * 1000
  const offsetMinutes = Math.round((localAsUtc - instant) / 60_000)
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absoluteMinutes = Math.abs(offsetMinutes)
  return `${sign}${pad(Math.floor(absoluteMinutes / 60))}:${pad(absoluteMinutes % 60)}`
}

/** 将日期时间字段补齐为两位。 */
function pad(value: number): string {
  return String(value).padStart(2, '0')
}
