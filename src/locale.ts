/** Craft Harness 内置诊断支持的语言。 */
export const SUPPORTED_LOCALES = ['zh-CN', 'en-US'] as const

/** 只控制 Harness 自身产生的人类可读诊断，不改变模型提示词或第三方错误。 */
export type HarnessLocale = typeof SUPPORTED_LOCALES[number]

/** 为兼容现有项目，未配置时继续使用简体中文。 */
export const DEFAULT_LOCALE: HarnessLocale = 'zh-CN'

/** 校验公共配置中的 locale，并返回可直接传入调用链的稳定值。 */
export function resolveLocale(value: unknown): HarnessLocale {
  if (value === undefined)
    return DEFAULT_LOCALE
  if (value === 'zh-CN' || value === 'en-US')
    return value

  throw new TypeError(
    `不支持的 locale：${String(value)}；可选值为 zh-CN、en-US / Unsupported locale: ${String(value)}; expected zh-CN or en-US`,
  )
}

/** 从双语诊断中选择当前语言；仅供 Harness 内部错误边界使用。 */
export function diagnostic(
  locale: HarnessLocale,
  zhCN: string,
  enUS: string,
): string {
  return locale === 'en-US' ? enUS : zhCN
}
