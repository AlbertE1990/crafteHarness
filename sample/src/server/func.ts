import { ToolError } from '../../../src'

/** 服务端业务工具真正需要的最小执行上下文。 */
interface ServerToolContext {
  readonly signal?: AbortSignal
}

type TimeUnit = 'day' | 'week' | 'month' | 'year'
type TimePreset
  = | 'now'
    | 'this_week'
    | 'last_week'
    | 'next_week'
    | 'this_month'
    | 'last_month'
    | 'next_month'
    | 'this_year'
    | 'last_year'
    | 'next_year'

interface GetTimeArgs {
  amount?: number | null
  unit?: TimeUnit | null
  preset?: TimePreset | null
  timezone?: string | null
}

interface GetTimeResult {
  timezone: string
  current_datetime: string
  date: string | null
  time: string
  weekday: string | null
  range_start: string | null
  range_end: string | null
  label: string
}

interface UserLocationResult {
  ip: string
  country: string
  province: string
  city: string
  district: string | null
  latitude: number
  longitude: number
  timezone: string | null
  accuracy: 'approximate_ip'
}

interface WeatherLocation {
  city: string
  province: string | null
  country: string
  latitude: number
  longitude: number
  timezone: string | null
}

interface WeatherResult extends WeatherLocation {
  weather: string
  weather_code: number
  temperature_c: number
  feels_like_c: number
  humidity_percent: number
  wind_direction: string
  wind_speed_kmh: number
  wind_scale: number
  observed_at: string
}

interface IpWhoIsResponse {
  success?: boolean
  message?: string
  ip?: string
  country?: string
  region?: string
  city?: string
  latitude?: number
  longitude?: number
  timezone?: { id?: string }
}

interface GeocodingResponse {
  results?: Array<{
    name?: string
    latitude?: number
    longitude?: number
    timezone?: string
    country?: string
    admin1?: string
  }>
  reason?: string
}

interface ForecastResponse {
  timezone?: string
  current?: {
    time?: string
    temperature_2m?: number
    apparent_temperature?: number
    relative_humidity_2m?: number
    weather_code?: number
    wind_speed_10m?: number
    wind_direction_10m?: number
  }
  reason?: string
}

interface DateParts {
  year: number
  month: number
  day: number
}

interface DateTimeParts extends DateParts {
  hour: number
  minute: number
  second: number
}

const DEFAULT_TIMEZONE = 'Asia/Shanghai'
const REQUEST_TIMEOUT_MS = 8_000
const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504])
const timeUnits: TimeUnit[] = ['day', 'week', 'month', 'year']
const timePresets: TimePreset[] = [
  'now',
  'this_week',
  'last_week',
  'next_week',
  'this_month',
  'last_month',
  'next_month',
  'this_year',
  'last_year',
  'next_year',
]

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function requireObject(value: unknown, name = '参数'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError(`${name}必须是 JSON 对象`)
  return value as Record<string, unknown>
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ToolError({
      code: 'UPSTREAM_INVALID_RESPONSE',
      message: `外部服务缺少有效字段：${field}`,
      retryable: true,
    })
  }
  return value.trim()
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ToolError({
      code: 'UPSTREAM_INVALID_RESPONSE',
      message: `外部服务缺少有效字段：${field}`,
      retryable: true,
    })
  }
  return value
}

function normalizeRequestError(
  error: unknown,
  service: string,
  callerSignal?: AbortSignal,
): ToolError {
  if (error instanceof ToolError)
    return error

  if (callerSignal?.aborted)
    return new ToolError({ code: 'ABORTED', message: '工具调用已取消' })

  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return new ToolError({
      code: 'UPSTREAM_TIMEOUT',
      message: `${service}请求超时`,
      retryable: true,
      cause: error,
    })
  }

  return new ToolError({
    code: 'UPSTREAM_NETWORK_ERROR',
    message: `${service}请求失败：${getErrorMessage(error)}`,
    retryable: true,
    cause: error,
  })
}

