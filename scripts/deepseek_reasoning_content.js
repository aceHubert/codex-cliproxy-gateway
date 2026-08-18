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

    var schemaFixed = 0;

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

    if (schemaFixed > 0) {
        ctx.body = JSON.stringify(body);
        console.log(
            "[deepseek-compat] schema=" + schemaFixed +
            " model=" + model
        );
    }

    return ctx;
}
