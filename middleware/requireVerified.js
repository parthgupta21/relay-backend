const { AppError } = require("../utils");

module.exports = (ctx, next) => {
  if (!ctx.state.user.emailVerifiedAt)
    throw new AppError("EMAIL_NOT_VERIFIED", 403, "Verify your email first");
  return next();
};