/**
 * 单次请求外部 JSON API；这里只识别错误类型，不在传输层自行重试。
 * 重试由 Harness 统一调度，避免 HTTP 层与工具层叠加后产生倍增请求。
 */
async function requestJson<T>(url: URL, service: string, callerSignal?: AbortSignal): Promise<T> {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, timeoutSignal])
    : timeoutSignal

  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal,
    })

    if (!response.ok) {
      throw new ToolError({
        code: 'UPSTREAM_HTTP_ERROR',
        message: `${service}返回 HTTP ${response.status}`,
        retryable: RETRYABLE_HTTP_STATUSES.has(response.status),
        details: { status: response.status },
      })
    }

    try {
      return await response.json() as T
    }
    catch {
      throw new ToolError({
        code: 'UPSTREAM_INVALID_RESPONSE',
        message: `${service}返回了无效 JSON`,
        retryable: true,
      })
    }
  }
  catch (error) {
    throw normalizeRequestError(error, service, callerSignal)
  }
}

/** 校验模型传入的相对时间单位。 */
function isTimeUnit(value: unknown): value is TimeUnit {
  return timeUnits.includes(value as TimeUnit)
}

/** 校验模型传入的常用时间范围枚举。 */
function isTimePreset(value: unknown): value is TimePreset {
  return timePresets.includes(value as TimePreset)
}

/** 规范并验证 IANA 时区；空值按服务器工具的默认时区处理。 */
function resolveTimezone(value: unknown): string {
  if (value == null || value === '')
    return DEFAULT_TIMEZONE
  if (typeof value !== 'string')
    throw new TypeError('timezone 必须是 IANA 时区名称字符串或 null')

  const timezone = value.trim()
  try {
    new Intl.DateTimeFormat('zh-CN', { timeZone: timezone }).format()
  }
  catch {
    throw new RangeError(`不支持的时区：${timezone}，请使用有效的 IANA 时区名称`)
  }
  return timezone
}

/** 在指定时区中拆出稳定的日期时间数字，避免依赖服务器本地时区。 */
function getDateTimeParts(date: Date, timezone: string): DateTimeParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  }
}

/** 将数字补齐为两位日期/时间字段。 */
function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** 格式化仅承载日历信息的 UTC Date。 */
function formatDate(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

/** 格式化目标时区下的时分秒。 */
function formatTime(parts: DateTimeParts): string {
  return `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`
}

/** 根据同一时刻的 UTC 值和目标时区墙上时间计算 ISO 8601 偏移量。 */
function formatTimezoneOffset(now: Date, parts: DateTimeParts): string {
  const utcFromLocalParts = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  )
  const instantWithoutMilliseconds = Math.floor(now.getTime() / 1000) * 1000
  const offsetMinutes = Math.round((utcFromLocalParts - instantWithoutMilliseconds) / 60_000)
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absoluteMinutes = Math.abs(offsetMinutes)
  return `${sign}${pad(Math.floor(absoluteMinutes / 60))}:${pad(absoluteMinutes % 60)}`
}

/** 用 UTC Date 作为无时区的日历日期容器，防止宿主机时区改变日期。 */
function toCalendarDate(parts: DateParts): Date {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day))
}

/** 按日历天数偏移日期。 */
function addDays(date: Date, amount: number): Date {
  const result = new Date(date)
  result.setUTCDate(result.getUTCDate() + amount)
  return result
}

/** 按月份偏移，并把月末日期钳制到目标月实际存在的最后一天。 */
function addMonths(date: Date, amount: number): Date {
  const totalMonths = date.getUTCFullYear() * 12 + date.getUTCMonth() + amount
  const year = Math.floor(totalMonths / 12)
  const month = ((totalMonths % 12) + 12) % 12
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return new Date(Date.UTC(year, month, Math.min(date.getUTCDate(), lastDay)))
}

