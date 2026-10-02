import { isDeepStrictEqual } from "node:util";

function omitEmptyExtra(requirement) {
  if (
    requirement?.extra !== null &&
    typeof requirement?.extra === "object" &&
    !Array.isArray(requirement.extra) &&
    Object.keys(requirement.extra).length === 0
  )
    delete requirement.extra;
}

export function matchesRequest(method, path, actual, expected) {
  const left = structuredClone(actual);
  const right = structuredClone(expected);
  if (method === "POST" && path === "/v1/transactions/x402") {
    omitEmptyExtra(left?.accept);
    omitEmptyExtra(right?.accept);
  }
  return isDeepStrictEqual(left, right);
}

export function matchesOutcome(operation, actual, expected) {
  const left = structuredClone(actual);
  const right = structuredClone(expected);
  if (operation === "x402.seller.route") {
    for (const value of [left, right]) {
      const extension = value?.result?.extensions?.eip2612GasSponsoring;
      for (const annotation of [
        extension?.info,
        extension?.schema?.properties?.amount,
        extension?.schema?.properties?.nonce,
      ]) {
        if (typeof annotation?.description === "string") annotation.description = "";
      }
    }
  }
  if (["x402.buyer.sign", "x402.buyer.concurrent-await"].includes(operation)) {
    omitEmptyExtra(left?.result?.paymentPayload?.accepted);
    omitEmptyExtra(right?.result?.paymentPayload?.accepted);
  }
  if (operation === "x402.seller.settle") {
    for (const value of [left?.result, right?.result]) {
      if (value?.success === false && value.network === "") delete value.network;
    }
  }
  return isDeepStrictEqual(left, right);
}
