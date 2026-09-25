import { z } from "zod";
export const powerSchema=z.object({
  action:z.enum(["reboot","shutdown","sleep","hibernate","lock"]),
  delaySeconds:z.number().int().nonnegative().max(2_147_483_647).optional(),
  force:z.boolean().optional(),dryRun:z.boolean().optional(),
});
export const wakeSchema=z.object({
  mac:z.string().min(1),broadcast:z.string().default("255.255.255.255"),
  port:z.number().int().min(1).max(65535).default(9),
  repeat:z.number().int().positive().default(3),localAddress:z.string().optional(),
  timeoutMs:z.number().int().nonnegative().optional(),dryRun:z.boolean().optional(),
});
export type PowerInput=z.infer<typeof powerSchema>;
export type WakeInput=z.infer<typeof wakeSchema>;