/** 按年份偏移，并正确处理闰年 2 月 29 日。 */
function addYears(date: Date, amount: number): Date {
  const year = date.getUTCFullYear() + amount
  const month = date.getUTCMonth()
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return new Date(Date.UTC(year, month, Math.min(date.getUTCDate(), lastDay)))
}

/** 返回中文星期名称。 */
function getWeekday(date: Date): string {
  return new Intl.DateTimeFormat('zh-CN', {
    weekday: 'long',
    timeZone: 'UTC',
  }).format(date)
}

/** 计算本/上/下周、月、年的闭区间。周范围按周一到周日定义。 */
function getRange(preset: Exclude<TimePreset, 'now'>, today: Date) {
  const presetLabels: Record<Exclude<TimePreset, 'now'>, string> = {
    this_week: '本周',
    last_week: '上周',
    next_week: '下周',
    this_month: '本月',
    last_month: '上月',
    next_month: '下月',
    this_year: '今年',
    last_year: '去年',
    next_year: '明年',
  }

  let start: Date
  let end: Date

  if (preset.endsWith('_week')) {
    const weekOffset = preset === 'last_week' ? -7 : preset === 'next_week' ? 7 : 0
    const daysSinceMonday = (today.getUTCDay() + 6) % 7
    start = addDays(today, weekOffset - daysSinceMonday)
    end = addDays(start, 6)
  }
  else if (preset.endsWith('_month')) {
    const monthOffset = preset === 'last_month' ? -1 : preset === 'next_month' ? 1 : 0
    start = addMonths(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)), monthOffset)
    end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0))
  }
  else {
    const yearOffset = preset === 'last_year' ? -1 : preset === 'next_year' ? 1 : 0
    const year = today.getUTCFullYear() + yearOffset
    start = new Date(Date.UTC(year, 0, 1))
    end = new Date(Date.UTC(year, 11, 31))
  }

  return {
    start,
    end,
    label: presetLabels[preset],
  }
}

/**
 * 日期工具业务实现：支持某个相对日期或预设时间范围，返回结构化 JSON。
 * preset 与 amount/unit 互斥，避免模型给出含义冲突的参数。
 */
function calculateTime(args: GetTimeArgs = {}): GetTimeResult {
  const { amount = null, unit = null, preset = null } = args
  const timezone = resolveTimezone(args.timezone)

  if (amount !== null && !Number.isInteger(amount))
    throw new TypeError('amount 必须是整数或 null')
  if (unit !== null && !isTimeUnit(unit))
    throw new RangeError(`不支持的时间单位：${String(unit)}`)
  if (preset !== null && !isTimePreset(preset))
    throw new RangeError(`不支持的时间范围：${String(preset)}`)
  if (preset !== null && (amount !== null || unit !== null))
    throw new Error('preset 与 amount/unit 不能同时使用')

  const now = new Date()
  const current = getDateTimeParts(now, timezone)
  const today = toCalendarDate(current)
  const currentDate = formatDate(today)
  const currentTime = formatTime(current)
  const currentDatetime = `${currentDate}T${currentTime}${formatTimezoneOffset(now, current)}`

  if (preset && preset !== 'now') {
    const range = getRange(preset, today)
    const rangeStart = formatDate(range.start)
    const rangeEnd = formatDate(range.end)
    return {
      timezone,
      current_datetime: currentDatetime,
      date: null,
      time: currentTime,
      weekday: null,
      range_start: rangeStart,
      range_end: rangeEnd,
      label: `${range.label} ${rangeStart} 至 ${rangeEnd}`,
    }
  }

  const offset = amount ?? 0
  const targetUnit = unit ?? 'day'
  const target = targetUnit === 'day'
    ? addDays(today, offset)
    : targetUnit === 'week'
      ? addDays(today, offset * 7)
      : targetUnit === 'month'
        ? addMonths(today, offset)
        : addYears(today, offset)
  const date = formatDate(target)
  const weekday = getWeekday(target)
  const unitLabels: Record<TimeUnit, string> = {
    day: '天',
    week: '周',
    month: '个月',
    year: '年',
  }
  const relativeLabel = offset === 0
    ? '今天'
    : `${Math.abs(offset)}${unitLabels[targetUnit]}${offset > 0 ? '后' : '前'}`

  return {
    timezone,
    current_datetime: currentDatetime,
    date,
    time: currentTime,
    weekday,
    range_start: null,
    range_end: null,
    label: `${relativeLabel} ${date}（${weekday}）${offset === 0 ? ` ${currentTime}` : ''}`,
  }
}

