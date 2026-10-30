const { AppError } = require("../utils");

module.exports = (ctx, next) => {
  if (!ctx.state.user.isOperator)
    throw new AppError("FORBIDDEN", 403, "Operator access required");
  return next();
};
