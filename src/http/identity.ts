import * as Context from "effect/Context";

/** The authenticated person answering a request, when the host knows who they are. */
export class RequestIdentity extends Context.Service<
  RequestIdentity,
  { readonly email: string | undefined }
>()("automations/RequestIdentity") {}
