/**
 * The hub that frames the studio (hub-frame-spike.md §3, §4.8; hub-frame-rollout.md §1.1, §1.7):
 * hub.just-be.dev serves it under `/automations[@<stage>]/`, proxies its requests with hub prod's
 * Access service token (`PlatformToken`), and names the person in `x-hub-identity`, signed with hub
 * prod's `IdentityKey`. The studio reads the token's ids and the public key from hub prod's Alchemy
 * state by typed ref, at plan time. Every stage trusts hub prod, so a hub preview never vouches for
 * anyone here. Only the stack imports this module (through stack.ts and api.ts), and only on
 * deployed stages: `alchemy dev` declares no hub refs.
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";

/** The hub's Alchemy stack name. */
export const HUB_STACK = "hub";

/** The hub's registry id for this app: its path segment on the hub and its tokens' audience. */
export const HUB_APP_ID = "automations";

/** The hub stage a stage of the studio trusts: hub prod, for every stage. */
export const trustedHubStage = (_stage: string) => "prod";

/** Hub prod's Access service token. */
export const hubToken = (stage: string) =>
  Cloudflare.Access.ServiceToken.ref("PlatformToken", {
    stack: HUB_STACK,
    stage: trustedHubStage(stage),
  });

/** Hub prod's identity signing key; the studio reads only its public key. */
export const hubKey = (stage: string) =>
  Alchemy.KeyPair.ref("IdentityKey", { stack: HUB_STACK, stage: trustedHubStage(stage) });

/** The audience the hub's identity tokens name for this stage. */
export const hubAudience = (stage: string) => `${HUB_APP_ID}@${stage}`;

/** Where this stage lives on the hub: `/automations` on prod, `/automations@<stage>` on a preview. */
export const hubFramePrefix = (stage: string) =>
  stage === "prod" ? `/${HUB_APP_ID}` : `/${HUB_APP_ID}@${stage}`;
