const { z } = require("zod");
const { AppError } = require("../utils");

const validate = (schemas) => (ctx, next) => {
  const input = {
    params: ctx.params,
    query: ctx.query,
    body: ctx.request.body,
  };
  const issues = [];
  for (const [key, schema] of Object.entries(schemas)) {
    const result = schema.safeParse(input[key]);
    if (result.success) ctx.state[key] = result.data;
    else
      issues.push(
        ...result.error.issues.map(({ path, message }) => ({
          path: [key, ...path].join("."),
          message,
        })),
      );
  }
  if (issues.length)
    throw new AppError("VALIDATION_FAILED", 422, "Validation failed", issues);
  return next();
};

validate.idParams = z.object({ id: z.string().min(1).max(30) });

module.exports = validate;
