import { z } from 'zod'
import { defineTool } from '../define-tool'
import { ToolError } from '../errors'

const calculatorOperations = [
  'add',
  'subtract',
  'multiply',
  'divide',
  'power',
  'modulo',
  'sqrt',
  'absolute',
  'round',
] as const

/** 计算器支持的确定性运算。 */
export type CalculatorOperation = typeof calculatorOperations[number]

/**
 * 创建不使用 eval 的结构化计算器工具。
 *
 * 模型必须显式给出运算名称和数值数组，避免任意表达式执行与代码注入风险。
 */
export function createCalculatorTool() {
  return defineTool({
    name: 'calculator',
    description: '执行加、减、乘、除、乘方、取模、平方根、绝对值和舍入等确定性数学运算。',
    inputSchema: z.strictObject({
      operation: z.enum(calculatorOperations)
        .describe('运算类型：add、subtract、multiply、divide、power、modulo、sqrt、absolute 或 round。'),
      values: z.array(z.number().finite())
        .min(1)
        .max(100)
        .describe('运算数。减、除、乘方和取模需要两个值；平方根、绝对值和舍入需要一个值。'),
      precision: z.number()
        .int()
        .min(0)
        .max(15)
        .optional()
        .describe('仅 round 使用的小数位数，默认 0。'),
    }),
    outputSchema: z.strictObject({
      operation: z.enum(calculatorOperations),
      values: z.array(z.number()),
      result: z.number(),
    }),
    execute(input) {
      const result = calculate(input.operation, input.values, input.precision)
      if (!Number.isFinite(result)) {
        throw new ToolError({
          code: 'NON_FINITE_RESULT',
          message: '计算结果不是有限数字',
        })
      }

      return {
        operation: input.operation,
        values: input.values,
        result,
      }
    },
  })
}

/** 根据运算类型检查参数数量并执行确定性计算。 */
function calculate(
  operation: CalculatorOperation,
  values: number[],
  precision?: number,
): number {
  if (operation === 'add')
    return values.reduce((sum, value) => sum + value, 0)
  if (operation === 'multiply')
    return values.reduce((product, value) => product * value, 1)

  if (operation === 'sqrt') {
    requireCount(operation, values, 1)
    if (values[0] < 0)
      throw invalidCalculation('平方根的输入不能是负数')
    return Math.sqrt(values[0])
  }

  if (operation === 'absolute') {
    requireCount(operation, values, 1)
    return Math.abs(values[0])
  }

  if (operation === 'round') {
    requireCount(operation, values, 1)
    const digits = precision ?? 0
    const factor = 10 ** digits
    return Math.round((values[0] + Number.EPSILON) * factor) / factor
  }

  requireCount(operation, values, 2)
  const [left, right] = values
  if ((operation === 'divide' || operation === 'modulo') && right === 0)
    throw invalidCalculation('除数不能为 0')

  if (operation === 'subtract')
    return left - right
  if (operation === 'divide')
    return left / right
  if (operation === 'power')
    return left ** right
  return left % right
}

/** 对具有固定元数的运算提供一致的参数错误。 */
function requireCount(
  operation: CalculatorOperation,
  values: number[],
  expected: number,
): void {
  if (values.length !== expected) {
    throw invalidCalculation(
      `${operation} 需要 ${expected} 个运算数，实际收到 ${values.length} 个`,
    )
  }
}

/** 构造不可重试的计算参数错误。 */
function invalidCalculation(message: string): ToolError {
  return new ToolError({
    code: 'INVALID_CALCULATION',
    message,
  })
}
