import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import process from 'node:process'
import { Type } from '@sinclair/typebox'
import Fastify from 'fastify'
import { Agent } from './agent'

const PORT = Number(process.env.PORT ?? 3000)

const fastify = Fastify({ logger: true })
  .withTypeProvider<TypeBoxTypeProvider>()

fastify.get('/api/hello', {
  schema: {
    querystring: Type.Object({
      name: Type.Optional(Type.String()),
    }),
    response: {
      200: Type.Object({
        hello: Type.String(),
      }),
    },
  },
}, async (request) => {
  return { hello: request.query.name ?? 'world' }
})

fastify.post('/api/agent', {
  schema: {
    body: Type.Object({
      message: Type.Optional(Type.String()),
    }),
    response: {
      200: Type.Object({
        data: Type.String(),
      }),
    },
  },
}, async (request) => {
  const msg = request.body.message
  const agent = new Agent()
  const res = await agent.sendMsg(msg)
  return { data: res }
})

async function start() {
  await fastify.listen({ port: PORT, host: '127.0.0.1' })
}

start()
