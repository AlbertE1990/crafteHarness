import OpenAI from 'openai';
import { ChatCompletion, ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources';
import toolsSchema from './tools.json'
import agentFunctions from './func'
export class Agent {
  client: OpenAI;
  systemPromote: string;
  toolsSchema: string;
  messages: ChatCompletionMessageParam[]
  maxTurn: number;
  errorRetry: number;
  constructor() {
    this.client = new OpenAI({
      baseURL: 'https://api.deepseek.com',
      apiKey: 'sk-855ff5376188472eae111adf696374ee', // This is the default and can be omitted
    });
    this.systemPromote = "你是一个AI助手"
    this.toolsSchema = ""
    this.messages = [
      { role: 'system', content: this.systemPromote },
      // { role:'function',content:JSON.stringify(toolsSchema),name:''}
    ]
    this.maxTurn = 5
    this.errorRetry = 4
  }

  async sendMsg(msg?: string) {
    if (!msg) {
      return
    }
    this.messages.push({
      role: 'user',
      content: msg
    })
    const res = await this.reAct()
    return res
  }

  private async create() {
    const completion = await this.client.chat.completions.create({
      model: 'deepseek-v4-flash',
      messages: this.messages,
      tools: toolsSchema as ChatCompletionTool[]
    });
    return completion
  }

  async reAct() {
    let turn = 1;
    while (turn <= this.maxTurn) {
      console.log(`----------messages:${turn}----------`)
      console.log(this.messages)

      const completion = await this.create()
      console.log(`---------completion:${turn}---------`)

      console.log(JSON.stringify(completion,null,2))
      for (const choice of completion.choices) {
        const message = choice.message
        console.log('---------message-item-------')
        console.log(message)
        if (message.role === 'assistant') {
          // 关键修复：带 tool_calls 的 assistant 消息必须先入列，
          // tool 消息必须紧跟其后，否则 API 报 400
          this.messages.push({
            role: 'assistant',
            content: message.content,
            tool_calls: message.tool_calls
          });
          if (message.tool_calls) {
            for (const tool of message.tool_calls) {
              if(tool.type !== 'function' || !tool.function || !tool.function.name)
                continue
              console.log(tool)
              const func = agentFunctions[tool.function.name]
              if (!func) {
                this.messages.push({
                  role:'tool',
                  tool_call_id:tool.id,
                  content:`工具：${tool.function.name}不存在，请检查`
                })
                continue
              }
              try {
                const arg = JSON.parse(tool.function.arguments ?? '{}')
                const res = await func(arg)
                this.messages.push({
                  role: 'tool',
                  // tool 消息的 content 必须是字符串，工具返回的对象需序列化
                  content: JSON.stringify(res),
                  tool_call_id: tool.id
                })
              } catch (e:any) {
                // 函数异常重试，后面再开发
                this.messages.push({
                  role: 'tool',
                  content: e.message,
                  tool_call_id: tool.id
                })
              }
            }
            // 本轮发起了工具调用：工具结果已入列，继续下一轮让模型基于结果作答。
            // 注意模型可能同时输出 tool_calls 和过渡语（如"我来查一下"），
            // 此时不能提前 return content
          } else if (message.content) {
            // 无工具调用且带 content，才是最终回答
            return message.content
          }

        }
      }
      // await this.create()
      turn++
    }


    return '达到最大循环数'
  }
}


const d = {
  id: '35b0ff0a-2aa2-448b-9b0f-c534d6a2c26f',
  object: 'chat.completion',
  created: 1788530124,
  model: 'deepseek-v4-flash',
  choices: [
    {
      index: 0,
      message: [
        {
          role: 'assistant',
          content: '你好！我是DeepSeek，由深度求索公司创造的AI助手。很高兴认识你😊我可以帮你解答问题、处理文字、分析文档、进行创作等等。我支持上传图片、PDF、Word等文件，并从中读取文字信息进行处理。有什么我可以帮你的吗？',
          reasoning_content: '用户问好并询问身份。需要简洁友好地回应，说明自己是DeepSeek，并提及基本功能和特点，让用户了解我能提供的帮助。用一句问候结尾保持对话开放。'
        }
      ],
      logprobs: null,
      finish_reason: 'stop'
    }
  ],
  usage: {
    prompt_tokens: 90,
    completion_tokens: 86,
    total_tokens: 176,
    prompt_tokens_details: { cached_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 44 },
    prompt_cache_hit_tokens: 0,
    prompt_cache_miss_tokens: 90
  },
  system_fingerprint: 'a26a7955944dc5c60445bff77fac9c8e'
}