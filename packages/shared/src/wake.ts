import dgram from "node:dgram";
import { wakeSchema,type WakeInput } from "../../protocol/src/power.ts";
export function magicPacket(mac:string){
  const hex=mac.replace(/[\s:.-]/g,"");
  if(!/^[0-9a-f]{12}$/i.test(hex))throw new Error("MAC must contain exactly six hexadecimal bytes, optionally separated by colon, dash or dot");
  const bytes=Buffer.from(hex,"hex");
  return Buffer.concat([Buffer.alloc(6,0xff),...Array.from({length:16},()=>bytes)]);
}
export async function sendWake(input:WakeInput,signal?:AbortSignal){
  const parsed=wakeSchema.parse(input),packet=magicPacket(parsed.mac);
  const plan={mac:parsed.mac,broadcast:parsed.broadcast,port:parsed.port,repeat:parsed.repeat,localAddress:parsed.localAddress??null,bytesPerPacket:packet.length};
  signal?.throwIfAborted();
  if(parsed.dryRun)return {sent:false,dryRun:true,wakeVerified:false,...plan};
  const socket=dgram.createSocket("udp4");let sentPackets=0,pendingReject:((e:Error)=>void)|undefined,lastError:Error|undefined;
  const fail=(e:Error)=>{lastError=e;pendingReject?.(e)};
  const abort=()=>fail(new Error("Wake-on-LAN request cancelled after "+sentPackets+" packets"));
  socket.on("error",fail);signal?.addEventListener("abort",abort,{once:true});
  const timer=(parsed.timeoutMs??10000)>0?setTimeout(()=>fail(new Error("Wake-on-LAN deadline exceeded after "+sentPackets+" packets")),parsed.timeoutMs??10000):undefined;timer?.unref();
  try{
    await new Promise<void>((resolve,reject)=>{pendingReject=reject;socket.once("listening",resolve);socket.bind({address:parsed.localAddress,port:0})});pendingReject=undefined;
    socket.setBroadcast(true);
    for(let n=0;n<parsed.repeat;n++){
      if(lastError)throw lastError;signal?.throwIfAborted();
      await new Promise<void>((resolve,reject)=>{pendingReject=reject;socket.send(packet,parsed.port,parsed.broadcast,e=>e?reject(e):resolve())});pendingReject=undefined;sentPackets++;
    }
    if(lastError)throw lastError;
    return {sent:true,wakeVerified:false,sentPackets,...plan,verification:"UDP submission succeeded; this does not prove packet delivery or that the target woke up."};
  }finally{
    if(timer)clearTimeout(timer);signal?.removeEventListener("abort",abort);
    try{socket.close()}catch{}
  }
}
