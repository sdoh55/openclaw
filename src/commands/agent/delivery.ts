import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { AgentCommandOpts } from "./types.js";
import { AGENT_LANE_NESTED } from "../../agents/lanes.js";
import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import { createOutboundSendDeps, type CliDeps } from "../../cli/outbound-send-deps.js";
import {
  resolveAgentDeliveryPlan,
  resolveAgentOutboundTarget,
} from "../../infra/outbound/agent-delivery.js";
import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import { buildOutboundResultEnvelope } from "../../infra/outbound/envelope.js";
import {
  formatOutboundPayloadLog,
  type NormalizedOutboundPayload,
  normalizeOutboundPayloads,
  normalizeOutboundPayloadsForJson,
} from "../../infra/outbound/payloads.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";

type RunResult = Awaited<
  ReturnType<(typeof import("../../agents/pi-embedded.js"))["runEmbeddedPiAgent"]>
>;

const NESTED_LOG_PREFIX = "[agent:nested]";

function formatNestedLogPrefix(opts: AgentCommandOpts): string {
  const parts = [NESTED_LOG_PREFIX];
  const session = opts.sessionKey ?? opts.sessionId;
  if (session) {
    parts.push(`session=${session}`);
  }
  if (opts.runId) {
    parts.push(`run=${opts.runId}`);
  }
  const channel = opts.messageChannel ?? opts.channel;
  if (channel) {
    parts.push(`channel=${channel}`);
  }
  if (opts.to) {
    parts.push(`to=${opts.to}`);
  }
  if (opts.accountId) {
    parts.push(`account=${opts.accountId}`);
  }
  return parts.join(" ");
}

function logNestedOutput(runtime: RuntimeEnv, opts: AgentCommandOpts, output: string) {
  const prefix = formatNestedLogPrefix(opts);
  for (const line of output.split(/\r?\n/)) {
    if (!line) {
      continue;
    }
    runtime.log(`${prefix} ${line}`);
  }
}

