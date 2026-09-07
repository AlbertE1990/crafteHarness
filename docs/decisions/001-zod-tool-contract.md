# ADR-001：采用 Zod 作为工具 Schema 单一来源

- 状态：Accepted
- 日期：2026-09-07

## 背景

模型工具参数来自不可信 JSON，TypeScript 编译期类型无法提供运行时保护。项目同时需要 TypeScript 类型推导、运行时输入/输出校验，以及可交给不同模型 adapter 的 JSON Schema。

原实现将工具 Schema 放在 `tools.json`，执行函数放在 `func.ts`，两份定义可能独立变化。项目明确不继续依赖 TypeBox，也不希望为常见校验问题维护大量自研代码。

## 决定

- 使用 Zod 4 作为工具输入和成功输出的唯一 Schema 来源。
- 使用 `defineTool()` 将 Schema、描述、实现、策略和安全元数据放在同一对象中。
- 在注册阶段通过 `z.toJSONSchema()` 生成 Draft 7 JSON Schema。
- 输入根节点必须是 `z.strictObject()`，未知字段必须拒绝。
- 成功输出必须通过 `outputSchema`；工具失败使用独立结果类型。
- CommonAgent 可以依赖 Zod，但不得依赖 OpenAI SDK。

## 备选方案

### 自研 Schema DSL 与校验器

可完全掌控协议，但需要长期维护类型推导、嵌套校验、错误路径和 JSON Schema 转换，当前阶段成本过高。

### Ajv 与手写 JSON Schema

运行时校验成熟，但 TypeScript 类型和 Schema 仍可能成为两份来源；要改善推导通常还需增加其他库。

### 继续使用 TypeBox

JSON Schema 优先且性能良好，但不符合项目当前技术选择。

### Standard Schema 抽象

有利于支持多个校验库，但 JSON Schema 转换能力并非所有 Standard Schema 实现都具备。第一阶段会增加抽象和测试面，暂不采用。

## 后果

正面影响：

- 工具协议只维护一份。
- `execute()` 输入和返回值可以自动推导。
- 工具调用前后都有运行时边界。
- 不需要维护自研验证器。

限制：

- 工具 Schema 必须限制在可表示为 JSON Schema 的 Zod 子集。
- 各模型供应商支持的 JSON Schema 子集仍可能不同，最终兼容转换属于 ModelAdapter。
- 如果未来确实需要替换 Zod，应先增加内部 Schema adapter，而不是让多个验证库直接进入 Tool Harness。