/** 返回原始业务数据；参数错误由 Harness 捕获并转换为工具失败消息。 */
export function getTime(args: unknown = {}): GetTimeResult {
  const input = requireObject(args) as GetTimeArgs
  return calculateTime(input)
}

/** 通过服务器出口 IP 获取近似位置；IP 定位不等同于浏览器 GPS 精确定位。 */
async function lookupUserLocation(context: ServerToolContext): Promise<UserLocationResult> {
  const url = new URL('https://ipwho.is/')
  url.searchParams.set('lang', 'zh-CN')
  url.searchParams.set(
    'fields',
    'success,message,ip,country,region,city,latitude,longitude,timezone.id',
  )

  const response = await requestJson<IpWhoIsResponse>(url, 'IP 定位服务', context.signal)
  if (response.success !== true) {
    throw new ToolError({
      code: 'LOCATION_LOOKUP_FAILED',
      message: response.message || 'IP 定位服务无法确定当前位置',
    })
  }

  return {
    ip: requireString(response.ip, 'ip'),
    country: requireString(response.country, 'country'),
    province: requireString(response.region, 'region'),
    city: requireString(response.city, 'city'),
    district: null,
    latitude: requireNumber(response.latitude, 'latitude'),
    longitude: requireNumber(response.longitude, 'longitude'),
    timezone: typeof response.timezone?.id === 'string' ? response.timezone.id : null,
    accuracy: 'approximate_ip',
  }
}

/** 查询用户的近似 IP 位置，返回值不带 Harness 协议外壳。 */
export async function getUserLocation(
  args: unknown = {},
  context: ServerToolContext = {},
): Promise<UserLocationResult> {
  const input = requireObject(args)
  if (Object.keys(input).length > 0)
    throw new TypeError('get_user_location 不接受参数')

  return await lookupUserLocation(context)
}

/** 将城市名称解析为天气接口所需的 WGS84 坐标。 */
async function geocodeCity(city: string, context: ServerToolContext): Promise<WeatherLocation> {
  const url = new URL('https://geocoding-api.open-meteo.com/v1/search')
  url.searchParams.set('name', city)
  url.searchParams.set('count', '1')
  url.searchParams.set('language', 'zh')
  url.searchParams.set('format', 'json')

  const response = await requestJson<GeocodingResponse>(url, '城市地理编码服务', context.signal)
  const result = response.results?.[0]
  if (!result) {
    throw new ToolError({
      code: 'CITY_NOT_FOUND',
      message: response.reason || `未找到城市：${city}`,
    })
  }

  return {
    city: requireString(result.name, 'name'),
    province: typeof result.admin1 === 'string' ? result.admin1 : null,
    country: requireString(result.country, 'country'),
    latitude: requireNumber(result.latitude, 'latitude'),
    longitude: requireNumber(result.longitude, 'longitude'),
    timezone: typeof result.timezone === 'string' ? result.timezone : null,
  }
}

function getWeatherDescription(code: number): string {
  if (code === 0)
    return '晴'
  if (code === 1)
    return '晴间多云'
  if (code === 2)
    return '多云'
  if (code === 3)
    return '阴'
  if (code === 45 || code === 48)
    return '雾'
  if ([51, 53, 55].includes(code))
    return '毛毛雨'
  if ([56, 57].includes(code))
    return '冻毛毛雨'
  if ([61, 63, 65].includes(code))
    return code === 61 ? '小雨' : code === 63 ? '中雨' : '大雨'
  if ([66, 67].includes(code))
    return '冻雨'
  if ([71, 73, 75, 77].includes(code))
    return code === 71 ? '小雪' : code === 73 ? '中雪' : '大雪'
  if ([80, 81, 82].includes(code))
    return '阵雨'
  if ([85, 86].includes(code))
    return '阵雪'
  if (code === 95)
    return '雷暴'
  if (code === 96 || code === 99)
    return '雷暴伴冰雹'
  return `未知天气（WMO ${code}）`
}

