# 学习路径

本目录面向希望理解和扩展 craft-harness 的开发者。学习文档解释设计动机、源码阅读顺序和实践方法，
不作为协议的最终定义；遇到差异时以[当前开发规范](../standards/README.md)为准。

## 推荐顺序

1. [Tool Harness：从定义工具到执行结果](./tool-harness.md)
2. [自定义工具开发实践](./custom-tool-development.md)
3. [ModelAdapter：从供应商 chunk 到 Agent](./model-adapter.md)
4. [自定义模型 Adapter 开发实践](./custom-model-adapter.md)
5. [Session Log：从可变消息数组到事实日志](./session-log.md)
6. [持久化 SessionStore：从内存调试到关系数据库](./persistent-session-store.md)
7. [Agent Loop：从用户输入到确定终态](./agent-loop.md)
8. [harness 统一入口：从配置到会话查询](./harness-facade.md)
9. [工具审批全链路：局部 Guard、全局 Guard 与用户确认](./tool-approval-flow.md)
10. [内置工作区工具：开箱使用与安全定制](./workspace-builtins.md)

每篇学习文档都应给出前置知识、学习目标、源码入口、调试方法和练习，并通过链接引用规范，避免复制
一份可能漂移的协议定义。
