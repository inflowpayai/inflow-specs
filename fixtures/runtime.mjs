export const approvalId = "11111111-1111-4111-8111-111111111111";
export const approvalPath = `/v1/approvals/${approvalId}`;

const approval = (status) => ({
  requestId: approvalId,
  requesterId: "22222222-2222-4222-8222-222222222222",
  userId: "33333333-3333-4333-8333-333333333333",
  status,
  type: "PAYMENT",
  visaTap: false,
});
const error = (code, message, parameter) => ({
  errors: [{ code, message, ...(parameter ? { parameter } : {}) }],
  id: "44444444-4444-4444-8444-444444444444",
});
const keyHeaders = { "x-api-key": "test-only-buyer-key" };
const getApproval = (status, headers = keyHeaders) => ({
  request: { method: "GET", path: approvalPath, headers },
  response: { status: 200, json: approval(status) },
});
const unauthorized = (headers) => ({
  exchanges: [
    {
      request: { method: "GET", path: approvalPath, headers },
      response: {
        status: 401,
        headers: {
          "www-authenticate": 'Bearer resource_metadata="/.well-known/oauth-protected-resource"',
        },
      },
    },
  ],
});
const missingApproval = {
  status: 404,
  json: error("APPROVAL_NOT_FOUND", "The specified approval is not found.", "approvalId"),
};

export const runtimeScenarios = {
  "auth.missing": unauthorized({}),
  "auth.invalid-key": unauthorized({ "x-api-key": "test-only-invalid-key" }),
  "auth.expired-bearer": unauthorized({ authorization: "Bearer test-only-expired-token" }),
  "approval.pending-to-approved": {
    exchanges: [getApproval("PENDING"), getApproval("PENDING"), getApproval("APPROVED")],
  },
  "approval.cancel": {
    exchanges: [
      getApproval("PENDING"),
      {
        request: { method: "POST", path: `${approvalPath}/cancel`, headers: keyHeaders },
        response: { status: 204 },
      },
      {
        request: { method: "GET", path: approvalPath, headers: keyHeaders },
        response: missingApproval,
      },
      {
        request: { method: "POST", path: `${approvalPath}/cancel`, headers: keyHeaders },
        response: missingApproval,
      },
    ],
  },
  "approval.not-owned": {
    exchanges: [
      {
        request: {
          method: "POST",
          path: `${approvalPath}/cancel`,
          headers: { "x-api-key": "test-only-other-owner-key" },
        },
        response: missingApproval,
      },
    ],
  },
  "approval.cancel-unavailable": {
    exchanges: [
      getApproval("PENDING"),
      {
        request: { method: "POST", path: `${approvalPath}/cancel`, headers: keyHeaders },
        response: { status: 500 },
      },
    ],
  },
};
for (const [role, description] of Object.entries({
  buyer: "a Buyer",
  developer: "a Developer",
  seller: "a Seller",
  agent: "an Agent",
})) {
  for (const [kind, headers] of Object.entries({
    key: { "x-api-key": `test-only-${role}-key` },
    bearer: { authorization: `Bearer test-only-${role}-token` },
  })) {
    runtimeScenarios[`auth.${role}-${kind}`] = { exchanges: [getApproval("PENDING", headers)] };
    if (role !== "seller") {
      runtimeScenarios[`auth.seller-required-${role}-${kind}`] = {
        exchanges: [
          {
            request: { method: "GET", path: "/v1/mpp/config", headers },
            response: {
              status: 403,
              json: error(
                "SELLER_ACCOUNT_REQUIRED",
                `The supplied credentials belong to ${description} account. This endpoint requires a Seller account.`,
              ),
            },
          },
        ],
      };
    }
  }
}
runtimeScenarios["approval.pending-to-declined"] = {
  exchanges: [getApproval("PENDING"), getApproval("DECLINED")],
};
runtimeScenarios["approval.pending-to-unavailable"] = {
  exchanges: [
    getApproval("PENDING"),
    {
      request: { method: "GET", path: approvalPath, headers: keyHeaders },
      response: missingApproval,
    },
  ],
};
