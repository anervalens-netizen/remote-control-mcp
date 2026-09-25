import type { FastifyInstance } from "fastify";
import { BrowserManager } from "./browser.ts";
import { browserSessionSchema, browserActionSchema, browserExecutionSchema } from "../../../packages/protocol/src/browser.ts";
export function registerBrowserRoutes(app:FastifyInstance,manager=new BrowserManager()){
  app.addHook("onClose",async()=>manager.close());
  for(const [route,schema,handler]of [
    ["executions",browserExecutionSchema,(input:any,_signal:AbortSignal)=>manager.executions(input)],
    ["session",browserSessionSchema,(input:any,signal:AbortSignal)=>manager.session(input,signal)],
    ["actions",browserActionSchema,(input:any,signal:AbortSignal)=>manager.actions(input,signal)],
  ]as const){
    app.post("/v1/browser/"+route,async(request,reply)=>{
      const parsed=schema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.issues});
      const controller=new AbortController(),abort=()=>{if(!reply.raw.writableEnded)controller.abort(new Error("Browser caller disconnected"))};
      reply.raw.once("close",abort);request.raw.once("aborted",abort);
      if(request.raw.aborted||reply.raw.destroyed)abort();
      try{return await handler(parsed.data,controller.signal)}
      finally{reply.raw.off("close",abort);request.raw.off("aborted",abort)}
    });
  }
}
