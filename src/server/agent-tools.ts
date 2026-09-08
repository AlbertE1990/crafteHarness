import type {
  DefinedTool,
  ExecuteToolOptions,
  ToolExecutionResult,
  ToolModelDefinition,
  ToolPolicy,
} from '../common-agent'
import { z } from 'zod'
import { createCurrentTimeTool, defineTool, executeTool } from '../common-agent'
import { getTime, getUserLocation, getWeather } from './func'

const timeUnits = ['day', 'week', 'month', 'year'] as const
const timePresets = [
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
] as const

/** 只读网络工具共用的自动重试策略。 */
const NETWORK_RETRY_POLICY = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 2_000,
  backoff: 'exponential' as const,
  jitterRatio: 0.2,
})

/**
 * 查询相对日期、命名日期范围或当前时间。
 *
 * Schema、模型描述和业务实现放在同一个定义中，避免旧版 tools.json 与 func.ts 漂移。
 */
export const getTimeTool = defineTool({
  name: 'get_time',
  description: '查询日期与时间。模型自身不知道真实当前时间，遇到任何日期时间问题都应调用本工具。具体日期使用 amount+unit；本周、本月、今年等范围使用 preset，两种用法互斥。回答用户时优先使用结果中的 label。',
  inputSchema: z.strictObject({
    amount: z.number()
      .int()
      .nullable()
      .describe('相对今天的偏移量；未来为正数，过去为负数，今天为 0。使用 preset 时传 null。'),
    unit: z.enum(timeUnits)
      .nullable()
      .describe('amount 的单位：day、week、month 或 year。使用 preset 时传 null。'),
    preset: z.enum(timePresets)
      .nullable()
      .describe('命名时间范围；查询具体相对日期时传 null。'),
    timezone: z.string()
      .min(1)
      .nullable()
      .describe('IANA 时区名称；未知时传 null，默认使用 Asia/Shanghai。'),
  }),
  outputSchema: z.strictObject({
    timezone: z.string(),
    current_datetime: z.string(),
    date: z.string().nullable(),
    time: z.string(),
    weekday: z.string().nullable(),
    range_start: z.string().nullable(),
    range_end: z.string().nullable(),
    label: z.string(),
  }),
  security: {
    risk: 'safe',
    capabilities: [],
    idempotent: true,
  },
  execute(input) {
    return getTime(input)
  },
})

/** 通过服务器出口 IP 查询近似位置。 */
export const getUserLocationTool = defineTool({
  name: 'get_user_location',
  description: '通过服务器出口 IP 查询用户的近似位置，适用于本地运行或服务器与用户位于同一网络区域的场景；它不是浏览器 GPS 精确定位。',
  inputSchema: z.strictObject({}),
  outputSchema: z.strictObject({
    ip: z.string(),
    country: z.string(),
    province: z.string(),
    city: z.string(),
    district: z.string().nullable(),
    latitude: z.number().finite(),
    longitude: z.number().finite(),
    timezone: z.string().nullable(),
    accuracy: z.literal('approximate_ip'),
  }),
  timeoutMs: 10_000,
  retry: NETWORK_RETRY_POLICY,
  security: {
    risk: 'read',
    capabilities: ['network:public'],
    idempotent: true,
  },
  async execute(input, context) {
    return await getUserLocation(input, context)
  },
})

/** 查询指定城市或服务器近似所在地的当前天气。 */
export const getWeatherTool = defineTool({
  name: 'get_weather',
  description: '查询当前天气。用户指定城市时传入 city；未指定时传 null，工具会在内部通过 IP 近似定位，无需先调用 get_user_location。',
  inputSchema: z.strictObject({
    city: z.string()
      .min(1)
      .nullable()
      .describe('要查询的城市；用户未指定城市时传 null。'),
  }),
  outputSchema: z.strictObject({
    city: z.string(),
    province: z.string().nullable(),
    country: z.string(),
    latitude: z.number().finite(),
    longitude: z.number().finite(),
    timezone: z.string().nullable(),
    weather: z.string(),
    weather_code: z.number().finite(),
    temperature_c: z.number().finite(),
    feels_like_c: z.number().finite(),
    humidity_percent: z.number().finite(),
    wind_direction: z.string(),
    wind_speed_kmh: z.number().finite(),
    wind_scale: z.number().finite(),
    observed_at: z.string(),
  }),
  timeoutMs: 20_000,
  retry: NETWORK_RETRY_POLICY,
  security: {
    risk: 'read',
    capabilities: ['network:public'],
    idempotent: true,
  },
  async execute(input, context) {
    return await getWeather(input, context)
  },
})

/** 异构工具放入同一服务端注册表后的统一调用外壳。 */
export interface ServerToolRegistration {
  readonly name: string
  readonly model: ToolModelDefinition
  invoke: (
    rawInput: unknown,
    options: ExecuteToolOptions,
  ) => Promise<ToolExecutionResult<unknown>>
}

/**
 * 保留具体工具的 Zod 泛型完成执行，再向异构注册表暴露统一结果类型。
 *
 * 运行时输入仍是 unknown，真正进入业务函数前始终由该工具自己的 inputSchema 校验。
 */
export function createServerToolRegistration<
  TInputSchema extends z.ZodType,
  TOutputSchema extends z.ZodType,
>(
  tool: DefinedTool<TInputSchema, TOutputSchema>,
): ServerToolRegistration {
  return Object.freeze({
    name: tool.name,
    model: tool.model,
    invoke: async (rawInput: unknown, options: ExecuteToolOptions) => {
      return await executeTool(tool, rawInput, options)
    },
  })
}

/**
 * 当前服务明确注册的第一方工具。
 *
 * 开发自定义工具时先使用 defineTool() 创建定义，再把定义加入此列表；Agent 会自动把
 * `tool.model` 发送给模型，并通过 CommonAgent Harness 执行对应实现。
 */
export const serverTools = Object.freeze([
  // createServerToolRegistration(getTimeTool),
  createServerToolRegistration(getUserLocationTool),
  createServerToolRegistration(getWeatherTool),
  createServerToolRegistration(createCurrentTimeTool()),
] as const)

/** 当前服务工具定义的联合类型。 */
export type ServerTool = typeof serverTools[number]

/** 按稳定工具名查找当前服务明确注册的工具。 */
export function findServerTool(name: string): ServerTool | undefined {
  return serverTools.find(tool => tool.name === name)
}

/**
 * 当前 Runtime 对静态注册第一方工具使用的许可策略。
 *
 * 该策略只服务当前开发验证，不代表第三方插件安全模型；工具注册来源由服务端代码控制。
 */
export const trustedServerToolPolicy: ToolPolicy = Object.freeze({
  evaluate: () => ({ decision: 'allow' as const }),
})
