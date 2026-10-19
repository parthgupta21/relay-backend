const Router = require("@koa/router");
const { z } = require("zod");
const { Delivery } = require("../models");
const auth = require("../middleware/auth");
const idempotency = require("../middleware/idempotency");
const requireVerified = require("../middleware/requireVerified");
const validate = require("../middleware/validate");
const { createReplays } = require("../services/replay");

const router = new Router();
router.use(auth);

const params = z.object({ id: z.string().min(1).max(30) });

router.get("/deliveries/:id", validate({ params }), async (ctx) => {
  const delivery = await Delivery.getOwned(
    ctx.state.workspace.id,
    ctx.state.params.id,
  );
  ctx.body = {
    ...delivery.present(),
    eventId: delivery.event.publicId,
    attempts: delivery.attempts.map((attempt) => attempt.present()),
  };
});

router.post(
  "/deliveries/:id/replay",
  requireVerified,
  validate({ params }),
  idempotency,
  async (ctx) => {
    const workspaceId = ctx.state.workspace.id;
    const original = await Delivery.getOwned(workspaceId, ctx.state.params.id);
    const [delivery] = await createReplays(workspaceId, [
      {
        eventId: original.eventId,
        destinationId: original.destinationId,
        replayOfId: original.id,
      },
    ]);
    ctx.status = 202;
    ctx.body = { delivery };
  },
);

module.exports = router;
