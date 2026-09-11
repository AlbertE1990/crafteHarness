/** CraftAgent 的默认开发者门面和公共运行时函数。 */
export { Agent, Agent as default, DEFAULT_TOOL_APPROVAL_TIMEOUT_MS, defineAgentConfig } from './agent'
/** Agent 门面、配置和工具审批的公共类型。 */
export type {
  AgentConfigInput,
  AgentExecutionConfig,
  AgentModelInput,
  AgentObservabilityConfig,
  AgentOutputEvent,
  AgentRequest,
  AgentSessionDetail,
  AgentSessionMessage,
  AgentToolInput,
  AgentToolsCommonConfig,
  AgentToolsInput,
  DeepSeekAgentModelConfig,
  DefinedAgentConfig,
  DefinedAgentExecutionConfig,
  DefinedAgentObservabilityConfig,
  DefinedAgentToolsConfig,
  ExtendAgentToolsConfig,
  GetAgentSessionRequest,
  OpenAICompatibleAgentModelConfig,
  ReplaceAgentToolsConfig,
  ResolveToolApprovalRequest,
  ResolveToolApprovalResult,
  ToolApprovalDecision,
  ToolApprovalResolvedOutcome,
  ToolGuardDecision,
  ToolGuardDecisionMetadata,
  ToolGuardEvaluator,
  ToolGuardOutputEvent,
  ToolGuardOutputListener,
  ToolGuardRequest,
  ToolGuardToolInfo,
} from './agent'
export {
  builtinToolNames,
  createCalculatorTool,
  createCurrentTimeTool,
  createWorkspaceTools,
} from './builtins'
/** 内置工具的配置和稳定名称类型。 */
export type {
  BuiltinToolName,
  CalculatorOperation,
  Clock,
  CurrentTimeToolOptions,
  WorkspaceToolsOptions,
} from './builtins'
export { ModelError } from './contracts'
/** 供应商无关的模型、消息和 Session 持久化协议。 */
export type {
  AppendSessionEventsRequest,
  AppendSessionEventsResult,
  ListSessionsOptions,
  ModelAdapter,
  ModelAssistantMessage,
  ModelCallOptions,
  ModelChoiceDelta,
  ModelCompletion,
  ModelCompletionChoice,
  ModelCustomToolCall,
  ModelCustomToolCallDelta,
  ModelErrorCode,
  ModelErrorOptions,
  ModelFinishReason,
  ModelFunctionCallDelta,
  ModelFunctionMessage,
  ModelFunctionToolCall,
  ModelFunctionToolCallDelta,
  ModelInstructionMessage,
  ModelMessage,
  ModelMessageRole,
  ModelRequest,
  ModelStreamChoice,
  ModelStreamChunk,
  ModelTokenUsage,
  ModelToolCall,
  ModelToolCallDelta,
  ModelToolMessage,
  ModelUserMessage,
  ReadSessionEventsOptions,
  ReadSessionEventsRequest,
  SessionCatalogStore,
  SessionCreatedEventDraft,
  SessionEvent,
  SessionEventCorrelation,
  SessionEventDraft,
  SessionEventEnvelope,
  SessionEventOccurrence,
  SessionEventPage,
  SessionFailureInfo,
  SessionIdentity,
  SessionListPage,
  SessionMessageAppendedEventDraft,
  SessionSnapshot,
  SessionStore,
  SessionSummary,
  SessionTurnCancelledEventDraft,
  SessionTurnCompletedEventDraft,
  SessionTurnFailedEventDraft,
  SessionTurnStartedEventDraft,
} from './contracts'

export { AgentLoop, createAgentTool, createAgentToolMap } from './core'

/** 直接使用 AgentLoop 时所需的高级协议。 */
export type {
  AgentEvent,
  AgentEventBase,
  AgentEventListener,
  AgentLoopConfig,
  AgentLoopLimits,
  AgentLoopModelExecutionOptions,
  AgentRunCompletedResult,
  AgentRunErrorInfo,
  AgentRunFailedResult,
  AgentRunOptions,
  AgentRunRequest,
  AgentRunResult,
  AgentRunResultBase,
  AgentRunStoppedResult,
  AgentRunStopReason,
  AgentStepOutcome,
  AgentTokenUsage,
  AgentTool,
  DefinedAgentLoopModelExecutionOptions,
} from './core'

export {
  deriveModelMessages,
  loadModelMessages,
  MemorySessionStore,
  readSessionSnapshot,
  SessionStoreError,
} from './sessions'

/** Session Log 辅助实现和读取类型。 */
export type {
  MemorySessionStoreOptions,
  ReadSessionSnapshotOptions,
  SessionStoreErrorCode,
  SessionStoreErrorOptions,
  SessionStoreOperation,
} from './sessions'

export {
  defineTool,
  executeTool,
  normalizeToolError,
  ToolError,
  validationIssuesToJson,
} from './tools'

/** 工具定义、执行、策略、错误和轨迹协议。 */
export type {
  DefinedTool,
  ExecuteToolOptions,
  MaybePromise,
  ToolApprovalHandler,
  ToolApprovalOutcome,
  ToolApprovalRequest,
  ToolDefinition,
  ToolErrorInfo,
  ToolErrorOptions,
  ToolEventBase,
  ToolEventListener,
  ToolExecutionConfig,
  ToolExecutionEvent,
  ToolExecutionFailure,
  ToolExecutionResult,
  ToolExecutionSuccess,
  ToolModelDefinition,
  ToolRetryPolicy,
  ToolRunContext,
} from './tools'

/** 可安全跨网络、日志和持久层传递的 JSON 类型。 */
export type { JsonObject, JsonPrimitive, JsonSchema, JsonValue } from './types/json'