/** 将气象风向角转换为 16 方位中文名称。 */
function getWindDirection(degrees: number): string {
  const directions = [
    '北风',
    '北东北风',
    '东北风',
    '东东北风',
    '东风',
    '东东南风',
    '东南风',
    '南东南风',
    '南风',
    '南西南风',
    '西南风',
    '西西南风',
    '西风',
    '西西北风',
    '西北风',
    '北西北风',
  ]
  const normalized = ((degrees % 360) + 360) % 360
  return directions[Math.round(normalized / 22.5) % directions.length]
}

/** 按蒲福风级阈值把 km/h 风速转换为 0 至 12 级。 */
function getWindScale(speedKmh: number): number {
  const upperBounds = [1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118]
  const scale = upperBounds.findIndex(bound => speedKmh < bound)
  return scale === -1 ? 12 : scale
}

/** 查询给定坐标的当前天气模型数据。 */
async function lookupWeather(
  location: WeatherLocation,
  context: ServerToolContext,
): Promise<WeatherResult> {
  const url = new URL('https://api.open-meteo.com/v1/forecast')
  url.searchParams.set('latitude', String(location.latitude))
  url.searchParams.set('longitude', String(location.longitude))
  url.searchParams.set(
    'current',
    'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m',
  )
  url.searchParams.set('timezone', 'auto')
  url.searchParams.set('forecast_days', '1')

  const response = await requestJson<ForecastResponse>(url, '天气服务', context.signal)
  const current = response.current
  if (!current) {
    throw new ToolError({
      code: 'WEATHER_DATA_UNAVAILABLE',
      message: response.reason || '天气服务未返回当前天气',
      retryable: true,
    })
  }

  const weatherCode = requireNumber(current.weather_code, 'current.weather_code')
  const windSpeed = requireNumber(current.wind_speed_10m, 'current.wind_speed_10m')
  const windDegrees = requireNumber(current.wind_direction_10m, 'current.wind_direction_10m')

  return {
    ...location,
    timezone: typeof response.timezone === 'string' ? response.timezone : location.timezone,
    weather: getWeatherDescription(weatherCode),
    weather_code: weatherCode,
    temperature_c: requireNumber(current.temperature_2m, 'current.temperature_2m'),
    feels_like_c: requireNumber(current.apparent_temperature, 'current.apparent_temperature'),
    humidity_percent: requireNumber(current.relative_humidity_2m, 'current.relative_humidity_2m'),
    wind_direction: getWindDirection(windDegrees),
    wind_speed_kmh: windSpeed,
    wind_scale: getWindScale(windSpeed),
    observed_at: requireString(current.time, 'current.time'),
  }
}

/**
 * 查询当前天气。city 为空时在工具内部完成 IP 定位，避免模型固定调用两个工具。
 */
export async function getWeather(
  args: unknown = {},
  context: ServerToolContext = {},
): Promise<WeatherResult> {
  const input = requireObject(args)
  const rawCity = input.city
  if (rawCity !== undefined && rawCity !== null && typeof rawCity !== 'string')
    throw new TypeError('city 必须是字符串或 null')

  const city = typeof rawCity === 'string' ? rawCity.trim() : ''
  const location = city
    ? await geocodeCity(city, context)
    : await lookupUserLocation(context)
  const weatherLocation: WeatherLocation = {
    city: location.city,
    province: location.province,
    country: location.country,
    latitude: location.latitude,
    longitude: location.longitude,
    timezone: location.timezone,
  }
  return await lookupWeather(weatherLocation, context)
}
