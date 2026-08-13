function on_after_auth_request(ctx) {
    var source = String(
        ctx.source || ctx.source_format || ctx.sourceFormat || ""
    ).toLowerCase();
    var target = String(
        ctx.target || ctx.to_format || ctx.toFormat || ""
    ).toLowerCase();

    if (!source || !target || source === target) {
        return ctx;
    }
    if (target !== "openai" && target !== "codex") {
        return ctx;
    }

    var body;

    try {
        body = JSON.parse(ctx.body);
    } catch (e) {
        return ctx;
    }

    if (!body || typeof body !== "object") {
        return ctx;
    }

    var model = (
        String(ctx.model || "") + " " + String(body.model || "")
    ).toLowerCase();

    if (model.indexOf("deepseek") === -1) {
        return ctx;
    }

    var output = [];
    var pendingReasoning = false;
    var inserted = 0;
    var schemaFixed = 0;

    // 仓库中的 openai 是 Chat，codex 是 Responses。
    if (target === "openai" && Array.isArray(body.messages)) {
        for (var i = 0; i < body.messages.length; i++) {
            var message = body.messages[i];
            if (
                message &&
                message.role === "assistant" &&
                Array.isArray(message.tool_calls) &&
                message.tool_calls.length > 0 &&
                message.reasoning_content == null
            ) {
                message.reasoning_content = " ";
                inserted++;
            }
        }
    }

    if (target === "codex" && Array.isArray(body.input)) {
        for (var i = 0; i < body.input.length; i++) {
            var item = body.input[i];

            if (!item || typeof item !== "object") {
                output.push(item);
                pendingReasoning = false;
                continue;
            }

            if (item.type === "reasoning") {
                output.push(item);
                pendingReasoning = true;
                continue;
            }

            if (item.type === "function_call" || item.type === "custom_tool_call") {
                if (!pendingReasoning) {
                    output.push({
                        type: "reasoning",
                        summary: [{ type: "summary_text", text: " " }]
                    });
                    pendingReasoning = true;
                    inserted++;
                }

                output.push(item);
                continue;
            }

            output.push(item);
            pendingReasoning = false;
        }

        if (inserted > 0) {
            body.input = output;
        }
    }

    if (Array.isArray(body.tools)) {
        for (var j = 0; j < body.tools.length; j++) {
            var tool = body.tools[j];
            var parameters = tool && (
                tool.parameters || (tool.function && tool.function.parameters)
            );

            if (
                parameters &&
                typeof parameters === "object" &&
                !Array.isArray(parameters) &&
                parameters.type == null
            ) {
                parameters.type = "object";
                schemaFixed++;
            }
        }
    }

    if (inserted > 0 || schemaFixed > 0) {
        ctx.body = JSON.stringify(body);
        console.log(
            "[deepseek-compat] reasoning=" + inserted +
            " schema=" + schemaFixed +
            " model=" + model
        );
    }

    return ctx;
}