export async function deliverAgentCommandResult(params: {
  cfg: OpenClawConfig;
  deps: CliDeps;
  runtime: RuntimeEnv;
  opts: AgentCommandOpts;
  sessionEntry: SessionEntry | undefined;
  result: RunResult;
  payloads: RunResult["payloads"];
}) {
  const { cfg, deps, runtime, opts, sessionEntry, payloads, result } = params;
  const deliver = opts.deliver === true;
  const bestEffortDeliver = opts.bestEffortDeliver === true;
  const deliveryPlan = resolveAgentDeliveryPlan({
    sessionEntry,
    requestedChannel: opts.replyChannel ?? opts.channel,
    explicitTo: opts.replyTo ?? opts.to,
    explicitThreadId: opts.threadId,
    accountId: opts.replyAccountId ?? opts.accountId,
    wantsDelivery: deliver,
  });
  const deliveryChannel = deliveryPlan.resolvedChannel;
  console.warn(
    `[delivery-enter] deliver=${deliver}, payloadsLen=${payloads?.length ?? 0}, channel=${deliveryPlan.resolvedChannel}, target=${deliveryPlan.resolvedTo ?? "N/A"}`,
  );
  // Channel docking: delivery channels are resolved via plugin registry.
  const deliveryPlugin = !isInternalMessageChannel(deliveryChannel)
    ? getChannelPlugin(normalizeChannelId(deliveryChannel) ?? deliveryChannel)
    : undefined;

  const isDeliveryChannelKnown =
    isInternalMessageChannel(deliveryChannel) || Boolean(deliveryPlugin);

  const targetMode =
    opts.deliveryTargetMode ??
    deliveryPlan.deliveryTargetMode ??
    (opts.to ? "explicit" : "implicit");
  const resolvedAccountId = deliveryPlan.resolvedAccountId;
  const resolved =
    deliver && isDeliveryChannelKnown && deliveryChannel
      ? resolveAgentOutboundTarget({
          cfg,
          plan: deliveryPlan,
          targetMode,
          validateExplicitTarget: true,
        })
      : {
          resolvedTarget: null,
          resolvedTo: deliveryPlan.resolvedTo,
          targetMode,
        };
  const resolvedTarget = resolved.resolvedTarget;
  const deliveryTarget = resolved.resolvedTo;
  const resolvedThreadId = deliveryPlan.resolvedThreadId ?? opts.threadId;
  const resolvedReplyToId =
    deliveryChannel === "slack" && resolvedThreadId != null ? String(resolvedThreadId) : undefined;
  const resolvedThreadTarget = deliveryChannel === "slack" ? undefined : resolvedThreadId;

  const logDeliveryError = (err: unknown) => {
    const message = `Delivery failed (${deliveryChannel}${deliveryTarget ? ` to ${deliveryTarget}` : ""}): ${String(err)}`;
    runtime.error?.(message);
    if (!runtime.error) {
      runtime.log(message);
    }
  };

  if (deliver) {
    if (!isDeliveryChannelKnown) {
      const err = new Error(`Unknown channel: ${deliveryChannel}`);
      if (!bestEffortDeliver) {
        throw err;
      }
      logDeliveryError(err);
    } else if (resolvedTarget && !resolvedTarget.ok) {
      if (!bestEffortDeliver) {
        throw resolvedTarget.error;
      }
      logDeliveryError(resolvedTarget.error);
    }
  }

  const normalizedPayloads = normalizeOutboundPayloadsForJson(payloads ?? []);
  if (opts.json) {
    runtime.log(
      JSON.stringify(
        buildOutboundResultEnvelope({
          payloads: normalizedPayloads,
          meta: result.meta,
        }),
        null,
        2,
      ),
    );
    if (!deliver) {
      return { payloads: normalizedPayloads, meta: result.meta };
    }
  }

  if (!payloads || payloads.length === 0) {
    console.warn(`[delivery-empty] No reply from agent - returning empty payloads`);
    runtime.log("No reply from agent.");
    return { payloads: [], meta: result.meta };
  }

  const deliveryPayloads = normalizeOutboundPayloads(payloads);
  console.warn(`[delivery-proceed] Proceeding with ${deliveryPayloads.length} delivery payloads`);
  const logPayload = (payload: NormalizedOutboundPayload) => {
    if (opts.json) {
      return;
    }
    const output = formatOutboundPayloadLog(payload);
    if (!output) {
      return;
    }
    if (opts.lane === AGENT_LANE_NESTED) {
      logNestedOutput(runtime, opts, output);
      return;
    }
    runtime.log(output);
  };
  if (!deliver) {
    for (const payload of deliveryPayloads) {
      logPayload(payload);
    }
  }
  if (deliver && deliveryChannel && !isInternalMessageChannel(deliveryChannel)) {
    console.warn(
      `[delivery-outbound] Preparing outbound delivery: channel=${deliveryChannel}, target=${deliveryTarget ?? "N/A"}`,
    );
    if (deliveryTarget) {
      try {
        await deliverOutboundPayloads({
          cfg,
          channel: deliveryChannel,
          to: deliveryTarget,
          accountId: resolvedAccountId,
          payloads: deliveryPayloads,
          replyToId: resolvedReplyToId ?? null,
          threadId: resolvedThreadTarget ?? null,
          bestEffort: bestEffortDeliver,
          onError: (err) => logDeliveryError(err),
          onPayload: logPayload,
          deps: createOutboundSendDeps(deps),
        });
        console.warn(`[delivery-outbound-success] Outbound delivery completed`);
      } catch (outboundErr) {
        console.error(`[delivery-outbound-error] Outbound delivery threw: ${outboundErr}`);
        throw outboundErr;
      }
    }
  }

  console.warn(`[delivery-exit] Returning: payloadCount=${normalizedPayloads.length}`);
  return { payloads: normalizedPayloads, meta: result.meta };
}
