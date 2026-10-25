const Router = require("@koa/router");
const auth = require("../middleware/auth");
const { getUsage } = require("../services/usage");

const router = new Router({ prefix: "/usage" });
router.use(auth.withApiToken);

router.get("/", async (ctx) => {
  ctx.body = await getUsage(ctx.state.workspace);
});

module.exports = router;
