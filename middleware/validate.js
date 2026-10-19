const { AppError } = require("../utils");

module.exports = (schemas) => async (ctx, next) => {
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
