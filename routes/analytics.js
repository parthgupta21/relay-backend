const Router = require("@koa/router");
const { z } = require("zod");
const { Endpoint } = require("../models");
const auth = require("../middleware/auth");
const validate = require("../middleware/validate");
const { RANGES, getDeliveryAnalytics } = require("../services/analytics");

const router = new Router({ prefix: "/analytics" });
router.use(auth.withApiToken);

router.get(
  "/deliveries",
  validate({
    query: z.object({
      range: z.enum(Object.keys(RANGES)).default("24h"),
      endpointId: z.string().min(1).max(30).optional(),
    }),
  }),
  async (ctx) => {
    const { range, endpointId } = ctx.state.query;
    const endpoint =
      endpointId &&
      (await Endpoint.getOwned(ctx.state.workspace.id, endpointId));
    ctx.body = await getDeliveryAnalytics(
      ctx.state.workspace,
      range,
      endpoint?.id,
    );
  },
);

module.exports = router;
