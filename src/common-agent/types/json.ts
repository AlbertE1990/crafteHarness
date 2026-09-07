/** JSON 中允许直接表示的基础值。 */
export type JsonPrimitive = string | number | boolean | null

/** 可无损写入会话日志或模型协议的 JSON 值。 */
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]

/** 以字符串为键的 JSON 对象。 */
export interface JsonObject {
  [key: string]: JsonValue
}

/** CommonAgent 内部使用的 JSON Schema 对象。 */
export type JsonSchema = Record<string, unknown>
