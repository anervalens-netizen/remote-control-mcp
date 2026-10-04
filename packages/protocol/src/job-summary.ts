import { z } from "zod";
const nonnegative = z.number().int().nonnegative();
export const jobSummarySchema = z.object({
  id: z.string().min(1),
  state: z.enum(["running", "cancelling", "completed", "cancelled", "lost"]),
  // Zero represents a reserved systemd admission whose MainPID is not known yet.
  pid: nonnegative.optional(),
  processIdentity: z.string().optional(), trackedProcessCount: nonnegative.optional(),
  terminationVerified: z.boolean().optional(), terminationForced: z.boolean().optional(),
  terminationVerification: z.enum(["identity_bound_job", "posix_identity_set", "partial_windows_job", "unverified_windows_fallback"]).optional(),
  terminationVerificationScope: z.enum(["whole_tree", "root_and_descendants_created_after_attach", "root_only", "unverified"]).optional(),
  terminationReason: z.string().optional(), cancellationError: z.string().optional(), recoveryReason: z.string().optional(),
  progress: z.unknown().optional(), progressInterrupted: z.boolean().optional(),
}).passthrough();
