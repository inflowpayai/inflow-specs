import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const transactionId = "22222222-2222-4222-8222-222222222222";
const nextAction = {
  type: "authenticate_card",
  url: `https://dashboard.example/transactions/${transactionId}/verify/`,
};
const cases = [];
for (const protocol of ["mpp", "x402"]) {
  const add = (name, options, responses, expect) => {
    const input = { api_key: "test-only-buyer-key", transaction_id: transactionId, ...options };
    if (input.access_token) delete input.api_key;
    const headers = input.access_token
      ? { authorization: `Bearer ${input.access_token}` }
      : { "x-api-key": input.api_key };
    const exchanges = responses.map((response) => ({
      request: {
        method: "GET",
        path: `/v1/transactions/${encodeURIComponent(input.transaction_id)}`,
        headers,
      },
      response,
    }));
    if (protocol === "x402")
      exchanges.unshift({
        request: { method: "GET", path: "/v1/transactions/x402-supported", headers },
        response: { status: 200, json: { kinds: [] } },
      });
    cases.push(
      structuredClone({
        id: `${protocol}.buyer.payment-status-${name}`,
        suite: `${protocol}-buyer`,
        operation: `${protocol}.buyer.payment-status`,
        input,
        expect,
        platform: { exchanges },
      }),
    );
  };
  const snapshot = (status, action) => ({
    transactionId,
    status,
    ...(action ? { nextAction: action } : {}),
  });
  const success = (json) => ({ status: 200, json });
  for (const status of ["INITIATED", "PENDING", "PROCESSING", "SETTLED", "GENERAL_ERROR"]) {
    const value = snapshot(status);
    add(status.toLowerCase(), {}, [success(value)], { result: [value] });
  }
  const pending = snapshot("PENDING", nextAction);
  const settled = snapshot("SETTLED");
  add("authenticate-card", {}, [success(pending)], { result: [pending] });
  add("recheck-original-payment", { reads: 2 }, [success(pending), success(settled)], {
    result: [pending, settled],
  });
  const processing = snapshot("PROCESSING");
  add("bearer", { access_token: "test-only-buyer-token" }, [success(processing)], {
    result: [processing],
  });
  add("encoded-identifier", { transaction_id: "a/b?q=x#fragment" }, [success(processing)], {
    result: [processing],
  });
  for (const status of [401, 403, 404, 503]) {
    const body = { code: "STATUS_UNAVAILABLE", message: "Synthetic payment status failure." };
    add(`http-${status}`, {}, [{ status, json: body }], {
      error: {
        code: "api-error",
        message: "InFlow API request failed.",
        http_status: status,
        details: { body },
      },
    });
  }
  add("explicit-read-retry", { retries: 1 }, [{ status: 503, json: {} }, success(processing)], {
    result: [processing],
  });
  add(
    "redirect",
    {},
    [{ status: 307, headers: { location: "http://127.0.0.1:1/forbidden-target" }, json: {} }],
    {
      error: {
        code: "api-error",
        message: "InFlow API request failed.",
        http_status: 307,
        details: { body: {} },
      },
    },
  );
}

export const paymentStatusCases = { cases };
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.stdout.write(JSON.stringify(paymentStatusCases, null, 2) + "\n");
