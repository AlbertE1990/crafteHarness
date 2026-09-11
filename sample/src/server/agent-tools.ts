import type {
  ToolGuardDecision,
  ToolGuardEvaluator,
  ToolGuardRequest,
} from '../../../src'
import { z } from 'zod'
import { defineTool, ToolError } from '../../../src'
import { getUserLocation, getWeather } from './func'

/** 审批演示工具可操作的进程内资源；不会触碰文件、数据库或操作系统。 */
const runtimeResources = new Map<string, string>()

/** 参数本身决定本次调用是只读、写入还是删除。 */
const runtimeResourceInputSchema = z.strictObject({
  operation: z.enum(['read', 'write', 'delete']).describe('read 自动允许；write 需要审批；delete 需要审批，protected/ 前缀会自动拒绝。'),
  resource: z.string().min(1).max(120).describe('进程内资源名称，例如 demo/greeting 或 protected/system。'),
  content: z.string().min(1).max(2_000).nullable().describe('write 时填写内容；read/delete 时传 null。'),
})

/** 只读网络工具共用的自动重试策略。 */
const NETWORK_RETRY_POLICY = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 2_000,
  backoff: 'exponential' as const,
  jitterRatio: 0.2,
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
  execution: {
    timeoutMs: 10_000,
    retry: NETWORK_RETRY_POLICY,
  },
  metadata: {
    risk: 'read',
    capabilities: ['network:public'],
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
  execution: {
    timeoutMs: 20_000,
    retry: NETWORK_RETRY_POLICY,
  },
  metadata: {
    risk: 'read',
    capabilities: ['network:public'],
  },
  async execute(input, context) {
    return await getWeather(input, context)
  },
})

/**
 * 一个真实产生进程内副作用、但影响范围受控的审批演示工具。
 *
 * metadata 只为观察和全局策略提供业务标签；工具自己的 guard 依据 operation/resource
 * 对单次调用作 allow、ask 或 deny 决定，从而覆盖审批链路的三种分支。
 */
export const manageRuntimeResourceTool = defineTool({
  name: 'manage_runtime_resource',
  description: '管理服务进程内的演示资源。read 用于读取；write 会修改内容；delete 会删除内容。仅在用户明确要求操作演示资源时调用。',
  inputSchema: runtimeResourceInputSchema,
  outputSchema: z.strictObject({
    operation: z.enum(['read', 'write', 'delete']),
    resource: z.string(),
    existed: z.boolean(),
    value: z.string().nullable(),
  }),
  metadata: {
    risk: 'destructive',
    capabilities: ['runtime-resource:manage'],
  },
  // 工具级 Guard 只负责该工具固有、且依赖实际参数的规则。
  guard: request => evaluateRuntimeResourcePolicy(request.input),
  execute(input) {
    // 能进入此函数，说明 Harness 已经得到 allow 或本 callId 的 allowed-once。
    const previous = runtimeResources.get(input.resource)
    if (input.operation === 'read') {
      return {
        operation: input.operation,
        resource: input.resource,
        existed: previous !== undefined,
        value: previous ?? null,
      }
    }

    if (input.operation === 'write') {
      if (input.content === null) {
        throw new ToolError({
          code: 'CONTENT_REQUIRED',
          message: 'write 操作必须提供 content',
        })
      }
      // 这是实际副作用点；审批逻辑不能写在这里，否则无法在执行前统一观察和拒绝。
      runtimeResources.set(input.resource, input.content)
      return {
        operation: input.operation,
        resource: input.resource,
        existed: previous !== undefined,
        value: input.content,
      }
    }

    // protected/* 会在工具级 Guard 中提前 deny，因此正常运行时无法到达这条删除语句。
    runtimeResources.delete(input.resource)
    return {
      operation: input.operation,
      resource: input.resource,
      existed: previous !== undefined,
      value: previous ?? null,
    }
  },
})

/**
 * 当前服务明确注册的第一方工具。
 *
 * 开发自定义工具时先使用 defineTool() 创建定义，再把定义加入此列表；Agent 配置会自动完成
 * AgentTool 转换，AgentLoop 最终仍通过 CraftAgent Harness 执行对应实现。
 */
export const serverTools = [
  getUserLocationTool,
  getWeatherTool,
  manageRuntimeResourceTool,
] as const

/**
 * 当前 Runtime 对静态注册第一方工具使用的风险评估配置。
 *
 * 该策略只服务当前开发验证，不代表第三方插件安全模型；工具注册来源由服务端代码控制。
 */
export const serverToolGuard: ToolGuardEvaluator = (
  request: ToolGuardRequest,
): ToolGuardDecision => {
  // 全局 Guard 只表达当前部署允许注册哪些工具；参数级风险留给工具自己的 Guard。
  if (request.tool.name === 'calculator'
    || request.tool.name === 'get_current_time'
    || request.tool.name === manageRuntimeResourceTool.name
    || request.tool.name === getUserLocationTool.name
    || request.tool.name === getWeatherTool.name) {
    return { decision: 'allow' }
  }

  return {
    decision: 'deny',
    reason: `服务端策略未授权工具 ${request.tool.name}`,
  }
}

/** 根据已经通过 Harness 校验的业务参数，决定单次资源操作的实际权限。 */
function evaluateRuntimeResourcePolicy(input: unknown): ToolGuardDecision {
  // Harness 已校验过一次；这里再次 parse 是为了在独立调用本评估函数时仍保持边界安全。
  const parsed = runtimeResourceInputSchema.safeParse(input)
  if (!parsed.success) {
    return {
      decision: 'deny' as const,
      reason: '资源操作参数无法通过服务端策略校验',
    }
  }

  if (parsed.data.operation === 'read')
    return { decision: 'allow' as const }

  // 不允许人工审批绕过不可删除规则，所以 protected/* 使用 deny 而不是 ask。
  if (parsed.data.operation === 'delete' && parsed.data.resource.startsWith('protected/')) {
    return {
      decision: 'deny' as const,
      reason: `受保护资源 ${parsed.data.resource} 禁止删除`,
    }
  }

  // 普通写入和删除都需要用户针对当前 callId 作出一次性决定。
  return {
    decision: 'ask' as const,
    reason: parsed.data.operation === 'write'
      ? `工具将写入进程内资源 ${parsed.data.resource}`
      : `工具将删除进程内资源 ${parsed.data.resource}`,
    title: parsed.data.operation === 'write' ? '确认写入资源' : '确认删除资源',
    details: {
      operation: parsed.data.operation,
      resource: parsed.data.resource,
    },
    // 单次评估返回值优先于 serverToolGuard 的 120 秒通用配置。
    approvalTimeoutMs: 45_000,
  }
}
