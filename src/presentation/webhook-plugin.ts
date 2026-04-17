import { Elysia } from "elysia";
import { Effect } from "effect";
import { type WebhookPayload, PrReviewService } from "../application/services/pr-review-service";

function verifyHmac(secret: string, signature: string | null, rawBody: Uint8Array): boolean {
  if (!signature || !signature.startsWith("sha256=")) return false;

  const expected = signature.slice("sha256=".length);
  const key = new TextEncoder().encode(secret);

  const hmac = new Bun.CryptoHasher("sha256", key).update(rawBody).digest("hex");

  const a = Buffer.from(hmac, "utf8");
  const b = Buffer.from(expected, "utf8");

  if (a.length !== b.length) return false;

  const { timingSafeEqual } = require("crypto");
  return timingSafeEqual(a, b);
}

export function webhookPlugin(
  webhookSecret: string,
  runEffect: (effect: Effect.Effect<any, any, any>) => Promise<any>,
) {
  return new Elysia({ name: "webhook" }).post(
    "/webhook",
    async ({ request, set }) => {
      const rawBody = new Uint8Array(await request.clone().arrayBuffer());
      const signature = request.headers.get("X-Hub-Signature-256");

      if (!verifyHmac(webhookSecret, signature, rawBody)) {
        set.status = 401;
        return { error: "Invalid signature" };
      }

      const body = JSON.parse(new TextDecoder().decode(rawBody));

      const action = body.action as string;
      if (action !== "opened" && action !== "synchronize") {
        return { status: "ignored", action };
      }

      const deliveryId = request.headers.get("X-GitHub-Delivery") ?? crypto.randomUUID();
      const fullName = body.repository?.full_name as string;
      const [owner, repo] = fullName.split("/");

      const payload: WebhookPayload = {
        deliveryId,
        action,
        owner: owner!,
        repo: repo!,
        prNumber: body.pull_request?.number as number,
        prTitle: (body.pull_request?.title as string) ?? "",
        commitSha: body.pull_request?.head?.sha as string,
      };

      await runEffect(
        Effect.gen(function* () {
          const service = yield* PrReviewService;
          yield* service.handleWebhook(payload);
        }),
      );

      set.status = 202;
      return { status: "accepted", deliveryId };
    },
    { parse: "none" as const },
  );
}
