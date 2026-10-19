const Router = require("@koa/router");
const { z } = require("zod");
const { Delivery } = require("../models");
const auth = require("../middleware/auth");
const validate = require("../middleware/validate");

const router = new Router();
router.use(auth);

router.get(
  "/deliveries/:id",
  validate({ params: z.object({ id: z.string().min(1).max(30) }) }),
  async (ctx) => {
    const delivery = await Delivery.getOwned(
      ctx.state.workspace.id,
      ctx.state.params.id,
    );
    ctx.body = {
      ...delivery.present(),
      eventId: delivery.event.publicId,
      attempts: delivery.attempts.map((attempt) => attempt.present()),
    };
  },
);

module.exports = router;
