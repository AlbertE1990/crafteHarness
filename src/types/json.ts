/** JSON 中允许直接表示的基础值。 */
export type JsonPrimitive = string | number | boolean | null

/** 可无损写入会话日志或模型协议的 JSON 值。 */
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]

/** 以字符串为键的 JSON 对象。 */
export interface JsonObject {
  [key: string]: JsonValue
}

/** CraftAgent 内部使用的 JSON Schema 对象。 */
export type JsonSchema = Record<string, unknown>

/** 递归识别可无损 JSON 序列化的普通对象，并拒绝循环引用和 symbol key。 */
export function isJsonObject(
  value: unknown,
  ancestors: WeakSet<object> = new WeakSet(),
): value is JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null)
    return false
  if (Reflect.ownKeys(value).some(key => typeof key === 'symbol') || ancestors.has(value))
    return false

  ancestors.add(value)
  const valid = Object.values(value).every(child => isJsonValue(child, ancestors))
  ancestors.delete(value)
  return valid
}

/** 复制已经校验的 JSON 对象，使框架冻结结果时不会冻结调用方的原始引用。 */
export function cloneJsonObject(value: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, cloneJsonValue(child)]),
  )
}

/** 递归识别 JSON 值，并拒绝 undefined、函数、非有限数字和循环引用。 */
function isJsonValue(value: unknown, ancestors: WeakSet<object>): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return true
  if (typeof value === 'number')
    return Number.isFinite(value)
  if (Array.isArray(value)) {
    if (ancestors.has(value))
      return false
    ancestors.add(value)
    const valid = value.every(child => isJsonValue(child, ancestors))
    ancestors.delete(value)
    return valid
  }
  return isJsonObject(value, ancestors)
}

/** 递归复制 JSON 值；只在 isJsonObject() 成功后调用。 */
function cloneJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value))
    return value.map(cloneJsonValue)
  if (typeof value === 'object' && value !== null)
    return cloneJsonObject(value)
  return value
}
