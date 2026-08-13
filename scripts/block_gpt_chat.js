function on_before_request(ctx) {
    var model = ctx.requested_model || ctx.model || "";
    if (ctx.url !== "/v1/chat/completions" || model.indexOf("gpt-") !== 0) {
        return ctx;
    }

    return {
        terminate: true,
        status_code: 403,
        response_body: JSON.stringify({
            error: {
                message: "gpt-* models only support the Responses API. Use /v1/responses instead.",
                type: "invalid_request_error",
                code: "unsupported_endpoint"
            }
        })
    };
}
